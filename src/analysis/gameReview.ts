import { Chess } from 'chess.js';
import type { GameAnalysisMoveResult as Result, StockfishEvaluationResult as Evaluation } from '../App';
import { evaluateMaiaPosition } from '../maiaEngine';
import { expectedScore, isMateScore, moveLoss, outcomeIndex, quality } from './reportModel';
import { ANALYSIS_CONFIG as config, candidateLoss, difficultyFromMass, profileLevels, screenDecision, type CandidateEvaluation } from './decisionMetrics';
import { lookupOpening, lookupTablebase } from './knowledge';

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

/** Bounded passes: screen the complete main line, select decisions, then enrich. */
export async function runGameReview(options: Options): Promise<Result[]> {
  const { query, deep, depth, cancelled, signal } = options;
  const path = options.path.map(node => node.fen === 'start' ? { ...node, fen: new Chess().fen() } : node);
  const results = [...options.bookResults], books = new Set(results.map(r => r.nodeId));
  const root = path[0].fen;
  const histories: string[][] = [[]];
  for (const node of path.slice(1)) histories.push([...histories.at(-1)!, ...(node.moveUci ? [node.moveUci] : [])]);
  const positions = new Map<string, { index: number; best: Evaluation; played: Evaluation }>();
  let done = results.length, total = path.length - 1 + (deep ? config.maxCandidateMoves : 6);
  let refinements = 0, extraQueries = 0, maiaQueries = 0, maiaFailures = 0;
  const publish = () => options.publish(path.slice(1).flatMap(n => results.find(r => r.nodeId === n.id) ?? []));
  const progress = (index: number, phase: Phase, score: string | null = null) => {
    const before = path[index - 1], node = path[index];
    options.progress({ done, total, moveText: `${before.fen.split(' ')[5]}${before.fen.split(' ')[1] === 'b' ? '…' : '.'} ${node.moveSan ?? ''}`, phase, liveScoreText: score }, before.id);
  };
  const evaluate = async (index: number, side: Side, ms: number, multipv = 3, extra?: string) => {
    const chess = new Chess(root), moves = [...histories[index], ...(extra ? [extra] : [])];
    for (const uci of moves) chess.move(uci);
    const fen = chess.fen(), positionCommand = `position fen ${root}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
    const key = `${positionCommand}|${side}|${ms}|${multipv}`;
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
    let best = await evaluate(i-1, mover, ms);
    if (cancelled()) break;
    progress(i, 'played', best.hasScore ? best.scoreText : null);
    let played = ending ?? await evaluate(i, mover, ms, 3);
    if (cancelled()) break;
    const initialLoss = loss(best, played);
    const refine = initialLoss === null || initialLoss >= config.meaningfulLoss || contradicts(best, played)
      || [2,5,10,20].some(n => initialLoss !== null && Math.abs(initialLoss-n) < 0.6);
    let refined = false;
    if (refine && refinements < config.maxDeepPositions) {
      refinements++; refined = true; progress(i, 'refine', played.hasScore ? played.scoreText : null);
      best = await evaluate(i-1, mover, deep ? config.deepRefineMs : config.quickRefineMs);
      if (cancelled()) break;
      played = ending ?? await evaluate(i, mover, deep ? config.deepRefineMs : config.quickRefineMs);
    }
    if (cancelled()) break;
    const impact = loss(best, played);
    const status = !best.hasScore || !played.hasScore ? 'unavailable'
      : contradicts(best, played) || impact === null || (refine && !refined) || (refined && quality(initialLoss) !== quality(impact)) ? 'uncertain' : 'complete';
    const metrics = screenDecision({ fen: before.fen, playedUci: node.moveUci, previousSan: before.moveSan, previousUci: before.moveUci,
      best: asCandidate(best), played: asCandidate(played), candidates: best.candidates ?? [], lossPoints: impact });
    const anchor = options.ratings?.[mover] ?? options.benchmark;
    const opponent = options.ratings?.[mover === 'white' ? 'black' : 'white'] ?? anchor;
    const savePv = impact !== null && impact >= 5 || ending !== null || isMateScore(played.scoreText);
    const result: Result = { nodeId: node.id, mover, moveNumber: +before.fen.split(' ')[5], moveSan: node.moveSan ?? node.moveUci,
      bestMoveUci: best.bestMove, bestScoreText: best.hasScore ? best.scoreText : null, playedScoreText: played.hasScore ? played.scoreText : null,
      bestScoreCp: best.hasScore && !isMateScore(best.scoreText) ? best.evalCp : null,
      playedScoreCp: played.hasScore && !isMateScore(played.scoreText) ? played.evalCp : null,
      bestWdl: best.wdl, playedWdl: played.wdl, bestPv: savePv ? best.pv : '', playedPv: savePv ? played.pv : '',
      terminalOutcome: ending ? after.isCheckmate() ? 'checkmate' : 'draw' : null,
      depth: ending ? best.depth : Math.min(best.depth, played.depth), nodes: best.nodes + played.nodes,
      lossPoints: impact, status, category: quality(impact), ...metrics,
      uncertaintyReason: status === 'uncertain' ? 'Evaluation changed category, contradicted the best line, or could not be confirmed within the search budget.' : undefined,
      maiaStatus: 'skipped', maiaUnavailableReason: 'Reserved for important decisions after Stockfish screening.',
      maiaElo: clampRating(anchor), maiaAnchorElo: anchor, maiaOpponentElo: clampRating(opponent),
      maiaRatingSource: options.ratings?.[mover] !== undefined ? options.ratingSource ?? 'pgn' : 'benchmark', profileOpponentElo: clampRating(opponent),
      checkedOpponent: after.isCheck(), answeredCheck: beforeChess.isCheck(), ratingSystem: options.ratingSystem, ratingPool: options.ratingPool,
      attackEvidence: status === 'complete' && isMateScore(played.scoreText) && outcomeIndex(played.scoreText, null) === 100 && !ending
        ? 'Stockfish confirms a forced mating continuation against best defense.' : undefined };
    results.push(result); positions.set(node.id, { index: i, best, played }); done++; publish();
  }
  if (cancelled()) return results;

  // Release the large Stockfish worker before Maia initializes its ONNX/WASM model.
  await options.releaseStockfish?.();
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
          if ((evidence.frequency ?? 0) >= 0.2) { result.decisionWeight = (result.decisionWeight ?? 0) * 0.4; result.maiaPriority = (result.maiaPriority ?? 0) * 0.4; }
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

  const perSide = deep ? config.maxCandidateMoves / 2 : 3;
  const pools = (['white', 'black'] as const).map(side => results.filter(r => r.mover === side && r.status === 'complete'
    && !r.tablebaseEvidence
    && !r.obvious && !r.terminalOutcome && (r.decisionWeight ?? 0) >= config.minDecisionWeightForMaia)
    .sort((a,b) => (b.maiaPriority ?? 0) - (a.maiaPriority ?? 0)).slice(0, perSide));
  // Interleave sides so a device budget cannot consume every sample for one player.
  const selected = Array.from({length: Math.max(...pools.map(p => p.length))}, (_,i) => pools.flatMap(p => p[i] ? [p[i]] : [])).flat();
  total = done + selected.length;
  let maiaStarted: number | null = null;
  const maiaBudgetMs = deep ? 45000 : 15000, maxQueries = deep ? config.maxTotalPositionEvaluations : 6;
  const policies = new Map<string, Awaited<ReturnType<typeof evaluateMaiaPosition>>>();
  const maia = async (fen: string, self: number, opponent: number, uci?: string) => {
    const key = `${fen}|${self}|${opponent}|${uci ?? ''}`;
    const cached = policies.get(key); if (cached) return cached;
    if (cancelled() || maiaQueries >= maxQueries || maiaFailures >= 2 || (maiaStarted !== null && performance.now()-maiaStarted >= maiaBudgetMs)) return null;
    maiaQueries++;
    try {
      const value = await evaluateMaiaPosition({ fen, eloSelf: clampRating(self), eloOppo: clampRating(opponent), topK: 256, playedMoveUci: uci },
        { timeoutMs: 6000, initializationTimeoutMs: 60000 });
      maiaStarted ??= performance.now(); maiaFailures = 0; policies.set(key, value); return value;
    } catch { maiaStarted ??= performance.now(); maiaFailures++; return null; }
  };
  for (const result of selected) {
    if (cancelled()) break;
    const data = positions.get(result.nodeId)!; const { index: i, best, played } = data;
    const before = path[i-1], node = path[i], anchor = result.maiaAnchorElo!, opponent = result.maiaOpponentElo!;
    const levels = deep ? profileLevels(anchor) : [];
    progress(i, 'profile');
    const samples: { rating: number; probability: number }[] = [];
    // Sentinels first. Only differing profiles receive an additional middle sample.
    let policy: Awaited<ReturnType<typeof evaluateMaiaPosition>> | null = null;
    let low: Awaited<ReturnType<typeof evaluateMaiaPosition>> | null = null;
    let high: Awaited<ReturnType<typeof evaluateMaiaPosition>> | null = null;
    if (levels.length === 3) {
      low = await maia(before.fen, levels[0], opponent, node.moveUci!);
      if (cancelled()) break;
      high = await maia(before.fen, levels[2], opponent, node.moveUci!);
      for (const [rating, p] of [[levels[0], low], [levels[2], high]] as const) if (p?.playedMove) samples.push({rating, probability:p.playedMove.probability});
      const pLow = low?.playedMove?.probability, pHigh = high?.playedMove?.probability;
      const interesting = pLow !== undefined && pHigh !== undefined && (Math.abs(pHigh-pLow) >= config.minAbsoluteProbabilityDelta
        || Math.max(pHigh,pLow)/Math.max(0.0001, Math.min(pHigh,pLow)) >= config.minProbabilityRatio);
      if (interesting || (result.bestVsSecondGap ?? 0) >= 12 || (result.lossPoints ?? 0) >= 5) {
        const middle = await maia(before.fen, levels[1], opponent, node.moveUci!);
        if (middle?.playedMove) samples.push({rating:levels[1], probability:middle.playedMove.probability});
        policy = anchor === levels[0] ? low : anchor === levels[2] ? high : middle;
        if (samples.length === 3 && (result.maiaPriority ?? 0) > 0.55 && maiaQueries < maxQueries - (selected.length - selected.indexOf(result) - 1) * 2) {
          const refinement = clampRating(anchor + (pHigh! > pLow! ? config.maiaRefinementStep : -config.maiaRefinementStep));
          if (!samples.some(s => s.rating === refinement)) {
            const refined = await maia(before.fen, refinement, opponent, node.moveUci!);
            if (refined?.playedMove) samples.push({ rating: refinement, probability: refined.playedMove.probability });
          }
        }
      }
      // For invariant profiles keep the actual sampled level visible; no disguised anchor query.
      if (!policy) { policy = low ?? high; result.maiaElo = low ? levels[0] : levels[2]; }
    } else { policy = await maia(before.fen, result.maiaElo!, opponent, node.moveUci!); }
    if (cancelled()) break;
    if (!policy) {
      result.maiaStatus = maiaQueries >= maxQueries || (maiaStarted !== null && performance.now()-maiaStarted >= maiaBudgetMs) ? 'skipped' : 'unavailable';
      result.maiaUnavailableReason = result.maiaStatus === 'skipped' ? 'Maia review budget exhausted.' : 'Maia did not return a usable result.';
      done++; publish(); continue;
    }
    Object.assign(result, {maiaStatus:'complete', maiaUnavailableReason:undefined, maiaPlayedProbability:policy.playedMove?.probability ?? null,
      maiaPlayedRank:policy.playedMove?.rank ?? null, maiaTopMoveUci:policy.moves[0]?.uci, maiaTopMoveProbability:policy.moves[0]?.probability,
      maiaWinProbability:policy.winProbability, profileProbabilities:samples});
    const assessed = new Map<string,number>();
    for (const c of best.candidates ?? []) { const l = candidateLoss(asCandidate(best),c); if (l !== null) assessed.set(c.uci,l); }
    if (result.lossPoints !== null) assessed.set(node.moveUci!, result.lossPoints);
    const completePolicy = policy.moves.length === new Chess(before.fen).moves().length;
    if (deep && completePolicy) {
      for (const choice of policy.moves.filter(p => !assessed.has(p.uci)).slice(0,4)) {
        if (cancelled() || extraQueries >= config.maxAlternativeQueries) break;
        const covered = policy.moves.reduce((s,m) => s+(assessed.has(m.uci) ? m.probability : 0),0);
        if (covered >= 0.9) break;
        progress(i, 'alternatives'); extraQueries++;
        const chess = new Chess(root); for(const uci of [...histories[i-1],choice.uci]) chess.move(uci);
        const candidate = terminal(chess) ?? await evaluate(i-1,result.mover,config.deepScreenMs,1,choice.uci);
        if (contradicts(best,candidate)) {result.status='uncertain'; result.uncertaintyReason='A candidate scored better than the principal line.';}
        const l=loss(best,candidate); if(l!==null) assessed.set(choice.uci,l);
      }
    }
    if (completePolicy) {
      const known = policy.moves.reduce((s,m)=>s+(assessed.has(m.uci)?m.probability:0),0);
      result.goodMassLower=policy.moves.reduce((s,m)=>s+((assessed.get(m.uci)??Infinity)<config.goodLoss?m.probability:0),0);
      result.goodMassUpper=Math.min(1,result.goodMassLower+Math.max(0,1-known));
      result.difficultyScore=difficultyFromMass(result.goodMassLower,result.goodMassUpper,Boolean(result.obvious));
      const tempting = policy.moves.some(m=>m.probability>=0.1 && (assessed.get(m.uci)??0)>=5);
      result.greatFind=result.maiaElo===clampRating(anchor) && result.status==='complete' && !result.obvious && (result.lossPoints??100)<2 && result.goodMassUpper<=0.15 && tempting;
      result.maiaBaselineTag=result.greatFind?'above':(result.lossPoints??0)>=5 && result.goodMassLower>=0.7?'below':null;
      if(result.greatFind) {result.bestPv=best.pv; result.playedPv=played.pv;}
    }
    // The opponent's probability mass of sound replies bounds refutation accessibility.
    if (deep && !cancelled() && (result.lossPoints??0)>=5 && maiaQueries<maxQueries) {
      progress(i,'maia');
      const responses=await maia(node.fen,opponent,clampRating(anchor));
      if(responses && responses.moves.length===new Chess(node.fen).moves().length) {
        const responseLosses=new Map<string,number>();
        for(const c of played.candidates??[]) {
          // Candidate evaluations here are from the original mover's perspective; opponent minimizes.
          const ca=asCandidate(played);
          const l=moveLoss(c.scoreText,c.evalCp,ca.scoreText,ca.evalCp,c.wdl,ca.wdl);
          if(l!==null) responseLosses.set(c.uci,l);
        }
        const covered=responses.moves.reduce((s,m)=>s+(responseLosses.has(m.uci)?m.probability:0),0);
        const lower=responses.moves.reduce((s,m)=>s+((responseLosses.get(m.uci)??Infinity)<2?m.probability:0),0);
        result.practicalGoodMassLower=lower; result.practicalGoodMassUpper=Math.min(1,lower+1-covered);
        result.practicalPressureScore=1-result.practicalGoodMassUpper; result.responseEntropy=entropy(responses.moves);
        // Weighted expected score of known human replies, completed conservatively by best defense.
        const base=expectedScore(played.wdl);
        if(base!==null) {
          const weighted=responses.moves.reduce((s,m)=> {
            const c=played.candidates?.find(c=>c.uci===m.uci); return s+m.probability*(expectedScore(c?.wdl)??base);
          },0);
          result.practicalQualityScore=weighted;
        }
      }
    }
    done++; publish();
  }
  // Distinguish giving a chance from the opponent actually taking it.
  for(let i=0;i<results.length;i++) {
    const r=results[i], index=path.findIndex(n=>n.id===r.nodeId);
    const reply=results.find(n=>n.nodeId===path[index+1]?.id);
    if(r.status==='complete' && (r.lossPoints??0)>=5 && reply?.status==='complete' && reply.lossPoints!==null)
      r.opponentMissedPunishment=reply.lossPoints>=Math.max(5,(r.lossPoints??0)*0.5);
  }
  publish(); return results;
}
