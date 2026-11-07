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
  return { syncedAt, oldestOngoing, games: [...games.values()] };
}

type Occurrence = Pick<Game, 'id' | 'createdAt' | 'winner' | 'speed'> & { uci: string; san: string };
type MoveStats = { uci: string; san: string; white: number; draws: number; black: number; lastPlayedAt: number };

export async function indexPlayerGameHistory(
  history: PlayerGameHistory,
  positions: ReadonlySet<string>,
  color: Color,
  speeds: readonly string[],
  modes: readonly string[],
  signal: AbortSignal,
  includeReplies = true,
) {
  const index = new Map<string, Occurrence[]>();
  const pieceCount = (fen: string) => fen.split(' ', 1)[0].match(/[a-z]/gi)?.length ?? 0;
  let minimumPieces = 32;
  for (const fen of positions) minimumPieces = Math.min(minimumPieces, pieceCount(fen));
  let processed = 0;
  const cutoff = playerGameHistoryStart(Date.now());
  for (const game of history.games) {
    if (game.createdAt < cutoff || game.color !== color || (speeds.length && !speeds.includes(game.speed)) ||
      (modes.length && !modes.includes(game.rated ? 'rated' : 'casual'))) continue;
    if (processed++ % 24 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
    const chess = new Chess();
    const seen = new Set<string>();
    let afterRepertoirePosition = false;
    for (const san of game.moves.split(' ')) {
      const fen = chess.fen().split(' ', 4).join(' ');
      const inRepertoire = positions.has(fen);
      if (!afterRepertoirePosition && pieceCount(fen) < minimumPieces) break;
      const move = chess.move(san);
      if ((inRepertoire || afterRepertoirePosition) && !seen.has(fen)) {
        seen.add(fen);
        const occurrences = index.get(fen) ?? [];
        occurrences.push({ id: game.id, createdAt: game.createdAt, winner: game.winner, speed: game.speed,
          uci: move.from + move.to + (move.promotion ?? ''), san: move.san });
        index.set(fen, occurrences);
      }
      if (!includeReplies && inRepertoire && positions.size === 1) break;
      // Reviews also check replies to departures at the end of a saved line.
      afterRepertoirePosition = includeReplies && inRepertoire;
    }
  }

  return (fen: string, dates: { since?: string; until?: string } = {}) => {
    const totals = { white: 0, draws: 0, black: 0 };
    const moves = new Map<string, MoveStats>();
    const matchedGames: Occurrence[] = [];
    for (const game of index.get(fen) ?? []) {
      const month = new Date(game.createdAt).toISOString().slice(0, 7);
      if ((dates.since && month < dates.since) || (dates.until && month > dates.until)) continue;
      matchedGames.push(game);
      const result = game.winner ?? 'draws';
      totals[result]++;
      const move = moves.get(game.uci) ?? {
        uci: game.uci, san: game.san, white: 0, draws: 0, black: 0, lastPlayedAt: 0,
      };
      move[result]++;
      move.lastPlayedAt = Math.max(move.lastPlayedAt, game.createdAt);
      moves.set(move.uci, move);
    }
    const recentGames = matchedGames.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
    return { ...totals, moves: [...moves.values()], recentGames };
  };
}
