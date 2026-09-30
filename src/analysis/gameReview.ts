import { Chess } from 'chess.js';
import type { GameAnalysisMoveResult as Result, StockfishEvaluationResult as Evaluation } from '../App';
import { evaluateMaiaPosition } from '../maiaEngine';
import { expectedScore, isMateScore, moveLoss, outcomeIndex, quality } from './reportModel';
import { ANALYSIS_CONFIG as config, candidateLoss, difficultyFromMass, profileLevels, screenDecision, type CandidateEvaluation } from './decisionMetrics';
import { lookupOpening, lookupTablebase } from './knowledge';
import { classifyRatingSignal, type MaiaRatingSample } from './performanceModel';
import { linkOpportunities } from './humanEvidence';

type Node = { id: string; fen: string; moveUci: string | null; moveSan: string | null };
type Side = 'white' | 'black';
type Phase = 'book' | 'maia' | 'best' | 'played' | 'refine' | 'alternatives' | 'profile';
export type ReviewQuery = (input: { fen: string; depth: number; perspectiveSide: Side; multipv?: number;
  movetimeMs?: number; engineChoice: 'stockfish'; positionCommand: string }) => Promise<Evaluation>;
type Options = {
  path: Node[]; bookResults: Result[]; deep: boolean; depth: number; benchmark: number;
  ratings?: { white?: number; black?: number } | null; ratingSystem?: string; ratingPool?: string;
  ratingSource?: 'pgn' | 'manual';
  explorerToken?: string;
  query: ReviewQuery; cancelled: () => boolean; signal: AbortSignal;
  releaseStockfish?: () => Promise<void>;
  prepareAlternatives?: () => Promise<void>;
  publish: (results: Result[]) => void;
  progress: (value: { done: number; total: number; moveText: string; phase: Phase; liveScoreText: string | null }, nodeId: string) => void;
};
const cache = new Map<string, Evaluation>();
const clampRating = (rating: number) => Math.max(1100, Math.min(3000, rating));
const entropy = (policy: { probability: number }[]) => -policy.reduce((sum, p) => sum + (p.probability > 0 ? p.probability * Math.log2(p.probability) : 0), 0);
const asCandidate = (e: Evaluation): CandidateEvaluation => ({ uci: e.bestMove ?? '', scoreText: e.scoreText, evalCp: e.evalCp, depth: e.depth, wdl: e.wdl });
const terminal = (chess: Chess): Evaluation | null => chess.isCheckmate()
  ? { scoreText: '#0', evalCp: 100000, wdl: [1000,0,0], bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: true }
  : chess.isDraw() ? { scoreText: '+0.00', evalCp: 0, wdl: [0,1000,0], bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: true } : null;
const loss = (a: Evaluation, b: Evaluation) => !a.hasScore || !b.hasScore ? null
  : moveLoss(a.scoreText, a.evalCp, b.scoreText, b.evalCp, a.wdl, b.wdl);
const contradicts = (a: Evaluation, b: Evaluation) => {
  if (!a.hasScore || !b.hasScore) return false;
  const ea = expectedScore(a.wdl), eb = expectedScore(b.wdl);
  const va = ea !== null && eb !== null ? ea : outcomeIndex(a.scoreText, a.evalCp);
  const vb = ea !== null && eb !== null ? eb : outcomeIndex(b.scoreText, b.evalCp);
  return va !== null && vb !== null && vb > va + 1;
};

