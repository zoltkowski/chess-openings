import { Chess } from 'chess.js';
import { expectedScore, moveLoss, obviousDecision, isMateScore } from './reportModel';

export const ANALYSIS_CONFIG = {
  minDecisionWeightForMaia: 0.35, maxLevelsPerMove: 7,
  maxTotalPositionEvaluations: 1200, maiaSentinelDelta: 600, maiaRefinementStep: 200,
  minAbsoluteProbabilityDelta: 0.1, minProbabilityRatio: 1.8,
  goodLoss: 2, meaningfulLoss: 5, onlyMoveGap: 12, winningThreshold: 90,
  quickScreenMs: 180, deepScreenMs: 600, quickRefineMs: 600, deepRefineMs: 1800,
  maxDeepPositions: 60, deepMultiPv: 8, deepAlternativeMs: 800,
  maxAlternativeQueries: 240, maxAlternativesPerMove: 8, targetPolicyCoverage: 0.9,
  deepMaiaBudgetMs: 600_000, maxOpeningQueries: 8, maxTablebaseQueries: 4,
};
export type CandidateEvaluation = { uci: string; scoreText: string; evalCp: number; wdl?: [number, number, number] | null; depth: number; pv?: string };
export type DecisionMetrics = {
  decisionWeight: number; significanceScore: number; maiaPriority: number;
  bestVsSecondGap: number | null; goodMoveCount: number; candidateCount: number;
  legalMoveCount: number; forced: boolean; obvious: boolean; stableWin: boolean;
  winChanceLoss: number | null; drawChanceLoss: number | null; lossChanceIncrease: number | null;
};
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function profileLevels(anchor: number) {
  if (anchor < 1100 || anchor > 3000 || !Number.isFinite(anchor)) return [];
  return [...new Set([-600, -400, -200, 0, 200, 400, 600]
    .map(delta => Math.max(1100, Math.min(3000, anchor + delta))))].sort((a, b) => a - b);
}
export function candidateLoss(best: CandidateEvaluation, played: CandidateEvaluation) {
  return moveLoss(best.scoreText, best.evalCp, played.scoreText, played.evalCp, best.wdl, played.wdl);
}
export function difficultyFromMass(lower: number, upper: number, obvious: boolean) {
  // Use the upper bound: unexplored probability mass cannot establish difficulty.
  return obvious ? 0 : clamp(1 - Math.max(lower, upper));
}
export function screenDecision(input: {
  fen: string; playedUci: string; previousSan?: string | null; previousUci?: string | null;
  best: CandidateEvaluation; played: CandidateEvaluation; candidates: CandidateEvaluation[]; lossPoints: number | null;
}): DecisionMetrics {
  const { best, played, candidates, lossPoints } = input;
  const chess = new Chess(input.fen), legal = chess.moves({ verbose: true });
  const move = legal.find(m => `${m.from}${m.to}${m.promotion ?? ''}` === input.playedUci);
  const forced = legal.length <= 1;
  const obvious = forced || obviousDecision(input.fen, input.playedUci, input.previousSan, input.previousUci)
    || Boolean(move?.san.endsWith('#'));
  const known = candidates.filter(c => c.depth === best.depth);
  const gaps = known.filter(c => c.uci !== best.uci).map(c => candidateLoss(best, c)).filter((x): x is number => x !== null);
  const bestVsSecondGap = gaps.length ? Math.min(...gaps) : null;
  const goodMoveCount = known.filter(c => (candidateLoss(best, c) ?? Infinity) < ANALYSIS_CONFIG.goodLoss).length;
  const a = expectedScore(best.wdl), b = expectedScore(played.wdl);
  const stableWin = a !== null && b !== null && a >= 98 && b >= 98 && !isMateScore(played.scoreText);
  const significanceScore = lossPoints === null ? 0 : stableWin ? 0.1 : clamp(0.35 + lossPoints / 20 + (bestVsSecondGap ?? 0) / 40);
  // Heuristic importance, independent of Maia rating discrimination.
  const decisionWeight = obvious || lossPoints === null ? 0 : stableWin ? 0.1
    : clamp(0.35 + Math.min(0.3, lossPoints / 25) + Math.min(0.35, (bestVsSecondGap ?? 0) / 30));
  const delta = (index: number, reverse = false) => {
    if (!best.wdl || !played.wdl) return null;
    const sumA = best.wdl.reduce((x,y) => x+y, 0), sumB = played.wdl.reduce((x,y) => x+y, 0);
    return sumA && sumB ? (best.wdl[index] / sumA - played.wdl[index] / sumB) * (reverse ? -100 : 100) : null;
  };
  return { decisionWeight, significanceScore, maiaPriority: decisionWeight * significanceScore,
    bestVsSecondGap, goodMoveCount, candidateCount: known.length, legalMoveCount: legal.length,
    forced, obvious, stableWin, winChanceLoss: delta(0), drawChanceLoss: delta(1), lossChanceIncrease: delta(2, true) };
}
