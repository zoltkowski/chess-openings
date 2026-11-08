import { Chess } from 'chess.js';

type Color = 'white' | 'black';
type Game = {
  id: string;
  createdAt: number;
  color: Color;
  speed: string;
  rated: boolean;
  winner?: Color;
  moves: string;
};

export type PlayerGameHistory = {
  syncedAt: number;
  oldestOngoing?: number;
  games: Game[];
  reviewIndex?: {
    version: 1;
    positions: Set<string>;
    postings: Postings;
  };
};

type ExportedGame = {
  id: string;
  createdAt: number;
  variant: string;
  speed: string;
  rated: boolean;
  status: string;
  winner?: Color;
  moves?: string;
  players?: Partial<Record<Color, { user?: { id?: string; name?: string } }>>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function playerGameHistoryStart(now: number) {
  const date = new Date(now);
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return date.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
}

export async function syncPlayerGameHistory(
  player: string,
  previous: PlayerGameHistory | null,
  signal: AbortSignal,
  request: (url: string, signal: AbortSignal) => Promise<Response>,
): Promise<PlayerGameHistory> {
  const syncedAt = Date.now();
  const cutoff = playerGameHistoryStart(syncedAt);
  const since = previous
    ? Math.max(cutoff, Math.min(previous.syncedAt - DAY_MS, previous.oldestOngoing ?? syncedAt))
    : cutoff;
  const params = new URLSearchParams({ since: String(since), until: String(syncedAt), ongoing: 'true' });
  const response = await request(`https://lichess.org/api/games/user/${encodeURIComponent(player)}?${params}`, signal);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Lichess returned no game stream.');

  const games = new Map((previous?.games ?? []).filter(game => game.createdAt >= cutoff).map(game => [game.id, game]));
  let oldestOngoing: number | undefined;
  const ingest = (line: string) => {
    if (!line.trim()) return;
    const game: ExportedGame = JSON.parse(line);
    if (typeof game.id !== 'string' || !Number.isFinite(game.createdAt)) throw new Error('Invalid Lichess game export.');
    if (game.variant !== 'standard' || game.createdAt < cutoff) return;
    if (game.status === 'created' || game.status === 'started') {
      oldestOngoing = Math.min(oldestOngoing ?? game.createdAt, game.createdAt);
      return;
    }
    if (game.status === 'aborted' || game.status === 'noStart' || !game.moves) return;
    const playerId = (color: Color) => {
      const user = game.players?.[color]?.user;
      return (user?.id ?? user?.name)?.toLowerCase();
    };
    const color = playerId('white') === player ? 'white' : playerId('black') === player ? 'black' : undefined;
    if (!color) return;
    const { id, createdAt, speed, rated, winner, moves } = game;
    const saved = games.get(id);
    if (saved && saved.createdAt === createdAt && saved.color === color && saved.speed === speed &&
      saved.rated === rated && saved.winner === winner && saved.moves === moves) return;
    games.set(id, { id, createdAt, speed, rated, winner, moves, color });
  };
  const decoder = new TextDecoder();
  let remainder = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      const lines = (remainder + decoder.decode(value, { stream: !done })).split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) ingest(line);
      if (done) {
        ingest(remainder);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const imported = [...games.values()];
  const unchanged = previous && previous.games.length === imported.length &&
    imported.every((game, index) => previous.games[index] === game);
  return unchanged ? { ...previous, syncedAt, oldestOngoing } : { syncedAt, oldestOngoing, games: imported };
}

type MoveStats = { uci: string; san: string; white: number; draws: number; black: number; lastPlayedAt: number };
type Posting = { san: string; games: number[] };
// Store SAN once per position and move, and reference the game metadata by array offset.
type Postings = Map<string, Map<string, Posting>>;
type Dates = { since?: string; until?: string };

export function playerHistoryCovers(history: PlayerGameHistory, positions: Iterable<string>) {
  const index = history.reviewIndex;
  if (index?.version !== 1) return false;
  for (const fen of positions) if (!index.positions.has(fen)) return false;
  return true;
}

export function playerHistoryIndexIsCurrent(history: PlayerGameHistory, positions: ReadonlySet<string>) {
  return history.reviewIndex?.positions.size === positions.size && playerHistoryCovers(history, positions);
}

const pieceCount = (fen: string) => fen.split(' ', 1)[0].match(/[a-z]/gi)?.length ?? 0;
const positionKey = (fen: string) => fen.split(' ', 4).join(' ');

async function collectPostings(
  games: Game[],
  positions: ReadonlySet<string>,
  includeReplies: boolean,
  signal: AbortSignal,
  shouldReplay: (game: Game, offset: number) => boolean,
): Promise<Postings> {
  signal.throwIfAborted();
  const postings: Postings = new Map();
  if (!positions.size) return postings;
  let minimumPieces = 32;
  for (const fen of positions) minimumPieces = Math.min(minimumPieces, pieceCount(fen));
  let sliceStart = performance.now();
  const chess = new Chess();
  for (const [offset, game] of games.entries()) {
    if (!shouldReplay(game, offset)) continue;
    if (performance.now() - sliceStart >= 12) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
      sliceStart = performance.now();
    }
    chess.reset();
    let fen = positionKey(chess.fen());
    let pieces = 32;
    let afterRepertoirePosition = false;
    const seen = new Set<string>();
    for (const san of game.moves.trim().split(/\s+/)) {
      if (!afterRepertoirePosition && pieces < minimumPieces) break;
      const inRepertoire = positions.has(fen);
      let move;
      try {
        move = chess.move(san);
      } catch {
        // Keep the valid prefix if a move in the export cannot be read.
        break;
      }
      if ((inRepertoire || afterRepertoirePosition) && !seen.has(fen)) {
        seen.add(fen);
        let moves = postings.get(fen);
        if (!moves) postings.set(fen, moves = new Map());
        const uci = move.from + move.to + (move.promotion ?? '');
        let posting = moves.get(uci);
        if (!posting) moves.set(uci, posting = { san: move.san, games: [] });
        posting.games.push(offset);
      }
      if (!includeReplies && inRepertoire && positions.size === 1) break;
      afterRepertoirePosition = includeReplies && inRepertoire;
      fen = positionKey(move.after);
      if (move.captured) pieces--;
    }
  }
  return postings;
}

