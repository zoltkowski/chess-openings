import { Chess } from 'chess.js';
import { compareMaiaLevels } from './performanceModel';
import { linkOpportunities, type HumanReviewDetails } from './humanEvidence';

export type ReportMove = HumanReviewDetails & {
  nodeId: string; moveNumber: number; moveSan: string; mover: 'white' | 'black';
  bestScoreCp: number | null; playedScoreCp: number | null;
  bestScoreText: string | null; playedScoreText: string | null;
  bestPv?: string;
  bestWdl?: [number, number, number] | null; playedWdl?: [number, number, number] | null;
  lossPoints: number | null; status: string; category: string;
  terminalOutcome: 'checkmate' | 'draw' | null;
  profileOpponentElo?: number;
  goodMassUpper?: number; goodMassLower?: number;
  obvious?: boolean; greatFind?: boolean;
  stableWin?: boolean;
  attackEvidence?: string;
  checkedOpponent?: boolean;
  answeredCheck?: boolean;
  maiaStatus?: string;
  maiaPlayedProbability?: number | null;
  maiaElo?: number;
  maiaAnchorElo?: number;
  maiaRatingSource?: 'pgn' | 'manual' | 'benchmark';
  decisionWeight?: number;
  significanceScore?: number;
  difficultyScore?: number;
  bestVsSecondGap?: number | null;
  goodMoveCount?: number;
  candidateCount?: number;
  legalMoveCount?: number;
  winChanceLoss?: number | null;
  drawChanceLoss?: number | null;
  lossChanceIncrease?: number | null;
  practicalGoodMassLower?: number;
  practicalGoodMassUpper?: number;
  opponentMissedPunishment?: boolean;
  openingEvidence?: { name?: string; totalGames?: number; playedGames?: number; frequency?: number };
  tablebaseEvidence?: { category: string };
  ratingSystem?: string;
  ratingPool?: string;
};