/** Screen the line, compare human choices, then verify likely alternatives in a separate engine pass. */
export async function runGameReview(options: Options): Promise<Result[]> {
  const { query, deep, depth, cancelled, signal } = options;
  const path = options.path.map(node => node.fen === 'start' ? { ...node, fen: new Chess().fen() } : node);
  const bookMetadata = new Map(options.bookResults.map(r => [r.nodeId, r]));
  const results = deep ? [] as Result[] : [...options.bookResults];
  const books = new Set(results.map(r => r.nodeId));
  const root = path[0].fen;
  const histories: string[][] = [[]];
  for (const node of path.slice(1)) histories.push([...histories.at(-1)!, ...(node.moveUci ? [node.moveUci] : [])]);
  const positions = new Map<string, { index: number; best: Evaluation; played: Evaluation }>();
  let done = results.length, total = path.length - 1;
  let refinements = 0, maiaQueries = 0, maiaFailures = 0;
  const publish = () => options.publish(path.slice(1).flatMap(n => results.find(r => r.nodeId === n.id) ?? []));
  const progress = (index: number, phase: Phase, score: string | null = null) => {
    const before = path[index - 1], node = path[index];
    options.progress({ done, total, moveText: `${before.fen.split(' ')[5]}${before.fen.split(' ')[1] === 'b' ? '…' : '.'} ${node.moveSan ?? ''}`, phase, liveScoreText: score },
      phase === 'profile' || phase === 'maia' || phase === 'alternatives' ? node.id : before.id);
  };
  const evaluate = async (index: number, side: Side, ms: number, multipv = 3, extra?: string) => {
    const chess = new Chess(root), moves = [...histories[index], ...(extra ? [extra] : [])];
    for (const uci of moves) chess.move(uci);
    const fen = chess.fen(), positionCommand = `position fen ${root}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
    const key = `${positionCommand}|${side}|${depth}|${ms}|${multipv}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const value = await query({ fen, depth, perspectiveSide: side, multipv, movetimeMs: ms, engineChoice: 'stockfish', positionCommand });
    if (value.hasScore && !cancelled()) {
      cache.set(key, value);
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
    }
    return value;
  };
  // First pass: no neural calls before the objective importance of all moves is known.
  for (let i = 1; i < path.length && !cancelled(); i++) {
    const node = path[i], before = path[i-1];
    if (!node.moveUci || books.has(node.id)) continue;
    const beforeChess = new Chess(before.fen), mover: Side = beforeChess.turn() === 'w' ? 'white' : 'black';
    const after = new Chess(root); for (const uci of histories[i]) after.move(uci);
    const ending = terminal(after);
    const ms = deep ? config.deepScreenMs : config.quickScreenMs;
    progress(i, 'best');
    const multiPv = deep ? config.deepMultiPv : 3;
    let best = await evaluate(i-1, mover, ms, multiPv);
    if (cancelled()) break;
    progress(i, 'played', best.hasScore ? best.scoreText : null);
    let played = ending ?? await evaluate(i, mover, ms, multiPv);
    if (cancelled()) break;
    const initialLoss = loss(best, played);
    const refine = initialLoss === null || initialLoss >= config.meaningfulLoss || contradicts(best, played)
      || [2,5,10,20].some(n => initialLoss !== null && Math.abs(initialLoss-n) < 0.6);
    let refined = false;
    let comparisonLoss = initialLoss;
    if (refine && refinements < (deep ? config.maxDeepPositions : 12)) {
      refinements++; refined = true; progress(i, 'refine', played.hasScore ? played.scoreText : null);
      best = await evaluate(i-1, mover, deep ? config.deepRefineMs : config.quickRefineMs, multiPv);
      if (cancelled()) break;
      played = ending ?? await evaluate(i, mover, deep ? config.deepRefineMs : config.quickRefineMs, multiPv);
      const refinedLoss = loss(best, played);
      if (deep && !cancelled() && quality(initialLoss) !== quality(refinedLoss)) {
        comparisonLoss = refinedLoss;
        best = await evaluate(i - 1, mover, Math.round(config.deepRefineMs * 1.5), multiPv);
        if (cancelled()) break;
        played = ending ?? await evaluate(i, mover, Math.round(config.deepRefineMs * 1.5), multiPv);
      }
    }
    if (cancelled()) break;
    const impact = loss(best, played);
    const status = !best.hasScore || !played.hasScore ? 'unavailable'
      : contradicts(best, played) || impact === null || (refine && !refined) || (refined && quality(comparisonLoss) !== quality(impact)) ? 'uncertain' : 'complete';
    const metrics = screenDecision({ fen: before.fen, playedUci: node.moveUci, previousSan: before.moveSan, previousUci: before.moveUci,
      best: asCandidate(best), played: asCandidate(played), candidates: best.candidates ?? [], lossPoints: impact });
    const anchor = options.ratings?.[mover] ?? options.benchmark;
    const opponent = options.ratings?.[mover === 'white' ? 'black' : 'white'] ?? options.benchmark;
    const savePv = impact !== null && impact >= 5 || ending !== null || isMateScore(played.scoreText);
    const result: Result = { nodeId: node.id, mover, moveNumber: +before.fen.split(' ')[5], moveSan: node.moveSan ?? node.moveUci,
      beforeFen: before.fen, playedMoveUci: node.moveUci,
      bestMoveUci: best.bestMove, bestScoreText: best.hasScore ? best.scoreText : null, playedScoreText: played.hasScore ? played.scoreText : null,
      bestScoreCp: best.hasScore && !isMateScore(best.scoreText) ? best.evalCp : null,
      playedScoreCp: played.hasScore && !isMateScore(played.scoreText) ? played.evalCp : null,
      bestWdl: best.wdl, playedWdl: played.wdl, bestPv: savePv ? best.pv : '', playedPv: savePv ? played.pv : '',
      terminalOutcome: ending ? after.isCheckmate() ? 'checkmate' : 'draw' : null,
      depth: ending ? best.depth : Math.min(best.depth, played.depth), nodes: best.nodes + played.nodes,
      lossPoints: impact, status, category: quality(impact), ...metrics,
      bookRepertoireName: bookMetadata.get(node.id)?.bookRepertoireName,
      uncertaintyReason: status === 'uncertain' ? 'Evaluation changed category, contradicted the best line, or could not be confirmed within the search budget.' : undefined,
      maiaStatus: 'skipped', maiaUnavailableReason: 'Reserved for important decisions after Stockfish screening.',
      maiaElo: clampRating(anchor), maiaAnchorElo: anchor, maiaOpponentElo: clampRating(opponent),
      maiaRatingSource: options.ratings?.[mover] !== undefined ? options.ratingSource ?? 'pgn' : 'benchmark', profileOpponentElo: clampRating(opponent),
      checkedOpponent: after.isCheck(), answeredCheck: beforeChess.isCheck(), ratingSystem: options.ratingSystem, ratingPool: options.ratingPool,
      attackEvidence: status === 'complete' && isMateScore(played.scoreText) && outcomeIndex(played.scoreText, null) === 100 && !ending
        ? 'Stockfish confirms a forced mating continuation against best defense.' : undefined };
    // A repertoire match is context, never proof that a move is sound.
    if (bookMetadata.has(node.id) && impact !== null && impact < config.goodLoss) {
      result.decisionWeight = (result.decisionWeight ?? 0) * 0.4;
      result.maiaPriority = (result.maiaPriority ?? 0) * 0.4;
    }
    results.push(result); positions.set(node.id, { index: i, best, played }); done++; publish();
  }
  if (cancelled()) return results;

  // Optional external evidence has a shared wall-time budget and never blocks offline review.
  const knowledgeController = new AbortController();
  const abortKnowledge = () => knowledgeController.abort();
  signal.addEventListener('abort', abortKnowledge, { once: true });
  const knowledgeTimer = setTimeout(abortKnowledge, deep ? 8000 : 3500);
  try {
    let openingQueries = 0, tablebaseQueries = 0;
    for (const result of results) {
      if (cancelled() || knowledgeController.signal.aborted) break;
      const i = path.findIndex(n => n.id === result.nodeId), node = path[i];
      if (i < 1 || !node.moveUci) continue;
      if (i <= 24 && openingQueries < config.maxOpeningQueries && result.status !== 'book') {
        progress(i, 'book'); openingQueries++;
        const evidence = await lookupOpening(path[i-1].fen, node.moveUci, knowledgeController.signal, options.explorerToken);
        if (evidence && evidence.totalGames >= 20) {
          result.openingEvidence = evidence;
          if ((evidence.frequency ?? 0) >= 0.2 && (result.lossPoints ?? 100) < config.goodLoss && !bookMetadata.has(result.nodeId)) {
            result.decisionWeight = (result.decisionWeight ?? 0) * 0.4; result.maiaPriority = (result.maiaPriority ?? 0) * 0.4;
          }
        }
      }
      if (deep && result.status !== 'book' && (node.fen.split(' ')[0].match(/[a-z]/gi)?.length ?? 32) <= 7 && tablebaseQueries < config.maxTablebaseQueries) {
        tablebaseQueries++;
        const evidence = await lookupTablebase(path[i-1].fen, knowledgeController.signal);
        if (evidence) {
          result.tablebaseEvidence = evidence;
          const played = evidence.bestMoves.find(m => m.uci === node.moveUci);
          const value = (category: string) => category === 'win' ? 100 : category === 'loss' ? 0 : 50;
          if (played) {
            const beforeValue = value(evidence.category), afterValue = 100 - value(played.category);
            const exactLoss = Math.max(0, beforeValue - afterValue);
            const proof = (v: number): [number,number,number] => v === 100 ? [1000,0,0] : v === 0 ? [0,0,1000] : [0,1000,0];
            result.bestWdl = proof(beforeValue); result.playedWdl = proof(afterValue);
            result.lossPoints = exactLoss; result.category = quality(exactLoss); result.status = 'complete'; result.uncertaintyReason = undefined;
          }
        }
      }
      publish();
    }
  } catch { /* Abort/timeout: retain engine review and any already received evidence. */ }
  finally { clearTimeout(knowledgeTimer); signal.removeEventListener('abort', abortKnowledge); }
  if (cancelled()) return results;

  const eligible = results.filter(r => r.status === 'complete' && !r.tablebaseEvidence && !r.forced &&
    !r.obvious && !r.stableWin && !r.terminalOutcome &&
    (r.decisionWeight ?? 0) >= (deep ? 0.12 : config.minDecisionWeightForMaia));
  for (const result of eligible) result.maiaEligible = true;
  const pools = (['white', 'black'] as const).map(side => eligible.filter(r => r.mover === side)
    .sort((a, b) => (b.maiaPriority ?? 0) - (a.maiaPriority ?? 0)).slice(0, deep ? undefined : 3));
  // Balance both players even when a slow device reaches its time budget.
  const selected = Array.from({ length: Math.max(...pools.map(p => p.length)) }, (_, i) => pools.flatMap(p => p[i] ? [p[i]] : [])).flat();
  const levelsFor = (r: Result) => deep ? profileLevels(clampRating(r.maiaAnchorElo!)) : [r.maiaElo!];
  total = done + selected.reduce((sum, r) => sum + levelsFor(r).length, 0) + (deep ? selected.length : 0);
  if (selected.length) {
    await options.releaseStockfish?.();
    if (cancelled()) return results;
  }
  type Policy = Awaited<ReturnType<typeof evaluateMaiaPosition>>;
  type Context = { index: number; side: Side; best: Evaluation; assessed: Map<string, number>; policies: Policy[]; owner: Result };
  const policies = new Map<string, Policy>();
  const analyses = new Map<string, { policy: Policy; samples: { rating: number; policy: Policy }[]; context: Context; response?: { policy: Policy; context: Context } }>();
  let maiaStarted: number | null = null, lastMaiaError: string | null = null;
  const maiaBudgetMs = deep ? config.deepMaiaBudgetMs : 15000;
  const maxQueries = deep ? config.maxTotalPositionEvaluations : 6;
  const budgetExpired = () => maiaQueries >= maxQueries || (maiaStarted !== null && performance.now() - maiaStarted >= maiaBudgetMs);
  const maia = async (fen: string, self: number, opponent: number) => {
    const key = `${fen}|${clampRating(self)}|${clampRating(opponent)}`;
    const hit = policies.get(key); if (hit) return hit;
    if (cancelled() || budgetExpired() || maiaFailures >= 2) return null;
    maiaQueries++;
    try {
      const value = await evaluateMaiaPosition({ fen, eloSelf: clampRating(self), eloOppo: clampRating(opponent), topK: 256 },
        { timeoutMs: 10000, initializationTimeoutMs: 120000 });
      maiaStarted ??= performance.now(); maiaFailures = 0; policies.set(key, value); return value;
    } catch (error) {
      maiaStarted ??= performance.now(); maiaFailures++;
      lastMaiaError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const reverse = (evaluation: Evaluation): Evaluation => ({ ...evaluation, evalCp: -evaluation.evalCp,
    scoreText: isMateScore(evaluation.scoreText)
      ? evaluation.scoreText.startsWith('#-') ? evaluation.scoreText.replace('#-', '#') : evaluation.scoreText.replace('#', '#-')
      : `${evaluation.evalCp <= 0 ? '+' : '-'}${(Math.abs(evaluation.evalCp) / 100).toFixed(2)}`,
    wdl: evaluation.wdl ? [evaluation.wdl[2], evaluation.wdl[1], evaluation.wdl[0]] : undefined });
  const makeContext = (index: number, side: Side, best: Evaluation, owner: Result, samples: Policy[]) => {
    const assessed = new Map<string, number>();
    if (best.hasScore && best.bestMove) assessed.set(best.bestMove, 0);
    for (const candidate of best.candidates ?? []) {
      if (candidate.depth !== best.depth) continue;
      const value = candidateLoss(asCandidate(best), candidate);
      if (value !== null) assessed.set(candidate.uci, value);
    }
    return { index, side, best, assessed, policies: samples, owner };
  };
  const mass = (policy: Policy, context: Context) => {
    const lower = policy.moves.reduce((sum, m) => sum + ((context.assessed.get(m.uci) ?? Infinity) < config.goodLoss ? m.probability : 0), 0);
    const covered = policy.moves.reduce((sum, m) => sum + (context.assessed.has(m.uci) ? m.probability : 0), 0);
    return { lower, upper: Math.min(1, lower + Math.max(0, 1 - covered)) };
  };
  const complete = (policy: Policy, index: number) => policy.moves.length === new Chess(path[index].fen).moves().length &&
    Math.abs(policy.moves.reduce((sum, m) => sum + m.probability, 0) - 1) < 0.001;
  const enrich = (result: Result) => {
    const data = analyses.get(result.nodeId); if (!data) return;
    const { policy, context, samples } = data, uci = path[context.index + 1].moveUci!;
    const playedRank = policy.moves.findIndex(m => m.uci === uci);
    const playedProbability = playedRank < 0 ? null : policy.moves[playedRank].probability;
    Object.assign(result, { maiaStatus: 'complete', maiaUnavailableReason: undefined, maiaElo: samples[0].rating,
      maiaPlayedProbability: playedProbability, maiaPlayedRank: playedRank < 0 ? null : playedRank + 1,
      maiaTopMoveUci: policy.moves[0]?.uci, maiaTopMoveProbability: policy.moves[0]?.probability,
      maiaWinProbability: policy.winProbability, bestMoveMaiaProbability: policy.moves.find(m => m.uci === result.bestMoveUci)?.probability,
      humanAlternatives: policy.moves.slice(0, 6).map(m => ({ ...m, lossPoints: context.assessed.get(m.uci) ?? null })) });
    result.profileProbabilities = samples.flatMap(sample => {
      const move = sample.policy.moves.find(m => m.uci === uci);
      if (!move) return [];
      const bounds = complete(sample.policy, context.index) ? mass(sample.policy, context) : null;
      return [{ rating: sample.rating, probability: move.probability, goodMassLower: bounds?.lower, goodMassUpper: bounds?.upper } satisfies MaiaRatingSample];
    }).sort((a, b) => a.rating - b.rating);
    const signal = classifyRatingSignal(result.profileProbabilities, result.maiaAnchorElo!);
    result.ratingSignal = signal.direction === 'upward' && (result.lossPoints ?? 100) < 2 ? 'above'
      : signal.direction === 'downward' && (result.lossPoints ?? 0) >= 5 ? 'below'
      : signal.direction === 'non-monotonic' || signal.direction === 'upward' || signal.direction === 'downward' ? 'style' : 'neutral';
    if (result.ratingSignal === 'above') result.bestPv = positions.get(result.nodeId)!.best.pv;
    if (complete(policy, context.index)) {
      const bounds = mass(policy, context);
      result.goodMassLower = bounds.lower; result.goodMassUpper = bounds.upper;
      result.difficultyScore = difficultyFromMass(bounds.lower, bounds.upper, Boolean(result.obvious));
      const tempting = policy.moves.some(m => m.probability >= 0.1 && (context.assessed.get(m.uci) ?? 0) >= 5);
      result.greatFind = result.maiaElo === clampRating(result.maiaAnchorElo!) && result.status === 'complete' && !result.obvious && (result.lossPoints ?? 100) < 2 && bounds.upper <= 0.15 && tempting;
      result.maiaBaselineTag = result.greatFind ? 'above' : (result.lossPoints ?? 0) >= 5 && bounds.lower >= 0.7 ? 'below' : null;
      if (result.greatFind) {
        const evaluated = positions.get(result.nodeId)!;
        result.bestPv = evaluated.best.pv; result.playedPv = evaluated.played.pv;
      }
    }
    if (data.response && complete(data.response.policy, data.response.context.index)) {
      const bounds = mass(data.response.policy, data.response.context);
      result.practicalGoodMassLower = bounds.lower; result.practicalGoodMassUpper = bounds.upper;
      result.practicalPressureScore = 1 - bounds.upper;
      result.responseEntropy = entropy(data.response.policy.moves);
    }
  };
  // Every selected decision gets the actual player's level, then a broad grid with the opponent's level fixed.
  for (const result of selected) {
    if (cancelled()) break;
    const { index: i, best } = positions.get(result.nodeId)!;
    const levels = levelsFor(result), anchor = clampRating(result.maiaAnchorElo!);
    const ordered = [anchor, ...levels.filter(rating => rating !== anchor)];
    const samples: { rating: number; policy: Policy }[] = [];
    for (const rating of ordered) {
      if (cancelled()) break;
      progress(i, deep ? 'profile' : 'maia');
      const policy = await maia(path[i - 1].fen, rating, result.maiaOpponentElo!);
      if (policy) samples.push({ rating, policy });
      done++;
      if (samples.length) {
        const context = makeContext(i - 1, result.mover, best, result, samples.map(s => s.policy));
        if (result.lossPoints !== null) context.assessed.set(path[i].moveUci!, result.lossPoints);
        analyses.set(result.nodeId, { policy: samples[0].policy, samples, context }); enrich(result); publish();
      }
    }
    if (!samples.length && !cancelled()) {
      result.maiaStatus = budgetExpired() ? 'skipped' : 'unavailable';
      result.maiaUnavailableReason = budgetExpired() ? 'Maia review budget exhausted; remaining decisions were not assessed.'
        : lastMaiaError ?? 'Maia did not return a usable result.';
      publish();
    }
  }
  if (cancelled()) return results;
  // Reuse the next player's policy when available. Otherwise sample replies separately at that opponent's rating.
  if (deep) for (const result of selected) {
    if (cancelled()) break;
    const data = analyses.get(result.nodeId);
    const evaluated = positions.get(result.nodeId)!;
    const i = evaluated.index;
    progress(i, 'maia');
    const next = analyses.get(path[i + 1]?.id);
    const responses = data ? await maia(path[i].fen, result.maiaOpponentElo!, clampRating(result.maiaAnchorElo!)) : null;
    if (data && responses) {
      const responseSide = result.mover === 'white' ? 'black' : 'white';
      const best = reverse(evaluated.played);
      best.candidates = evaluated.played.candidates?.map(c => ({ ...c, ...reverse({ ...evaluated.played, ...c, hasScore: true }) }));
      const context = next?.policy === responses ? next.context : makeContext(i, responseSide, best, result, [responses]);
      data.response = { policy: responses, context }; enrich(result);
    }
    done++; publish();
  }
  if (cancelled()) return results;
  // Verify unassessed, plausible human alternatives only after releasing Maia's WASM memory.
  if (deep && analyses.size) {
    const contexts = [...new Set([...analyses.values()].flatMap(data => [data.context, ...(data.response ? [data.response.context] : [])]))];
    const queues = contexts.map(context => {
      const probability = new Map<string, number>();
      for (const policy of context.policies) for (const move of policy.moves)
        probability.set(move.uci, Math.max(probability.get(move.uci) ?? 0, move.probability));
      const candidates = [...probability].filter(([uci, p]) => !context.assessed.has(uci) && p >= 0.02).sort((a, b) => b[1] - a[1]);
      return { context, candidates: candidates.slice(0, config.maxAlternativesPerMove) };
    });
    const tasks = Array.from({ length: config.maxAlternativesPerMove }, (_, i) => queues.flatMap(queue => queue.candidates[i]
      ? [{ context: queue.context, uci: queue.candidates[i][0] }] : [])).flat().slice(0, config.maxAlternativeQueries);
    if (tasks.length) {
      await options.prepareAlternatives?.();
      if (cancelled()) return results;
      total = done + tasks.length;
      for (const { context, uci } of tasks) {
        if (cancelled()) break;
        const coverage = context.policies.every(policy => policy.moves.reduce((sum, m) => sum + (context.assessed.has(m.uci) ? m.probability : 0), 0) >= config.targetPolicyCoverage);
        if (!coverage) {
          progress(positions.get(context.owner.nodeId)!.index, 'alternatives');
          const candidate = await evaluate(context.index, context.side, config.deepAlternativeMs, 1, uci);
          if (cancelled()) break;
          if (candidate.hasScore && !contradicts(context.best, candidate)) {
            const value = loss(context.best, candidate);
            if (value !== null) context.assessed.set(uci, value);
          }
        }
        done++;
        for (const result of selected) enrich(result);
        publish();
      }
    }
  }
  const ordered = path.slice(1).flatMap(node => results.find(result => result.nodeId === node.id) ?? []);
  linkOpportunities(ordered);
  publish(); return ordered;
}
