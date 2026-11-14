import { Chess } from 'chess.js';
import type { MoveTree } from '../repertoireMoves';
import { trainingMoveIds } from '../repertoireMoves';

export type TrainingSide = 'white' | 'black';
export type TrainingPrompt = {
  key: string;
  fen: string;
  side: TrainingSide;
  answers: string[];
  kind: 'repertoire' | 'mistake';
  loss?: number;
  game?: { id: string; source: 'lichess' | 'chesscom'; createdAt: number; url?: string };
};
export type ReviewOutcome = 'first' | 'assisted' | 'corrected' | 'missed';
export type PositionReview = {
  dueAt: number;
  reviewedAt: number;
  outcome: ReviewOutcome;
  stage: number;
  advancedOn?: string;
};

const DAY = 86_400_000;
const INTERVALS = [1, 3, 7, 14, 30, 60];
export const DAILY_LIMIT = 16;
export const DAILY_MINUTES = 10;

export const trainingFen = (fen: string) => fen === 'start' ? new Chess().fen() : fen;
export function trainingPositionKey(fen: string) {
  const full = trainingFen(fen);
  const parts = full.split(' ', 4);
  if (parts[3] && parts[3] !== '-') parts[3] = new Chess(full).fen().split(' ')[3];
  return parts.join(' ');
}

export const trainingSideFor = (fen: string): TrainingSide => trainingPositionKey(fen).split(' ')[1] === 'w' ? 'white' : 'black';
export const localTrainingDate = (now: number) => new Date(now).toDateString();

export function recordPositionReview(previous: PositionReview | undefined, outcome: ReviewOutcome, now: number): PositionReview {
  const day = localTrainingDate(now);
  const review = { ...previous, reviewedAt: now, outcome, stage: previous?.stage ?? 0 };
  if (outcome !== 'first') return { ...review, stage: 0, advancedOn: day, dueAt: now + DAY };
  if (previous && (previous.advancedOn === day || previous.dueAt > now)) return { ...previous, reviewedAt: now, outcome };
  const stage = Math.min(INTERVALS.length, review.stage + 1);
  return { ...review, stage, advancedOn: day, dueAt: now + INTERVALS[stage - 1] * DAY };
}

export type ActivePosition = {
  fen: string;
  moves: Set<string>;
  answers: Set<string>;
  repertoireIds: Set<string>;
};
export type ActiveTrainingRepertoires = Record<TrainingSide, Map<string, ActivePosition>>;

export function indexTrainingRepertoires(
  repertoires: Record<TrainingSide, readonly { id: string; tree: MoveTree }[]>,
  includeAlternatives: boolean,
): ActiveTrainingRepertoires {
  const result: ActiveTrainingRepertoires = { white: new Map(), black: new Map() };
  for (const side of ['white', 'black'] as const) {
    for (const { id, tree } of repertoires[side]) {
      const root = tree.nodes[tree.rootId];
      if (!root?.children.length) continue;
      const pending = [root.id];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const nodeId = pending.pop()!;
        const node = tree.nodes[nodeId];
        if (!node || visited.has(nodeId)) continue;
        visited.add(nodeId);
        const fen = trainingFen(node.fen);
        const key = trainingPositionKey(fen);
        const ownTurn = key.split(' ')[1] === (side === 'white' ? 'w' : 'b');
        const children = node.children.filter(childId => tree.nodes[childId]?.moveUci && !tree.nodes[childId].inactiveStatus);
        const preferred = new Set(trainingMoveIds(tree, node, ownTurn, includeAlternatives));
        const position = result[side].get(key) ?? { fen, moves: new Set(), answers: new Set(), repertoireIds: new Set() };
        position.repertoireIds.add(id);
        for (const childId of children) {
          const uci = tree.nodes[childId].moveUci!;
          position.moves.add(uci);
          if (preferred.has(childId)) position.answers.add(uci);
          pending.push(childId);
        }
        result[side].set(key, position);
      }
    }
  }
  return result;
}

export type DailyCandidate = {
  prompt: TrainingPrompt;
  lastMistakeAt?: number;
  mistakeGames?: number;
  legacyWeakness?: number;
};

export function planDailyTraining(
  candidates: readonly DailyCandidate[],
  reviews: Readonly<Record<string, PositionReview>>,
  now: number,
  limit = DAILY_LIMIT,
) {
  const ranked = new Map<string, { prompt: TrainingPrompt; priority: number; dueAt: number }>();
  for (const candidate of candidates) {
    const { prompt, lastMistakeAt = 0, mistakeGames = 0, legacyWeakness = 0 } = candidate;
    const previous = reviews[prompt.key];
    const freshMistake = lastMistakeAt > (previous?.reviewedAt ?? 0);
    if (!freshMistake && previous && previous.dueAt > now) continue;
    const priority = freshMistake ? 300 + Math.min(10, mistakeGames) * 2 + (prompt.loss ?? 0) / 10
      : previous ? 200 - previous.stage + Number(previous.outcome !== 'first') * 10
      : prompt.kind === 'mistake' ? 120 + Math.min(10, mistakeGames) * 2
      : 100 + legacyWeakness * 15;
    const old = ranked.get(prompt.key);
    if (!old || priority > old.priority) ranked.set(prompt.key, { prompt, priority, dueAt: previous?.dueAt ?? now });
  }
  return [...ranked.values()].sort((a, b) => b.priority - a.priority || a.dueAt - b.dueAt)
    .slice(0, limit).map(entry => entry.prompt);
}

export function nextTrainingDue(reviews: Readonly<Record<string, PositionReview>>, keys: Iterable<string>, now: number) {
  let next = Infinity;
  for (const key of keys) next = Math.min(next, reviews[key]?.dueAt ?? now);
  return Number.isFinite(next) ? next : null;
}

export function chooseTrainingReply<T>(
  options: readonly T[],
  chances: (option: T) => { encounters: number; trouble: number },
  random = Math.random,
): T | undefined {
  if (!options.length) return undefined;
  const weights = options.map(option => {
    const { encounters, trouble } = chances(option);
    return (1 + Math.sqrt(encounters)) * (1 + Math.min(3, trouble) * 0.5);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Preserve a meaningful chance for unplayed branches even with a dominant main line.
  const coverage = 0.15 / options.length;
  let sample = random();
  return options.find((_, index) => (sample -= coverage + 0.85 * weights[index] / total) < 0) ?? options.at(-1);
}