export const scoreIndex = (cp: number) => 100 / (1 + Math.exp(-0.00368208 * cp));
export const isMateScore = (text: string | null | undefined) => Boolean(text && /^(?:#-?\d+|[+-]?M\d+)$/.test(text));

/** Expected score for White on a bounded 0–100 scale. */
export function expectedScore(wdl: [number, number, number] | null | undefined): number | null {
  if (!wdl || wdl.some(value => !Number.isFinite(value) || value < 0)) return null;
  const total = wdl[0] + wdl[1] + wdl[2];
  return total > 0 ? ((wdl[0] + wdl[1] / 2) / total) * 100 : null;
}

/** Prefer Stockfish WDL expected score; fall back to the cp comparison index. */
export function whiteAdvantage(cp: number | null, wdl?: [number, number, number] | null): number | null {
  const expected = expectedScore(wdl);
  return expected !== null ? expected - 50 : cp !== null && Number.isFinite(cp) ? scoreIndex(cp) - 50 : null;
}

// Mate is a game outcome, never an arbitrary centipawn value.
export function outcomeIndex(text: string | null, cp: number | null): number | null {
  if (isMateScore(text)) return text!.startsWith('#-') || text!.startsWith('-M') ? 0 : 100;
  return cp !== null && Number.isFinite(cp) ? scoreIndex(cp) : null;
}

export function moveLoss(best: string | null, bestCp: number | null, played: string | null, playedCp: number | null,
  bestWdl?: [number, number, number] | null, playedWdl?: [number, number, number] | null) {
  const a = outcomeIndex(best, bestCp), b = outcomeIndex(played, playedCp);
  const bestExpected = expectedScore(bestWdl);
  const playedExpected = expectedScore(playedWdl);
  if (bestExpected !== null && playedExpected !== null) {
    return Math.max(0, bestExpected - playedExpected);
  }
  // A large numeric advantage after a forced mate may still be a safe win.
  // Without an outcome proof, do not convert the change of score type into ?.
  if (isMateScore(best) && a === 100 && !isMateScore(played) && playedCp !== null && playedCp >= 500) return null;
  return a === null || b === null ? null : Math.max(0, a - b);
}

export function quality(loss: number | null) {
  return loss === null ? 'unavailable' : loss <= 0.5 ? 'best' : loss < 2 ? 'excellent'
    : loss < 5 ? 'good' : loss < 10 ? 'inaccuracy' : loss < 20 ? 'mistake' : 'blunder';
}

export function obviousDecision(fen: string, uci: string, previousSan?: string | null, previousUci?: string | null) {
  const legal = new Chess(fen).moves({ verbose: true });
  if (legal.length <= 1) return true;
  const move = legal.find(m => `${m.from}${m.to}${m.promotion ?? ''}` === uci);
  if (!move) return true;
  // Conservative recapture filter, without excluding every capture or check.
  return Boolean(previousSan?.includes('x') && move.captured && move.to === previousUci?.slice(2, 4));
}

function phaseOf(fen?: string) {
  if (!fen) return 'Unclassified';
  try {
    const chess = new Chess(fen);
    const pieces = chess.board().flat().filter(p => p !== null);
    const weight = pieces.reduce((s, p) => s + ({ p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 }[p.type]), 0);
    if (weight <= 8) return 'Endgame';
    const home = ['b1', 'c1', 'f1', 'g1', 'b8', 'c8', 'f8', 'g8'] as const;
    const undeveloped = home.filter(square => {
      const p = chess.get(square);
      return p && (p.type === 'b' || p.type === 'n') && p.color === (square[1] === '1' ? 'w' : 'b');
    }).length;
    return undeveloped >= 4 && weight >= 20 ? 'Opening' : 'Middlegame';
  } catch { return 'Unclassified'; }
}

const average = (values: number[]) => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
const meaningfulDecision = (r: ReportMove) => r.status === 'complete' && r.lossPoints !== null &&
  Number.isFinite(r.lossPoints) && !r.obvious && !r.stableWin;
function decisionQuality(rows: ReportMove[]) {
  const weighted = rows.filter(meaningfulDecision).map(r => ({
    loss: r.lossPoints!, weight: Number.isFinite(r.decisionWeight) ? Math.max(0, Math.min(1, r.decisionWeight!)) : 1,
  }));
  const totalWeight = weighted.reduce((sum, r) => sum + r.weight, 0);
  return totalWeight ? 100 * weighted.reduce((sum, r) => sum + r.weight * Math.max(0, 1 - r.loss / 35), 0) / totalWeight : null;
}
export const moveLabel = (r: ReportMove) => `${r.moveNumber}${r.mover === 'white' ? '.' : '…'} ${r.moveSan}`;
const sideName = (s: string) => s === 'white' ? 'White' : 'Black';

function continuation(r: ReportMove) {
  if (!r.beforeFen || !r.bestPv) return '';
  try {
    const chess = new Chess(r.beforeFen), moves: string[] = [];
    for (const uci of r.bestPv.split(/\s+/).slice(0, 6)) {
      const move = chess.move(uci);
      if (!move) break;
      moves.push(move.san);
    }
    return moves.length ? ` Best continuation: ${moves.join(' ')}.` : '';
  } catch { return ''; }
}

function profile(rows: ReportMove[], side: 'white' | 'black') {
  const anchor = rows.find(r => r.maiaAnchorElo !== undefined)?.maiaAnchorElo ?? rows.find(r => r.maiaElo !== undefined)?.maiaElo ?? 1800;
  const anchorSource = rows.find(r => r.maiaRatingSource)?.maiaRatingSource ?? 'benchmark';
  const ratingSystem = rows.find(r => r.ratingSystem)?.ratingSystem;
  const ratingPool = rows.find(r => r.ratingPool)?.ratingPool;
  if (anchor < 1100 || anchor > 3000) return { rating: null, anchor, anchorSource, ratingSystem, ratingPool, signalCounts: { upward: 0, downward: 0, invariant: 0, style: 0 }, levels: [], atBoundary: false, count: 0,
    reason: `The ${anchorSource === 'manual' ? 'manual' : anchorSource === 'pgn' ? 'PGN' : 'benchmark'} rating ${anchor} is outside Maia's supported range (1100–3000); performance cannot be estimated without extrapolation.` };
  return { ...compareMaiaLevels(rows, side, anchor), anchor, anchorSource, ratingSystem, ratingPool };
}

export function buildReport(results: ReportMove[], positions: Record<string, string>) {
  results = results.map(result => ({ ...result }));
  linkOpportunities(results);
  let lastPhase = 0;
  const phaseNames = ['Opening', 'Middlegame', 'Endgame'];
  const points = results.map(r => {
    const detected = phaseOf(positions[r.nodeId]);
    if (detected !== 'Unclassified') lastPhase = Math.max(lastPhase, phaseNames.indexOf(detected));
    // Null mate values are intentional: render mate as a separate event, not cp.
    const hasWdl = expectedScore(r.playedWdl) !== null;
    const value = r.terminalOutcome === 'draw' ? 0 : whiteAdvantage(
      r.playedScoreCp === null ? null : r.playedScoreCp * (r.mover === 'white' ? 1 : -1),
      r.playedWdl ? (r.mover === 'white' ? r.playedWdl : [r.playedWdl[2], r.playedWdl[1], r.playedWdl[0]]) : null,
    );
    const mateSide = isMateScore(r.playedScoreText)
      ? outcomeIndex(r.playedScoreText, null) === 100 ? r.mover : r.mover === 'white' ? 'black' : 'white' : null;
    const outcome = mateSide ? `${sideName(mateSide)} ${r.terminalOutcome === 'checkmate' ? 'delivered checkmate' : 'has a forced mate'}` : undefined;
    return { nodeId: r.nodeId, label: moveLabel(r), value, source: value === null ? 'unavailable' : hasWdl ? 'WDL' : 'cp index', outcome, mateSide, phase: detected === 'Unclassified' ? detected : phaseNames[lastPhase] };
  });
  const valid = (r: ReportMove) => r.status === 'complete' && r.lossPoints !== null && Number.isFinite(r.lossPoints);
  const players = (['white', 'black'] as const).map(side => {
    const rows = results.filter(r => r.mover === side);
    const measured = rows.filter(valid);
    const find = measured.find(r => r.greatFind);
    const steady = measured.filter(r => !r.obvious && r.lossPoints! < 2);
    const worst = [...measured].sort((a,b) => b.lossPoints! - a.lossPoints!)[0];
    const qualityScore = decisionQuality(rows);
    const chances = measured.filter(r => r.opportunityAvailable !== undefined);
    const pressure = measured.flatMap(r => {
      const index = results.indexOf(r), previous = results[index - 1];
      return previous?.status === 'complete' && previous.mover !== side && previous.practicalGoodMassUpper !== undefined &&
        previous.practicalGoodMassUpper <= 0.3 ? [{ nodeId: r.nodeId, sourceNodeId: previous.nodeId, held: r.lossPoints! < 2 }] : [];
    });
    const strengths = find ? [{ nodeId: find.nodeId, text: `Found a difficult resource at ${moveLabel(find)}. Inspect the alternatives.` }]
      : steady.length >= 3 ? [{ nodeId: steady[0].nodeId, text: `${steady.length} non-forced decisions preserved the engine evaluation (impact below 2).` }] : [];
    const weaknesses = worst && worst.lossPoints! >= 5 ? [{ nodeId: worst.nodeId,
      text: `Revisit ${moveLabel(worst)} first: the largest missed improvement (${worst.lossPoints!.toFixed(1)} impact points).` }] : [];
    const missed = chances.find(r => r.opportunityMissed);
    if (missed && missed.nodeId !== worst?.nodeId) weaknesses.push({ nodeId: missed.nodeId, text: `At ${moveLabel(missed)}, the opponent offered a chance but much of the benefit was returned.${continuation(missed)}` });
    const pressureHeld = pressure.find(r => r.held);
    if (pressureHeld && strengths.length < 2) strengths.push({ nodeId: pressureHeld.nodeId, text: 'Handled a demanding reply accurately: Maia gives few sound responses even allowing for unassessed alternatives.' });
    return { side, count: measured.length, averageLoss: average(measured.map(r => r.lossPoints!)), qualityScore,
      strengths, weaknesses,
      sound: measured.filter(r => r.lossPoints! < 5).length,
      maiaCount: rows.filter(r => r.maiaStatus === 'complete').length,
      maiaEligible: rows.filter(r => r.maiaEligible).length,
      profileCount: rows.filter(r => (r.profileProbabilities?.length ?? 0) >= 3).length,
      opportunities: { available: chances.length, taken: chances.filter(r => r.opportunityTaken).length, missed: chances.filter(r => r.opportunityMissed).length,
        offered: rows.filter(r => r.opponentMissedPunishment !== undefined).length,
        escaped: rows.filter(r => r.opponentMissedPunishment).length },
      pressure: { faced: pressure.length, held: pressure.filter(r => r.held).length, positions: pressure },
      benchmark: rows.find(r => r.maiaAnchorElo !== undefined)?.maiaAnchorElo ?? rows.find(r => r.maiaElo !== undefined)?.maiaElo,
      errors: measured.filter(r => r.lossPoints! >= 10).length,
      missed: chances.filter(r => r.opportunityMissed).length,
      held: measured.filter(r => r.greatFind && (r.bestScoreCp ?? 0) < 50).length,
      profile: profile(rows, side) };
  });
  const phases = [...new Set(points.map(p => p.phase))].map(name => {
    const indexes = points.flatMap((p, i) => p.phase === name ? [i] : []);
    const rows = indexes.map(i => results[i]);
    const measured = indexes.map(i => points[i].value).filter((v): v is number => v !== null);
    const white = measured.filter(v => v > 8).length, black = measured.filter(v => v < -8).length;
    const advantage = !measured.length ? 'No position evaluations' : white > measured.length / 2 ? 'White led most evaluated positions'
      : black > measured.length / 2 ? 'Black led most evaluated positions' : 'Balanced or changing advantage';
    const forcing = (side: 'white' | 'black') => {
      const sideRows = rows.filter(r => r.mover === side);
      return { checks: sideRows.filter(r => r.checkedOpponent).length, replies: sideRows.filter(r => r.answeredCheck).length,
        mating: sideRows.filter(r => r.attackEvidence).length };
    };
    const w = forcing('white'), b = forcing('black');
    const activity = w.mating || b.mating ? `${w.mating ? 'White' : 'Black'} had a confirmed mating attack; open the marked moments.`
      : rows.some(r => r.checkedOpponent !== undefined)
        ? `Checks delivered: White ${w.checks}, Black ${b.checks}. Replies to check: White ${w.replies}, Black ${b.replies}. Checks show forcing play, not overall initiative.`
        : 'Attack and defense evidence is unavailable in this older report.';
    const edge = (v: number | null) => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} expected-score points`;
    const transition = `White’s expected score: ${edge(points[indexes[0]].value)} → ${edge(points[indexes.at(-1)!].value)}`;
    const phaseQuality = (playerSide: 'white' | 'black') => decisionQuality(rows.filter(r => r.mover === playerSide));
    const whiteLoss = average(rows.filter(r => r.mover === 'white' && valid(r)).map(r => r.lossPoints!));
    const blackLoss = average(rows.filter(r => r.mover === 'black' && valid(r)).map(r => r.lossPoints!));
    const whiteDecisionQuality = phaseQuality('white');
    const blackDecisionQuality = phaseQuality('black');
    const reviewed = rows.filter(meaningfulDecision).length;
    const confidence = reviewed >= 8 ? 'Moderate' : reviewed >= 3 ? 'Low' : 'Very low';
    return { name, start: points[indexes[0]].label, end: points[indexes.at(-1)!].label,
      activity, transition,
      decisionQuality: whiteDecisionQuality, blackDecisionQuality, confidence, qualityEvidence: reviewed,
      advantage: `${advantage} · ${measured.length}/${rows.length} positions evaluated`,
      whiteLoss,
      blackLoss };
  });
  type Moment = { nodeId: string; label: string; title: string; description: string; kind: 'mistake' | 'defense' | 'turning' | 'conversion'; priority: number; moveOrder: number };
  const candidates: Moment[] = [];
  results.forEach((r, i) => {
    if (!valid(r)) return;
    const who = sideName(r.mover), loss = r.lossPoints!;
    const before = r.bestScoreCp, after = r.playedScoreCp;
    const add = (title: string, description: string, kind: Moment['kind'], priority: number) =>
      candidates.push({ nodeId: r.nodeId, label: moveLabel(r), title, description, kind, priority, moveOrder: r.moveNumber * 2 + (r.mover === 'black' ? 1 : 0) });
    if (r.terminalOutcome === 'checkmate') add(`${who} delivered checkmate`, 'The final position ends the game. Open it on the board.', 'conversion', 25);
    else if (loss >= 5) {
      const changed = before !== null && after !== null && before >= -50 && after < -150;
      add(changed ? `${who} handed over the advantage` : before !== null && before >= 150 ? `${who} missed an opportunity` : `${who} lost ground`,
        `${r.bestScoreText ?? '—'} → ${r.playedScoreText ?? '—'} from ${who.toLowerCase()}’s perspective. Impact: ${loss.toFixed(1)} points.${continuation(r)}`, 'mistake', loss + (changed ? 10 : 0));
    } else if (r.greatFind) {
      add(before !== null && before < 50 ? `${who} found a difficult defense` : `${who} found a difficult move`,
        r.goodMassUpper !== undefined ? `Sound choices for ${who.toLowerCase()}: Maia estimate ${(r.goodMassLower === undefined ? '—' : (r.goodMassLower * 100).toFixed(0) + '%')}–${(r.goodMassUpper * 100).toFixed(0)}%, including unassessed alternatives.${continuation(r)}` : 'Stockfish checked the alternatives; Maia evidence supports this as a difficult accurate choice.', 'defense', 30);
    } else if (before !== null && after !== null && before >= 500 && after >= 500 && positions[r.nodeId] && i > 0) {
      const count = (fen: string) => (fen.split(' ')[0].match(/[nbrqNBRQ]/g) ?? []).length;
      if (positions[results[i-1].nodeId] && count(positions[r.nodeId]) < count(positions[results[i-1].nodeId]))
        add(`${who} exchanged material while winning`, `The advantage stayed at ${r.playedScoreText}. This is not penalized merely for reducing a large engine score.`, 'conversion', 8);
    }
    if (r.attackEvidence) add(`${who} created a mating threat`, r.attackEvidence, 'turning', 32);
    if (r.opportunitySourceNodeId) {
      const source = results.find(n => n.nodeId === r.opportunitySourceNodeId)!;
      if (r.opportunityMissed) add(`${who} missed the opponent's gift`, `After ${moveLabel(source)}, a stronger reply could preserve the opportunity. This move returned a substantial part of the benefit.${continuation(r)}`, 'mistake', loss + 22);
      else if (r.opportunityTaken) add(`${who} exploited an opponent error`, `The chance came from ${moveLabel(source)}. ${who} preserved it with less than two impact points lost.${continuation(r)}`, 'conversion', 20 + Math.min(15, r.opportunityAvailable ?? 0));
    }
    if (r.ratingSignal === 'above' && !r.obvious && loss < 2) add(`${who} played above the reference profile`, 'An accurate decision that becomes more likely at higher Maia levels. This is a strength signal, not a claim of brilliance.' + continuation(r), 'turning', 19);
    if (r.ratingSignal === 'below' && loss >= 5) add(`${who} made a below-reference decision`, 'Maia predicts this objective miss more often at lower levels. Inspect the attainable improvement.' + continuation(r), 'mistake', loss + 14);
    if (r.maiaStatus === 'complete' && r.maiaPlayedProbability !== null && r.maiaPlayedProbability !== undefined) {
      const likelihood = `${(r.maiaPlayedProbability * 100).toFixed(1)}% choice likelihood at the Maia ${r.maiaElo ?? 'selected'} benchmark`;
      if (loss >= 5 && r.maiaPlayedProbability >= 0.15)
        add(`${who} fell for a natural choice`, `${likelihood}. A plausible human choice, but Stockfish finds a stronger continuation.${continuation(r)}`, 'mistake', loss + 12);
      else if (!r.obvious && loss < 2 && r.maiaPlayedProbability <= 0.1)
        add(`${who} chose an unusual, accurate idea`, `${likelihood}. Stockfish confirms low impact. This alone does not prove the move was difficult or deserving of !.`, 'turning', 18);
    }
  });
  const picked = new Set<string>();
  const moments = candidates.sort((a,b) => b.priority-a.priority).filter(m => {
    if (picked.has(m.nodeId)) return false;
    picked.add(m.nodeId); return true;
  }).slice(0,5);
  const headline = moments[0]?.title ?? 'Your game, move by move';
  moments.sort((a, b) => a.moveOrder - b.moveOrder);
  const openingRow = results.find(r => r.openingEvidence);
  const opening = openingRow?.openingEvidence ? {
    nodeId: openingRow.nodeId,
    name: openingRow.openingEvidence.name,
    totalGames: openingRow.openingEvidence.totalGames,
    playedGames: openingRow.openingEvidence.playedGames,
    frequency: openingRow.openingEvidence.frequency,
  } : null;
  const tablebaseRows = results.filter(r => r.tablebaseEvidence).map(r => ({ nodeId: r.nodeId, category: r.tablebaseEvidence!.category }));
  const tablebase = tablebaseRows[0] ?? null;
  return { players, phases, points, moments, headline, opening, tablebase };
}
