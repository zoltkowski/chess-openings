import { Chess } from 'chess.js';
import { playerGameHistoryStart, type PlayerGame, type PlayerGameHistory } from './playerGameHistory';

type ArchiveGame = {
  url?: string; pgn?: string; end_time?: number; rules?: string; time_class?: string; rated?: boolean;
  white?: { username?: string; result?: string; rating?: number };
  black?: { username?: string; result?: string; rating?: number };
};

/** Fetch archive months serially and checkpoint each completed month for interrupted imports. */
export async function syncChessComHistory(
  account: string, previous: PlayerGameHistory | null, signal: AbortSignal,
  request: (url: string, signal: AbortSignal) => Promise<Response>,
  checkpoint: (history: PlayerGameHistory) => Promise<void>,
): Promise<PlayerGameHistory> {
  const now = Date.now();
  const cutoff = playerGameHistoryStart(now);
  const games = new Map((previous?.games ?? []).filter(game => game.createdAt >= cutoff).map(game => [game.id, game]));
  const done = new Set(previous?.completedMonths ?? []);
  const response = await request(`https://api.chess.com/pub/player/${encodeURIComponent(account)}/games/archives`, signal);
  const list = await response.json() as { archives?: unknown };
  if (!Array.isArray(list.archives)) throw new Error('Invalid Chess.com archive list.');
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  const minMonth = new Date(cutoff).toISOString().slice(0, 7);
  const previousMonthDate = new Date(now);
  previousMonthDate.setUTCDate(1);
  previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth() - 1);
  const previousMonth = previousMonthDate.toISOString().slice(0, 7);
  for (const entry of list.archives) {
    if (typeof entry !== 'string') continue;
    const match = entry.match(/^https:\/\/api\.chess\.com\/pub\/player\/[^/]+\/games\/(\d{4})\/(\d{2})$/i);
    if (!match) continue;
    const month = `${match[1]}-${match[2]}`;
    if (month < minMonth || month > currentMonth || (month < previousMonth && done.has(month))) continue;
    signal.throwIfAborted();
    const archive = await request(entry, signal);
    const data = await archive.json() as { games?: unknown };
    if (!Array.isArray(data.games)) throw new Error('Invalid Chess.com monthly archive.');
    for (const game of data.games as ArchiveGame[]) {
      const createdAt = (game.end_time ?? 0) * 1000;
      const color = game.white?.username?.toLowerCase() === account ? 'white' : game.black?.username?.toLowerCase() === account ? 'black' : undefined;
      if (game.rules !== 'chess' || !game.url || !game.pgn || !color || createdAt < cutoff || createdAt > now ||
          !game.white?.result || !game.black?.result || game.white.result === 'aborted' || game.black.result === 'aborted') continue;
      let moves: string;
      try {
        const chess = new Chess();
        chess.loadPgn(game.pgn);
        const headers = chess.getHeaders();
        if (headers.SetUp === '1' || headers.FEN || headers.Result === '*') continue;
        moves = chess.history().join(' ');
      } catch {
        continue;
      }
      if (!moves) continue;
      const id = `chesscom:${game.url.replace(/\/$/, '').toLowerCase()}`;
      const winner = game.white.result === 'win' ? 'white' : game.black.result === 'win' ? 'black' : undefined;
      const saved: PlayerGame = { id, source: 'chesscom', account, createdAt, color, speed: game.time_class === 'daily' ? 'correspondence' : (game.time_class ?? ''), rated: game.rated === true, winner, moves, whiteRating: game.white.rating, blackRating: game.black.rating, url: game.url };
      const existing = games.get(id);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(saved)) games.set(id, saved);
    }
    if (month !== currentMonth) done.add(month);
    await checkpoint({ syncedAt: previous?.syncedAt ?? 0, games: [...games.values()], completedMonths: [...done].filter(value => value >= minMonth) });
  }
  return { syncedAt: now, games: [...games.values()], completedMonths: [...done].filter(value => value >= minMonth) };
}
