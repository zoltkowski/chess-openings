import { Chess, type Move } from 'chess.js';
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

// Maia-3 browser export and move vocabulary live under public/maia/maia3.
const MAIA_MODEL_URL = '/maia/maia3/maia3-79m.fp16.onnx';
const MAIA_MOVES_URL = '/maia/maia3/all_moves.json';
const MAIA_CACHE_NAME = 'maia3-model-v1';
const MAIA_MODEL_VERSION = MAIA_MODEL_URL.match(/\/maia(\d+)\//i)?.[1];
export const MAIA_ENGINE_LABEL = `Maia${MAIA_MODEL_VERSION ?? ''}`;

export type MaiaEvaluateParams = { fen: string; eloSelf: number; eloOppo: number; topK: number; playedMoveUci?: string };
type MaiaMoveProbability = { uci: string; probability: number };
export type MaiaEvaluation = {
  winProbability: number;
  moves: MaiaMoveProbability[];
  playedMove: (MaiaMoveProbability & { rank: number }) | null;
};
type MaiaModelFeeds = Record<string, ort.Tensor>;

export type MaiaLoadingStatus = {
  phase: 'downloading'; loadedBytes: number; totalBytes: number; source?: 'cache' | 'network';
} | { phase: 'initializing' };
type MaiaProgressListener = (status: MaiaLoadingStatus) => void;
const progressListeners = new Set<MaiaProgressListener>();
function reportProgress(status: MaiaLoadingStatus) { for (const listener of progressListeners) listener(status); }
export function subscribeMaiaProgress(listener: MaiaProgressListener) {
  progressListeners.add(listener);
  return () => { progressListeners.delete(listener); };
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let allMovesPromise: Promise<Record<string, number>> | null = null;

async function getCachedModel(manifest: { size: number; parts: { file: string; size: number }[] }) {
  const total = manifest.parts.reduce((sum, part) => sum + part.size, 0);
  reportProgress({ phase: 'downloading', loadedBytes: 0, totalBytes: manifest.size, source: 'cache' });
  const cache = 'caches' in globalThis ? await caches.open(MAIA_CACHE_NAME) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (const part of manifest.parts) {
    const url = `/maia/maia3/${part.file}`;
    let response = await cache?.match(url);
    if (response) {
      const saved = await response.arrayBuffer();
      if (saved.byteLength !== part.size) { await cache?.delete(url); response = undefined; }
      else { chunks.push(new Uint8Array(saved)); loaded += part.size; reportProgress({ phase: 'downloading', loadedBytes: loaded, totalBytes: total, source: 'cache' }); }
    }
    if (!response) {
      const networkResponse = await fetch(url);
      if (!networkResponse.ok) throw new Error(`Nie udało się pobrać części modelu: ${part.file} (HTTP ${networkResponse.status})`);
      const bytes = new Uint8Array(await networkResponse.arrayBuffer());
      if (bytes.length !== part.size) throw new Error(`Niekompletna część modelu: ${part.file}`);
      chunks.push(bytes); loaded += bytes.length;
      if (cache) {
        try { await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); }
        catch { reportProgress({ phase: 'downloading', loadedBytes: loaded, totalBytes: total, source: 'network' }); }
      }
      reportProgress({ phase: 'downloading', loadedBytes: loaded, totalBytes: total, source: 'network' });
    }
  }
  const model = new Uint8Array(manifest.size);
  let offset = 0;
  for (const chunk of chunks) { model.set(chunk, offset); offset += chunk.length; }
  return model;
}

function getAllMovesMap() {
  if (!allMovesPromise) {
    allMovesPromise = fetch(MAIA_MOVES_URL)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load Maia-3 move map');
        return response.json() as Promise<Record<string, number>>;
      })
      .catch((error) => { allMovesPromise = null; throw error; });
  }
  return allMovesPromise;
}

