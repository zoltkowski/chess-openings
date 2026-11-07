import type { StockfishEvaluationResult } from '../App';
import { moveLoss } from './reportModel';

type Evaluation = Pick<StockfishEvaluationResult, 'scoreText' | 'evalCp' | 'wdl'>;
export type PlayerAssessment = {
  best: Evaluation & Pick<StockfishEvaluationResult, 'bestMove'>;
  moves: Record<string, { score: string; confirmedLoss: number | null }>;
  observed: Record<string, number>;
};

export type PlayerAssessments = Record<string, PlayerAssessment>;
export const PLAYER_MISTAKE_LOSS = 10;
const SOUND_LOSS = 5;

export type PlayerMistakeFrequency = {
  recent: number;
  earlier: number;
};

export function playerMistakePriority({ recent, earlier }: PlayerMistakeFrequency) {
  const group = recent >= 2 ? 4 : recent === 1 && earlier > 0 ? 3 : recent === 1 ? 2 : earlier >= 2 ? 1 : 0;
  return group * 1_000 + Math.min(49, recent) * 20 + Math.min(19, earlier);
}

export function playerMistakePattern({ recent, earlier }: PlayerMistakeFrequency, recentGames: number) {
  if (recent >= 2) return 'Repeated recently';
  if (recent === 1) return earlier ? 'Occurred again recently' : 'One recent occurrence';
  if (recentGames > 0) return earlier === 1 ? 'One earlier occurrence, none recently' : 'Repeated earlier, none recently';
  return earlier === 1 ? 'One earlier occurrence' : 'Repeated earlier';
}

export function hasPlayedMistake(assessment: PlayerAssessment | undefined) {
  return Boolean(assessment && Object.keys(assessment.observed).some(
    uci => assessment.observed[uci] > 0 && (assessment.moves[uci]?.confirmedLoss ?? 0) >= PLAYER_MISTAKE_LOSS,
  ));
}

export function playerPositionLoss(best: Evaluation, played: Evaluation) {
  return moveLoss(best.scoreText, best.evalCp, played.scoreText, played.evalCp, best.wdl, played.wdl);
}

export function playerAssessmentKey(handle: string, side: string, position: string) {
  return JSON.stringify([handle.trim().toLowerCase(), side, position]);
}

export function playerTrainingBonus(
  assessment: PlayerAssessment | undefined,
  repertoireMoves: ReadonlySet<string> | undefined,
  recentAnswers: readonly number[],
) {
  if (!assessment || !repertoireMoves?.size) return 0;
  const prepared = [...repertoireMoves].map(uci => assessment.moves[uci]?.confirmedLoss);
  // Training accepts every saved answer, so wait until the saved moves are sound.
  if (prepared.some(loss => loss == null || loss >= SOUND_LOSS)) return 0;
  let errors = 0;
  for (const [uci, count] of Object.entries(assessment.observed)) {
    if (!repertoireMoves.has(uci) && (assessment.moves[uci]?.confirmedLoss ?? 0) >= PLAYER_MISTAKE_LOSS) errors += count;
  }
  let streak = 0;
  for (let index = recentAnswers.length - 1; index >= 0 && recentAnswers[index] === 1; index--) streak++;
  return Math.min(100, errors * 35) / 2 ** streak;
}