export async function preprocessPlayerGameHistory(
  history: PlayerGameHistory,
  positions: ReadonlySet<string>,
  signal: AbortSignal,
  previous = history,
): Promise<PlayerGameHistory> {
  signal.throwIfAborted();
  if (playerHistoryIndexIsCurrent(history, positions)) return history;

  const priorIndex = playerHistoryCovers(previous, positions) ? previous.reviewIndex : undefined;
  const coveredPositions = new Set(positions);
  if (priorIndex && history.games === previous.games) {
    const postings = new Map([...priorIndex.postings].filter(([fen]) => positions.has(fen)));
    return { ...history, reviewIndex: { version: 1, positions: coveredPositions, postings } };
  }
  const retained = priorIndex ? new Map(history.games.map((game, offset) => [game, offset])) : null;
  const oldOffsets = priorIndex ? previous.games.map(game => retained?.get(game) ?? -1) : [];
  const indexed = new Set(oldOffsets.filter(offset => offset >= 0));

  const additions = await collectPostings(history.games, coveredPositions, false, signal, (_, offset) => !indexed.has(offset));
  if (priorIndex) {
    const sameOffsets = oldOffsets.every((offset, oldOffset) => offset === oldOffset);
    for (const [fen, priorMoves] of priorIndex.postings) {
      if (!positions.has(fen)) continue;
      const moves = additions.get(fen) ?? new Map<string, Posting>();
      for (const [uci, prior] of priorMoves) {
        const offsets = sameOffsets ? prior.games : prior.games.map(offset => oldOffsets[offset]).filter(offset => offset >= 0);
        if (!offsets.length) continue;
        const added = moves.get(uci);
        moves.set(uci, added ? { san: prior.san, games: offsets.concat(added.games) } : { san: prior.san, games: offsets });
      }
      if (moves.size) additions.set(fen, moves);
    }
  }
  return { ...history, reviewIndex: { version: 1, positions: coveredPositions, postings: additions } };
}

function gameMatches(game: Game, cutoff: number, color: Color, speeds: readonly string[], modes: readonly string[]) {
  return game.createdAt >= cutoff && game.color === color && (!speeds.length || speeds.includes(game.speed)) &&
    (!modes.length || modes.includes(game.rated ? 'rated' : 'casual'));
}

function createPlayerHistoryQuery(
  history: PlayerGameHistory,
  color: Color,
  speeds: readonly string[],
  modes: readonly string[],
  postings = history.reviewIndex?.postings,
) {
  return (fen: string, dates: Dates = {}) => {
    const cutoff = playerGameHistoryStart(Date.now());
    const totals = { white: 0, draws: 0, black: 0 };
    const moves: MoveStats[] = [];
    const recent: { game: Game; uci: string }[] = [];
    for (const [uci, posting] of postings?.get(fen) ?? []) {
      const move = { uci, san: posting.san, white: 0, draws: 0, black: 0, lastPlayedAt: 0 };
      for (const offset of posting.games) {
        const game = history.games[offset];
        if (!gameMatches(game, cutoff, color, speeds, modes)) continue;
        if (dates.since || dates.until) {
          const month = new Date(game.createdAt).toISOString().slice(0, 7);
          if ((dates.since && month < dates.since) || (dates.until && month > dates.until)) continue;
        }
        const result = game.winner ?? 'draws';
        totals[result]++;
        move[result]++;
        move.lastPlayedAt = Math.max(move.lastPlayedAt, game.createdAt);
        if (recent.length < 8 || game.createdAt > recent[7].game.createdAt) {
          const before = recent.findIndex(entry => game.createdAt > entry.game.createdAt);
          recent.splice(before < 0 ? recent.length : before, 0, { game, uci });
          if (recent.length > 8) recent.pop();
        }
      }
      if (move.white || move.draws || move.black) moves.push(move);
    }
    const recentGames = recent.map(({ game: { id, createdAt, winner, speed }, uci }) => ({ id, createdAt, winner, speed, uci }));
    return { ...totals, moves, recentGames };
  };
}

export async function indexPlayerGameHistory(
  history: PlayerGameHistory,
  positions: ReadonlySet<string>,
  color: Color,
  speeds: readonly string[],
  modes: readonly string[],
  signal: AbortSignal,
  includeReplies = true,
) {
  signal.throwIfAborted();
  if (!includeReplies && playerHistoryCovers(history, positions)) return createPlayerHistoryQuery(history, color, speeds, modes);
  const cutoff = playerGameHistoryStart(Date.now());
  const postings = await collectPostings(history.games, positions, includeReplies, signal,
    game => gameMatches(game, cutoff, color, speeds, modes));
  return createPlayerHistoryQuery(history, color, speeds, modes, postings);
}
