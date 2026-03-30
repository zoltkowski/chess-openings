import { Chess, type Move } from 'chess.js';
import * as ort from 'onnxruntime-web/wasm';

// Load Maia v3 artifacts from local public folder. Place the model and
// moves map under `public/maia/maia3/` in the app so they are served
// statically by the dev/prod server.
const MAIA_MODEL_URL = '/maia/maia3/maia_rapid.onnx';
const MAIA_MOVES_URL = '/maia/maia3/all_moves.json';
const ORT_WASM_CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/';

type MaiaEvaluateParams = {
  fen: string;
  eloSelf: number;
  eloOppo: number;
  topK: number;
};

type MaiaMoveProbability = {
  uci: string;
  probability: number;
};

export type MaiaEvaluation = {
  winProbability: number;
  moves: MaiaMoveProbability[];
};

type MaiaModelFeeds = Record<string, ort.Tensor>;

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let allMovesPromise: Promise<Record<string, number>> | null = null;

function getAllMovesMap() {
  if (!allMovesPromise) {
    allMovesPromise = fetch(MAIA_MOVES_URL)
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load Maia move map');
        return response.json() as Promise<Record<string, number>>;
      })
      .catch((error) => {
        allMovesPromise = null;
        throw error;
      });
  }
  return allMovesPromise;
}

function getSession() {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = ORT_WASM_CDN_PREFIX;
    sessionPromise = fetch(MAIA_MODEL_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to fetch Maia model');
        return response.arrayBuffer();
      })
      .then((buffer) => ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] }))
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  }
  return sessionPromise;
}

function toMoveUci(move: Move) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function mirrorSquare(square: string) {
  const file = square.charAt(0);
  const rank = (9 - Number.parseInt(square.charAt(1), 10)).toString();
  return file + rank;
}

function mirrorMove(moveUci: string) {
  const startSquare = moveUci.slice(0, 2);
  const endSquare = moveUci.slice(2, 4);
  const promotion = moveUci.length > 4 ? moveUci.slice(4) : '';
  return `${mirrorSquare(startSquare)}${mirrorSquare(endSquare)}${promotion}`;
}

function swapColorsInRank(rank: string) {
  let swapped = '';
  for (const char of rank) {
    if (/[A-Z]/.test(char)) swapped += char.toLowerCase();
    else if (/[a-z]/.test(char)) swapped += char.toUpperCase();
    else swapped += char;
  }
  return swapped;
}

function swapCastlingRights(castling: string) {
  if (castling === '-') return '-';
  const rights = new Set(castling.split(''));
  const swapped = new Set<string>();
  if (rights.has('K')) swapped.add('k');
  if (rights.has('Q')) swapped.add('q');
  if (rights.has('k')) swapped.add('K');
  if (rights.has('q')) swapped.add('Q');
  let output = '';
  if (swapped.has('K')) output += 'K';
  if (swapped.has('Q')) output += 'Q';
  if (swapped.has('k')) output += 'k';
  if (swapped.has('q')) output += 'q';
  return output || '-';
}