function getSession() {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    sessionPromise = fetch(`${MAIA_MODEL_URL}.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to fetch Maia-3 model');
        const manifest = await response.json() as { size: number; parts: { file: string; size: number }[] };
        if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 ||
            !Array.isArray(manifest.parts) || manifest.parts.length === 0 ||
            manifest.parts.some((part) => !Number.isSafeInteger(part.size) || part.size <= 0 || !/^maia3-79m\.fp16\.onnx\.part-\d+$/.test(part.file)) ||
            manifest.parts.reduce((sum, part) => sum + part.size, 0) !== manifest.size) {
          throw new Error('Invalid Maia-3 model manifest');
        }
        return getCachedModel(manifest);
      })
      .then((buffer) => {
        reportProgress({ phase: 'initializing' });
        return ort.InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'basic',
      }); })
      .catch((error) => { sessionPromise = null; throw error; });
  }
  return sessionPromise;
}

export async function initializeMaia() {
  await Promise.all([getSession(), getAllMovesMap()]);
}

function toMoveUci(move: Move) { return `${move.from}${move.to}${move.promotion ?? ''}`; }

function mirrorSquare(square: string) {
  return square.charAt(0) + (9 - Number.parseInt(square.charAt(1), 10)).toString();
}

function mirrorMove(moveUci: string) {
  return `${mirrorSquare(moveUci.slice(0, 2))}${mirrorSquare(moveUci.slice(2, 4))}${moveUci.slice(4)}`;
}

function swapColorsInRank(rank: string) {
  return [...rank].map((char) => /[A-Z]/.test(char) ? char.toLowerCase() : /[a-z]/.test(char) ? char.toUpperCase() : char).join('');
}

function swapCastlingRights(castling: string) {
  if (castling === '-') return '-';
  const rights = new Set(castling.split(''));
  let output = '';
  if (rights.has('k')) output += 'K';
  if (rights.has('q')) output += 'Q';
  if (rights.has('K')) output += 'k';
  if (rights.has('Q')) output += 'q';
  return output || '-';
}

function mirrorFen(fen: string) {
  const [position, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(' ');
  const mirroredPosition = position.split('/').reverse().map(swapColorsInRank).join('/');
  return `${mirroredPosition} ${activeColor === 'w' ? 'b' : 'w'} ${swapCastlingRights(castling)} ${enPassant !== '-' ? mirrorSquare(enPassant) : '-'} ${halfmove} ${fullmove}`;
}

function boardToTokens(fen: string) {
  const pieceTypes = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
  const tokens = new Float32Array(64 * 12);
  const rows = fen.split(' ')[0].split('/');
  // Maia3's square tokens use python-chess's a1=0 indexing. FEN is listed
  // from rank 8 down to rank 1, so its row must be reversed here.
  for (let fenRank = 0; fenRank < 8; fenRank += 1) {
    let file = 0;
    for (const char of rows[fenRank]) {
      const emptyCount = Number.parseInt(char, 10);
      if (Number.isNaN(emptyCount)) {
        const pieceIndex = pieceTypes.indexOf(char);
        const squareIndex = ((7 - fenRank) * 8) + file;
        if (pieceIndex >= 0) tokens[squareIndex * 12 + pieceIndex] = 1;
        file += 1;
      } else file += emptyCount;
    }
  }
  return tokens;
}

function softmax(values: number[]) {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}

export async function evaluateMaiaPosition({ fen, eloSelf, eloOppo, topK, playedMoveUci }: MaiaEvaluateParams): Promise<MaiaEvaluation> {
  const [session, allMovesMap] = await Promise.all([getSession(), getAllMovesMap()]);
  const wasBlackToMove = fen.split(' ')[1] === 'b';
  const normalizedFen = wasBlackToMove ? mirrorFen(fen) : fen;
  const board = new Chess(normalizedFen);
  const legalMoves = board.moves({ verbose: true }) as Move[];
  const mappedMoves = legalMoves.flatMap((move) => {
    const uci = toMoveUci(move);
    const index = allMovesMap[uci];
    return index === undefined ? [] : [{ uci, index }];
  });
  if (!mappedMoves.length) return { winProbability: 0.5, moves: [], playedMove: null };

  const feeds: MaiaModelFeeds = {
    tokens: new ort.Tensor('float32', boardToTokens(normalizedFen), [1, 64, 12]),
    elo_self: new ort.Tensor('float32', Float32Array.of(eloSelf), [1]),
    elo_oppo: new ort.Tensor('float32', Float32Array.of(eloOppo), [1]),
  };
  let outputs: ort.InferenceSession.ReturnType | undefined;
  try {
    outputs = await session.run(feeds);
    const policyLogits = outputs.logits_move.data as Float32Array;
    const valueLogits = outputs.logits_value.data as Float32Array;
    const probabilities = softmax(mappedMoves.map(({ index }) => policyLogits[index]));
    const allMoves = mappedMoves.map(({ uci }, index) => ({
      uci: wasBlackToMove ? mirrorMove(uci) : uci,
      probability: probabilities[index],
    })).sort((a, b) => b.probability - a.probability).slice(0, Math.max(1, topK));
    const playedMoveIndex = playedMoveUci
      ? mappedMoves.findIndex(({ uci }) => (wasBlackToMove ? mirrorMove(uci) : uci) === playedMoveUci)
      : -1;
    const playedMove = playedMoveIndex >= 0
      ? {
          uci: playedMoveUci as string,
          probability: probabilities[playedMoveIndex],
          rank: mappedMoves.reduce((rank, _move, index) => rank + (probabilities[index] > probabilities[playedMoveIndex] ? 1 : 0), 1),
        }
      : null;

    const valueProbs = softmax(Array.from(valueLogits.slice(0, 3)));
    let winProbability = valueProbs[2] + valueProbs[1] / 2;
    if (wasBlackToMove) winProbability = 1 - winProbability;
    return { winProbability, moves: allMoves, playedMove };
  } finally {
    const tensors = new Set<ort.Tensor>(Object.values(feeds));
    for (const output of Object.values(outputs ?? {})) {
      if (output instanceof ort.Tensor) tensors.add(output);
    }
    for (const tensor of tensors) tensor.dispose();
  }
}
