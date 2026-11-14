import { Chess } from 'chess.js';
import type { StockfishEvaluationResult } from '../App';
import type { PlayerGameHistory } from '../analysis/playerGameHistory';
import { PLAYER_MISTAKE_LOSS, playerPositionLoss } from '../analysis/playerRepertoire';
import { type ActiveTrainingRepertoires, trainingPositionKey, type TrainingSide } from './schedule';

type Game = PlayerGameHistory['games'][number];
type GameEvidence = Pick<Game, 'id' | 'createdAt' | 'source' | 'account' | 'url'>;
type Lead = { anchor: string; key: string; fen: string; side: TrainingSide; uci: string; san: string; games: GameEvidence[]; count: number };
type Candidate = Lead & { history: string[]; failures: number; retryAt: number };
type Result = {
  kind: 'mistake' | 'sound' | 'inaccuracy' | 'uncertain';
  loss: number | null;
  bestMove: string | null;
  score?: string;
  bestScore?: string;
  depth?: number;
};
type ReviewedMove = Lead & Result;
export type OpeningFeed = {
  version: 1;
  repertoireSignature?: string;
  seenGames: string[];
  pending: Record<string, Candidate>;
  checked: Record<string, ReviewedMove>;
  missing: Record<string, Lead>;
};

const DAY = 86_400_000;
const HISTORY_DAYS = 90;
const MAX_RECENT_GAMES = 160;
const MAX_PENDING = 100;
const MAX_CHECKED = 480;
const MAX_MISSING = 160;
const MAX_EVIDENCE = 24;
const OPENING_PLIES = 32;
const OUTSIDE_REPERTOIRE_DECISIONS = 3;
const MAX_GAMES_PER_PASS = 4;

export const emptyOpeningFeed: OpeningFeed = { version: 1, seenGames: [], pending: {}, checked: {}, missing: {} };

export function recentOpeningGames(games: readonly Game[], now: number) {
  return games.filter(game => game.createdAt >= now - HISTORY_DAYS * DAY)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, MAX_RECENT_GAMES);
}

function prune<T extends Lead>(entries: Record<string, T>, limit: number) {
  return Object.keys(entries).length <= limit ? entries : Object.fromEntries(
    Object.entries(entries).sort(([, a], [, b]) => lastSeen(b) - lastSeen(a)).slice(0, limit),
  );
}

export function lastSeen(lead: Lead) {
  return lead.games[0]?.createdAt ?? 0;
}

function addGame<T extends Lead>(lead: T, game: GameEvidence): T {
  return { ...lead, count: lead.count + 1,
    games: [...lead.games, game].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_EVIDENCE) };
}

function scanGame(game: Game, active: ActiveTrainingRepertoires, feed: OpeningFeed) {
  const { id, createdAt, source, account, url } = game;
  const provenance = { id, createdAt, source, account, url };
  const chess = new Chess();
  const positions = active[game.color];
  const history: string[] = [];
  const seen = new Set<string>();
  let outside = 0;
  let anchor = '';

  for (const san of game.moves.trim().split(/\s+/).slice(0, OPENING_PLIES)) {
    const fen = chess.fen();
    const key = trainingPositionKey(fen);
    const ownTurn = chess.turn() === (game.color === 'white' ? 'w' : 'b');
    const prepared = positions.get(key);
    if (prepared) {
      anchor = key;
      outside = 0;
    } else if (anchor && outside >= OUTSIDE_REPERTOIRE_DECISIONS) {
      break;
    } else if (anchor && ownTurn) {
      outside++;
    }
    if (chess.isDraw()) break;
    let move;
    try {
      move = chess.move(san);
    } catch {
      break;
    }
    const uci = move.from + move.to + (move.promotion ?? '');
    if (anchor && !seen.has(key)) {
      const moveKey = `${game.color}|${key}|${uci}`;
      const lead = { anchor, key, fen, side: game.color, uci, san: move.san, games: [], count: 0 };
      if (ownTurn) {
        const known = feed.checked[moveKey];
        if (known) feed.checked[moveKey] = addGame(known, provenance);
        else {
          const pending = feed.pending[moveKey] ?? { ...lead, history: [...history], failures: 0, retryAt: 0 };
          feed.pending[moveKey] = addGame(pending, provenance);
        }
      } else if (prepared && !prepared.moves.has(uci)) {
        feed.missing[moveKey] = addGame(feed.missing[moveKey] ?? lead, provenance);
      }
      seen.add(key);
    }
    history.push(uci);
  }
}