function mirrorFen(fen: string) {
  const [position, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(' ');
  const mirroredPosition = position
    .split('/')
    .slice()
    .reverse()
    .map((rank) => swapColorsInRank(rank))
    .join('/');
  const mirroredActiveColor = activeColor === 'w' ? 'b' : 'w';
  const mirroredCastling = swapCastlingRights(castling);
  const mirroredEnPassant = enPassant !== '-' ? mirrorSquare(enPassant) : '-';
  return `${mirroredPosition} ${mirroredActiveColor} ${mirroredCastling} ${mirroredEnPassant} ${halfmove} ${fullmove}`;
}

function boardToTensor(fen: string) {
  const [piecePlacement, activeColor, castlingAvailability, enPassantTarget] = fen.split(' ');
  const pieceTypes = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];
  const tensor = new Float32Array((12 + 6) * 8 * 8);
  const rows = piecePlacement.split('/');

  for (let rank = 0; rank < 8; rank += 1) {
    const row = 7 - rank;
    let file = 0;
    for (const char of rows[rank]) {
      const digit = Number.parseInt(char, 10);
      if (Number.isNaN(digit)) {
        const pieceIndex = pieceTypes.indexOf(char);
        if (pieceIndex >= 0) {
          tensor[pieceIndex * 64 + row * 8 + file] = 1;
        }
        file += 1;
      } else {
        file += digit;
      }
    }
  }

  const turnStart = 12 * 64;
  tensor.fill(activeColor === 'w' ? 1 : 0, turnStart, turnStart + 64);

  const castlingFlags = [
    castlingAvailability.includes('K'),
    castlingAvailability.includes('Q'),
    castlingAvailability.includes('k'),
    castlingAvailability.includes('q'),
  ];
  castlingFlags.forEach((enabled, idx) => {
    if (!enabled) return;
    const start = (13 + idx) * 64;
    tensor.fill(1, start, start + 64);
  });

  if (enPassantTarget !== '-') {
    const file = enPassantTarget.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = Number.parseInt(enPassantTarget[1], 10) - 1;
    tensor[17 * 64 + rank * 8 + file] = 1;
  }

  return tensor;
}

function createEloDict() {
  const eloDict: Record<string, number> = { '<1100': 0 };
  let rangeIndex = 1;
  for (let lower = 1100; lower < 2000; lower += 100) {
    eloDict[`${lower}-${lower + 99}`] = rangeIndex;
    rangeIndex += 1;
  }
  eloDict['>=2000'] = rangeIndex;
  return eloDict;
}

const eloDict = createEloDict();

function mapEloCategory(elo: number) {
  if (elo < 1100) return eloDict['<1100'];
  if (elo >= 2000) return eloDict['>=2000'];
  for (let lower = 1100; lower < 2000; lower += 100) {
    if (elo >= lower && elo < lower + 100) return eloDict[`${lower}-${lower + 99}`];
  }
  return eloDict['>=2000'];
}

function softmax(values: number[]) {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}

export async function evaluateMaiaPosition({ fen, eloSelf, eloOppo, topK }: MaiaEvaluateParams): Promise<MaiaEvaluation> {
  const [session, allMovesMap] = await Promise.all([getSession(), getAllMovesMap()]);
  const turn = fen.split(' ')[1];
  const wasBlackToMove = turn === 'b';
  const normalizedFen = wasBlackToMove ? mirrorFen(fen) : fen;
  const board = new Chess(normalizedFen);

  const legalMoveIndices: number[] = [];
  const legalMoveStrings: string[] = [];

  for (const move of board.moves({ verbose: true })) {
    const uci = toMoveUci(move as Move);
    const idx = allMovesMap[uci];
    if (idx === undefined) continue;
    legalMoveIndices.push(idx);
    legalMoveStrings.push(uci);
  }

  if (legalMoveIndices.length === 0) {
    return { winProbability: 0.5, moves: [] };
  }

  const feeds: MaiaModelFeeds = {
    boards: new ort.Tensor('float32', boardToTensor(normalizedFen), [1, 18, 8, 8]),
    elo_self: new ort.Tensor('int64', BigInt64Array.from([BigInt(mapEloCategory(eloSelf))]), [1]),
    elo_oppo: new ort.Tensor('int64', BigInt64Array.from([BigInt(mapEloCategory(eloOppo))]), [1]),
  };

  const outputs = await session.run(feeds);
  const policyLogits = outputs.logits_maia.data as Float32Array;
  const valueLogits = outputs.logits_value.data as Float32Array;

  const legalLogits = legalMoveIndices.map((idx) => policyLogits[idx]);
  const probs = softmax(legalLogits);

  const moves = legalMoveStrings
    .map((uci, index) => ({
      uci: wasBlackToMove ? mirrorMove(uci) : uci,
      probability: probs[index],
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, Math.max(1, topK));

  let winProbability = Math.min(Math.max(valueLogits[0] / 2 + 0.5, 0), 1);
  if (wasBlackToMove) winProbability = 1 - winProbability;

  return {
    winProbability,
    moves,
  };
}

export function isMaiaReady() {
  return sessionPromise !== null;
}
