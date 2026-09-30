/** Small, best-effort lookups used as evidence by the game analyser. */

export interface OpeningEvidence {
  name?: string;
  totalGames: number;
  playedGames?: number;
  frequency?: number;
}

export type TablebaseCategory = "win" | "cursed-win" | "draw" | "blessed-loss" | "loss";

export interface TablebaseMove {
  uci: string;
  category: TablebaseCategory;
  dtz?: number;
}

export interface TablebaseEvidence {
  category: TablebaseCategory;
  dtz?: number;
  bestMoves: TablebaseMove[];
}

const MAX_CACHE_ENTRIES = 128;
const REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_GAP_MS = 250;
const cache = new Map<string, OpeningEvidence | TablebaseEvidence | null>();
const hostCooldownUntil = new Map<string, number>();
let lastRequestAt = 0;
let requestTail: Promise<void> = Promise.resolve();

function remember(key: string, value: OpeningEvidence | TablebaseEvidence | null): void {
  // Failures are transient; don't turn an outage or rate limit into a permanent cache miss.
  if (value === null) return;
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

function cached<T extends OpeningEvidence | TablebaseEvidence>(key: string): T | null | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) ?? null;
  // Refresh insertion order for a small LRU cache.
  cache.delete(key);
  cache.set(key, value);
  return value as T | null;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface FetchResult { status: number; headers: Headers; data: unknown }

async function throttledFetch(url: string, signal?: AbortSignal, token?: string): Promise<FetchResult> {
  if (signal?.aborted) throw abortError();
  const host = new URL(url).host;
  if ((hostCooldownUntil.get(host) ?? 0) > Date.now()) return { status: 429, headers: new Headers(), data: null };
  let release!: () => void;
  const previous = requestTail;
  requestTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    if (signal?.aborted) throw abortError();
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await delay(gap, signal);
    const response = await fetchWithTimeout(url, signal, token);
    lastRequestAt = Date.now();
    if (response.status !== 429) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    const dateMs = retryAfter !== null && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
    const waitMs = Number.isFinite(seconds) && seconds > 0
      ? seconds * 1_000
      : Number.isFinite(dateMs) && dateMs > Date.now()
        ? dateMs - Date.now()
        : 60_000;
    hostCooldownUntil.set(host, Date.now() + waitMs);
    return response;
  } finally {
    release();
  }
}

async function fetchWithTimeout(url: string, signal?: AbortSignal, token?: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const relayAbort = () => controller.abort();
  signal?.addEventListener("abort", relayAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}) } });
    let data: unknown = null;
    if (response.ok) data = await response.json();
    return { status: response.status, headers: response.headers, data };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", relayAbort);
  }
}

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Query the Lichess games Opening Explorer. Popularity is evidence only; it never classifies a move. */
export async function lookupOpening(
  fen: string,
  playedUci: string,
  signal?: AbortSignal,
  token?: string,
): Promise<OpeningEvidence | null> {
  const key = `opening:${fen}:${playedUci}`;
  if (signal?.aborted) throw abortError();
  const hit = cached<OpeningEvidence>(key);
  if (hit !== undefined) return hit;
  const url = new URL("https://explorer.lichess.org/lichess");
  url.searchParams.set("fen", fen);
  url.searchParams.set("moves", "50");
  try {
    const { status, data } = await throttledFetch(url.toString(), signal, token);
    if (status < 200 || status >= 300) { remember(key, null); return null; }
    if (!data || typeof data !== "object") { remember(key, null); return null; }
    const row = data as { white?: unknown; draws?: unknown; black?: unknown; opening?: { name?: unknown } };
    const white = validCount(row.white);
    const draws = validCount(row.draws);
    const black = validCount(row.black);
    if (white === null || draws === null || black === null) { remember(key, null); return null; }
    const totalGames = white + draws + black;
    const moves = Array.isArray((data as { moves?: unknown }).moves)
      ? (data as { moves: Array<{ uci?: unknown; white?: unknown; draws?: unknown; black?: unknown }> }).moves
      : [];
    const played = moves.find(move => move.uci === playedUci);
    const playedWhite = validCount(played?.white);
    const playedDraws = validCount(played?.draws);
    const playedBlack = validCount(played?.black);
    const playedGames = played && playedWhite !== null && playedDraws !== null && playedBlack !== null
      ? playedWhite + playedDraws + playedBlack
      : undefined;
    const result: OpeningEvidence = {
      ...(typeof row.opening?.name === "string" ? { name: row.opening.name } : {}),
      totalGames,
      ...(playedGames !== undefined ? { playedGames, frequency: totalGames > 0 ? Math.min(1, playedGames / totalGames) : 0 } : {}),
    };
    remember(key, result);
    return result;
  } catch {
    if (signal?.aborted) throw abortError();
    remember(key, null);
    return null;
  }
}

const CATEGORIES = new Set<TablebaseCategory>(["win", "cursed-win", "draw", "blessed-loss", "loss"]);

function eligibleSyzygyFen(fen: string): boolean {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 3 || fields[2] !== "-") return false;
  const board = fields[0];
  if (!/^[prnbqkPRNBQK1-8/]+$/.test(board)) return false;
  const pieces = (board.match(/[prnbqk]/gi) ?? []).length;
  return pieces >= 1 && pieces <= 7;
}

/** Query exact Syzygy WDL/DTZ evidence for eligible standard chess positions. */
export async function lookupTablebase(fen: string, signal?: AbortSignal): Promise<TablebaseEvidence | null> {
  if (signal?.aborted) throw abortError();
  if (!eligibleSyzygyFen(fen)) return null;
  const key = `tablebase:${fen}`;
  const hit = cached<TablebaseEvidence>(key);
  if (hit !== undefined) return hit;
  const url = new URL("https://tablebase.lichess.org/standard");
  url.searchParams.set("fen", fen);
  try {
    const { status, data } = await throttledFetch(url.toString(), signal);
    if (status < 200 || status >= 300) { remember(key, null); return null; }
    if (!data || typeof data !== "object") { remember(key, null); return null; }
    const row = data as { category?: unknown; dtz?: unknown; moves?: unknown };
    if (typeof row.category !== "string" || !CATEGORIES.has(row.category as TablebaseCategory)) {
      remember(key, null); return null;
    }
    const bestMoves: TablebaseMove[] = Array.isArray(row.moves)
      ? row.moves.flatMap((candidate: unknown) => {
          if (!candidate || typeof candidate !== "object") return [];
          const move = candidate as { uci?: unknown; category?: unknown; dtz?: unknown };
          if (typeof move.uci !== "string" || typeof move.category !== "string" || !CATEGORIES.has(move.category as TablebaseCategory)) return [];
          return [{ uci: move.uci, category: move.category as TablebaseCategory, ...(typeof move.dtz === "number" && Number.isFinite(move.dtz) ? { dtz: move.dtz } : {}) }];
        })
      : [];
    const result: TablebaseEvidence = {
      category: row.category as TablebaseCategory,
      ...(typeof row.dtz === "number" && Number.isFinite(row.dtz) ? { dtz: row.dtz } : {}),
      bestMoves,
    };
    remember(key, result);
    return result;
  } catch {
    if (signal?.aborted) throw abortError();
    remember(key, null);
    return null;
  }
}