export function intakeOpeningGames(
  feed: OpeningFeed,
  games: readonly Game[],
  active: ActiveTrainingRepertoires,
): OpeningFeed {
  if (!active.white.size && !active.black.size) return feed;
  // Leave room for the full game prefix so marking a game seen never drops any of its moves.

  const seen = new Set(feed.seenGames);
  const next = { ...feed, checked: { ...feed.checked }, pending: { ...feed.pending }, missing: { ...feed.missing } };
  let imported = 0;
  for (const game of games) {
    if (seen.has(game.id) || !active[game.color].size) continue;
    if (Object.keys(next.pending).length > MAX_PENDING - OPENING_PLIES / 2 || imported === MAX_GAMES_PER_PASS) break;
    scanGame(game, active, next);
    seen.add(game.id);
    imported++;
  }
  if (!imported) return feed;
  next.seenGames = [...seen].slice(-MAX_RECENT_GAMES * 3);
  next.missing = prune(next.missing, MAX_MISSING);
  return next;
}

export function openingRepertoireSignature(active: ActiveTrainingRepertoires) {
  const entries = (side: TrainingSide) => [...active[side]].map(([key, position]) =>
    [key, [...position.moves].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  return JSON.stringify([entries("white"), entries("black")]);
}

export function nextOpeningAssessment(feed: OpeningFeed, active: ActiveTrainingRepertoires, now: number) {
  return Object.entries(feed.pending).filter(([, candidate]) => candidate.retryAt <= now && active[candidate.side].has(candidate.anchor))
    .sort(([, a], [, b]) => {
      const priority = (lead: Lead) => {
        const position = active[lead.side].get(lead.key);
        return position && !position.moves.has(lead.uci) ? 2 : position ? 1 : 0;
      };
      return priority(b) - priority(a) || lastSeen(b) - lastSeen(a) || b.count - a.count;
    })[0];
}

export function finishOpeningAssessment(feed: OpeningFeed, id: string, result: Result | null, now: number): OpeningFeed {
  const candidate = feed.pending[id];
  if (!candidate) return feed;
  const { anchor, key, fen, side, uci, san, games, count, failures } = candidate;
  const lead = { anchor, key, fen, side, uci, san, games, count };
  const pending = { ...feed.pending };
  const checked = { ...feed.checked };
  if ((!result || result.kind === 'uncertain') && failures < 2) {
    pending[id] = { ...candidate, failures: failures + 1, retryAt: now + (failures ? 10 : 1) * 60_000 };
  } else {
    delete pending[id];
    checked[id] = { ...lead, ...(result ?? { kind: 'uncertain', bestMove: null, loss: null }) };
  }
  return { ...feed, pending, checked: prune(checked, MAX_CHECKED) };
}

type Query = (input: {
  fen: string; perspectiveSide: TrainingSide; positionCommand: string; movetimeMs: number;
  searchMoves?: readonly string[]; signal: AbortSignal;
}) => Promise<StockfishEvaluationResult>;

export async function verifyOpeningMove(candidate: Candidate, query: Query, signal: AbortSignal): Promise<Result | null> {
  const positionCommand = `position startpos${candidate.history.length ? ` moves ${candidate.history.join(' ')}` : ''}`;
  const evaluate = async (movetimeMs: number, searchMoves?: readonly string[]) => {
    signal.throwIfAborted();
    const score = await query({ fen: candidate.fen, perspectiveSide: candidate.side, positionCommand, movetimeMs, searchMoves, signal });
    signal.throwIfAborted();
    if (!score.hasScore || !score.bestMove || score.depth < 8 ||
      score.pv.split(/\s+/)[0] !== score.bestMove || (searchMoves && !searchMoves.includes(score.bestMove))) {
      throw new Error('Stockfish did not return an exact score for this move.');
    }
    return score;
  };
  const compare = async (movetimeMs: number) => {
    const best = await evaluate(movetimeMs);
    const played = best.bestMove === candidate.uci ? best : await evaluate(movetimeMs, [candidate.uci]);
    return { best, played, loss: playerPositionLoss(best, played), contradicts: (playerPositionLoss(played, best) ?? 0) > 1 };
  };
  const classification = (loss: number | null): Result['kind'] => loss === null ? 'uncertain'
    : loss < 5 ? 'sound' : loss < PLAYER_MISTAKE_LOSS ? 'inaccuracy' : 'mistake';
  try {
    const quick = await compare(190);
    const refine = quick.contradicts || quick.loss === null || quick.loss >= 4;
    const verified = refine ? await compare(candidate.failures ? 1000 : 560) : quick;
    const kind = classification(verified.loss);
    if (verified.contradicts || kind !== classification(quick.loss) || quick.contradicts || kind === 'uncertain') {
      return { kind: 'uncertain', loss: null, bestMove: null };
    }
    return { kind, loss: verified.loss, bestMove: verified.best.bestMove, score: verified.played.scoreText,
      bestScore: verified.best.scoreText, depth: Math.min(verified.best.depth, verified.played.depth) };
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    return null;
  }
}

export function openingTrainingEvidence(feed: OpeningFeed, active: ActiveTrainingRepertoires, now: number) {
  const checked = Object.values(feed.checked).filter(move => active[move.side].has(move.anchor) && lastSeen(move) >= now - HISTORY_DAYS * DAY);
  const mistakes = new Map<string, ReviewedMove[]>();
  const verified = new Map<string, ReviewedMove[]>();
  const soundDeviations: ReviewedMove[] = [];
  for (const move of checked) {
    const list = verified.get(move.key) ?? [];
    list.push(move);
    verified.set(move.key, list);
    if (move.kind === 'mistake' && move.bestMove) {
      const group = mistakes.get(move.key) ?? [];
      group.push(move);
      mistakes.set(move.key, group);
    } else if (move.kind === 'sound' && active[move.side].get(move.key)?.moves.size && !active[move.side].get(move.key)?.moves.has(move.uci)) {
      soundDeviations.push(move);
    }
  }
  const missing = Object.values(feed.missing).filter(move => {
    const position = active[move.side].get(move.key);
    return position && !position.moves.has(move.uci) && lastSeen(move) >= now - HISTORY_DAYS * DAY;
  });
  return { checked, verified, mistakes, soundDeviations, missing };
}




export function openingDailyCandidates(
  active: ActiveTrainingRepertoires,
  evidence: ReturnType<typeof openingTrainingEvidence>,
  side: TrainingSide,
  selectedRepertoire: string | null,
  weakness: (key: string) => number,
) {
  const candidates: import('./schedule').DailyCandidate[] = [];
  for (const [key, position] of active[side]) {
    if (selectedRepertoire && !position.repertoireIds.has(selectedRepertoire)) continue;
    if (!position.answers.size || position.fen.split(' ')[1] !== side[0]) continue;
    const answers = [...position.answers].filter(uci => !evidence.mistakes.get(key)?.some(move => move.uci === uci));
    if (answers.length) candidates.push({
      prompt: { key, fen: position.fen, answers, side, kind: 'repertoire' },
      legacyWeakness: weakness(key),
    });
  }
  for (const [key, mistakes] of evidence.mistakes) {
    const relevant = mistakes.filter(move => move.side === side &&
      (!selectedRepertoire || active[side].get(move.anchor)?.repertoireIds.has(selectedRepertoire)));
    if (!relevant.length) continue;
    const latest = relevant.reduce((a, b) => lastSeen(a) >= lastSeen(b) ? a : b);
    const bad = new Set(mistakes.map(move => move.uci));
    const bestMoves = relevant.map(move => move.bestMove!).filter(uci => !bad.has(uci));
    const sound = evidence.verified.get(key)?.filter(move => move.kind === 'sound' && (move.loss ?? 100) < 2)
      .map(move => move.uci) ?? [];
    const answers = [...new Set([...bestMoves, ...sound])];
    if (answers.length) candidates.push({
      prompt: { key, fen: latest.fen, answers, side, kind: 'mistake', loss: latest.loss ?? undefined, game: latest.games[0] },
      lastMistakeAt: lastSeen(latest),
      mistakeGames: new Set(relevant.flatMap(move => move.games.map(game => game.id))).size,
    });
  }
  return candidates;
}

export function trainingRecurrence(
  evidence: ReturnType<typeof openingTrainingEvidence>,
  reviews: Readonly<Record<string, import('./schedule').PositionReview>>,
  keys: ReadonlySet<string>,
) {
  const opportunities = new Set<string>();
  const mistakes = new Set<string>();
  for (const move of evidence.checked) {
    const review = reviews[move.key];
    if (!keys.has(move.key) || !review || move.kind === 'uncertain') continue;
    for (const game of move.games) {
      if (game.createdAt <= review.reviewedAt) continue;
      const id = `${move.key}|${game.id}`;
      opportunities.add(id);
      if (move.kind === 'mistake') mistakes.add(id);
    }
  }
  return { opportunities: opportunities.size, mistakes: mistakes.size };
}
