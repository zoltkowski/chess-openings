import { useEffect, useMemo, useRef, useState, type ChangeEventHandler, type ReactNode } from 'react';
import { Chess, type Move } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { DrawBrushes } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './App.css';

type Side = 'white' | 'black';
type LichessSource = 'lichess' | 'masters' | 'player';
type DateRange = '1m' | '2m' | '3m' | '6m' | '1y' | '3y' | '5y' | '10y' | '20y' | '30y' | '50y' | null;

type MoveNode = {
  id: string;
  parentId: string | null;
  fen: string;
  moveSan: string | null;
  moveUci: string | null;
  children: string[];
};

type MoveTree = {
  rootId: string;
  nodes: Record<string, MoveNode>;
  nextId: number;
};

type EngineLine = {
  multipv: number;
  scoreText: string;
  pv: string;
  bestMove: string;
  evalValue: number;
};

type LichessMove = {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
  averageElo?: number;
};

type LichessResponse = {
  opening?: { eco: string; name: string };
  white: number;
  draws: number;
  black: number;
  moves: LichessMove[];
};

type UndoSnapshot = {
  tree: MoveTree;
  selectedNodeId: string;
};

type TrainingSession = {
  side: Side;
  rootNodeId: string;
  hintRequested: boolean;
  hintVisible: boolean;
  hintMoveUci: string | null;
};

const START_FEN = 'start';
const START_POS_FEN = new Chess().fen();
const FIXED_VARIANT = 'standard';
const FIXED_SOURCE = 'analysis';
const MOVE_THRESHOLD_OPTIONS = [0, 1, 5, 10, 20] as const;
const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const;
const MODES = ['casual', 'rated'] as const;
const RATINGS = [1200, 1400, 1600, 1800, 2000, 2200, 2500];
const FIGURINES: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
};
const ARROW_BRUSHES: DrawBrushes = {
  green: { key: 'g', color: '#15781b', opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
  yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
  greenSoft: { key: 'gs', color: '#15781b', opacity: 0.5, lineWidth: 10 },
  blueSoft: { key: 'bs', color: '#003088', opacity: 0.5, lineWidth: 10 },
  yellowSoft: { key: 'ys', color: '#e68f00', opacity: 0.5, lineWidth: 10 },
};
const ORIENTATION_STORAGE_KEY = 'opening-board-orientation';
const FILTER_SETTINGS_STORAGE_KEY = 'opening-filter-settings';

type PersistedFilterSettings = {
  lichessSource?: LichessSource;
  playerHandle?: string;
  dateRange?: DateRange;
  lichessArrowThreshold?: number;
  engineDepth?: number;
  selectedSpeeds?: string[];
  selectedRatings?: number[];
  selectedModes?: string[];
  showLichessOnTreeMoves?: boolean;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function loadPersistedFilterSettings(): PersistedFilterSettings {
  try {
    const raw = window.localStorage.getItem(FILTER_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedFilterSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function TabIconBase(props: { children: ReactNode; viewBox?: string }) {
  const { children, viewBox = '0 0 24 24' } = props;
  return (
    <svg className="tab-icon" viewBox={viewBox} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function DbIcon() {
  return (
    <TabIconBase>
      <ellipse cx="12" cy="5" rx="7" ry="3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M5 5v5c0 1.7 3.1 3 7 3s7-1.3 7-3V5" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M5 10v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" fill="none" stroke="currentColor" strokeWidth="1.9" />
    </TabIconBase>
  );
}

function ComputerIcon() {
  return (
    <TabIconBase viewBox="0 0 512 512">
      <g transform="translate(64 64)" fill="currentColor">
        <path d="M320,64 L320,320 L64,320 L64,64 L320,64 Z M171.749388,128 L146.817842,128 L99.4840387,256 L121.976629,256 L130.913039,230.977 L187.575039,230.977 L196.319607,256 L220.167172,256 L171.749388,128 Z M260.093778,128 L237.691519,128 L237.691519,256 L260.093778,256 L260.093778,128 Z M159.094727,149.47526 L181.409039,213.333 L137.135039,213.333 L159.094727,149.47526 Z M341.333333,256 L384,256 L384,298.666667 L341.333333,298.666667 L341.333333,256 Z M85.3333333,341.333333 L128,341.333333 L128,384 L85.3333333,384 L85.3333333,341.333333 Z M170.666667,341.333333 L213.333333,341.333333 L213.333333,384 L170.666667,384 L170.666667,341.333333 Z M85.3333333,0 L128,0 L128,42.6666667 L85.3333333,42.6666667 L85.3333333,0 Z M256,341.333333 L298.666667,341.333333 L298.666667,384 L256,384 L256,341.333333 Z M170.666667,0 L213.333333,0 L213.333333,42.6666667 L170.666667,42.6666667 L170.666667,0 Z M256,0 L298.666667,0 L298.666667,42.6666667 L256,42.6666667 L256,0 Z M341.333333,170.666667 L384,170.666667 L384,213.333333 L341.333333,213.333333 L341.333333,170.666667 Z M0,256 L42.6666667,256 L42.6666667,298.666667 L0,298.666667 L0,256 Z M341.333333,85.3333333 L384,85.3333333 L384,128 L341.333333,128 L341.333333,85.3333333 Z M0,170.666667 L42.6666667,170.666667 L42.6666667,213.333333 L0,213.333333 L0,170.666667 Z M0,85.3333333 L42.6666667,85.3333333 L42.6666667,128 L0,128 L0,85.3333333 Z" />
      </g>
    </TabIconBase>
  );
}

function MoveIcon() {
  return (
    <TabIconBase viewBox="0 0 449.279 449.279">
      <path
        fill="currentColor"
        d="M141.303,388.047c1.438-3.317,2.234-6.974,2.234-10.813c0-15.044-12.239-27.284-27.283-27.284h-1.875
	c-4.689-8.688-7.063-17.687-7.063-26.814c0-9.126,2.373-18.125,7.062-26.812h1.876c15.044,0,27.283-12.24,27.283-27.285
	c0-14.548-11.445-26.474-25.805-27.244l9.029-56.346c0.96-5.994-0.812-11.995-4.991-16.896c-5.093-5.975-13.391-9.686-21.654-9.686
	H88.789v-17.396c0-4.971-4.029-9-9-9s-9,4.029-9,9v17.396H59.462c-8.266,0-16.563,3.712-21.657,9.687
	c-4.179,4.902-5.95,10.902-4.989,16.895l9.029,56.346c-14.358,0.772-25.804,12.697-25.804,27.245
	c0,15.044,12.239,27.284,27.284,27.284h0.168c4.689,8.688,7.062,17.686,7.062,26.812c0,9.127-2.372,18.126-7.062,26.814h-0.168
	c-15.045,0-27.284,12.24-27.284,27.285c0,3.838,0.797,7.495,2.233,10.811C7.644,391.776,0,401.914,0,413.805
	c0,15.044,12.239,27.283,27.283,27.283h105.009c15.044,0,27.283-12.239,27.283-27.286
	C159.575,401.914,151.933,391.777,141.303,388.047z M59.462,176.867h40.654c8.872-0.228,8.915,5.464,8.872,5.734l-9.479,59.155
	h-39.44l-9.479-59.155C50.545,182.331,51.64,176.867,59.462,176.867z M43.325,278.325c-5.119,0-9.284-4.165-9.284-9.285
	c0-5.119,4.165-9.284,9.284-9.284h72.929c5.119,0,9.283,4.165,9.283,9.285c0,5.119-4.164,9.284-9.283,9.284H43.325z M94.53,349.951
	H63.341c3.465-8.701,5.214-17.675,5.214-26.814c0-9.139-1.749-18.111-5.214-26.812H94.53c-3.466,8.701-5.214,17.673-5.214,26.812
	C89.316,332.276,91.065,341.25,94.53,349.951z M43.325,367.951h5.165c0.097,0.002,0.195,0.002,0.29,0h60.311
	c0.097,0.002,0.193,0.002,0.292,0h6.871c5.119,0,9.283,4.166,9.283,9.285c0,5.119-4.164,9.283-9.283,9.283H43.325
	c-5.119,0-9.284-4.165-9.284-9.284S38.206,367.951,43.325,367.951z M132.292,423.088H27.283c-5.119,0-9.283-4.165-9.283-9.286
	c0-5.119,4.164-9.284,9.283-9.284h105.009c5.119,0,9.283,4.165,9.283,9.286C141.575,418.923,137.411,423.088,132.292,423.088z
	 M172.457,167.118c3.515,3.515,3.515,9.213-0.001,12.728l-21.651,21.651c-1.758,1.757-4.062,2.636-6.364,2.636
	c-2.304,0-4.606-0.878-6.364-2.636c-3.515-3.515-3.515-9.213,0-12.728l21.652-21.651
	C163.244,163.603,168.941,163.603,172.457,167.118z M350.287,214.223l47.104-47.103c3.517-3.515,9.214-3.515,12.729,0
	c3.515,3.515,3.515,9.213,0,12.728l-47.104,47.104c-1.758,1.757-4.062,2.636-6.364,2.636c-2.304,0-4.606-0.878-6.364-2.636
	C346.772,223.436,346.772,217.737,350.287,214.223z M344.079,193.371c-3.515-3.515-3.515-9.213,0-12.728l18.977-18.977
	c3.515-3.514,9.212-3.516,12.729,0c3.515,3.515,3.515,9.213,0,12.728l-18.977,18.977c-1.758,1.757-4.061,2.636-6.364,2.636
	S345.837,195.128,344.079,193.371z M440.279,8.191H79.789c-4.971,0-9,4.029-9,9v87.369c0,4.971,4.029,9,9,9s9-4.029,9-9V26.191
	h102.164v102.163h-59.666c-4.971,0-9,4.029-9,9s4.029,9,9,9h59.666v102.162h-22.599c-4.971,0-9,4.029-9,9s4.029,9,9,9h22.599V368.68
	h-23.911c-4.971,0-9,4.029-9,9s4.029,9,9,9h273.237c4.971,0,9-4.029,9-9V17.191C449.279,12.221,445.25,8.191,440.279,8.191z
	 M311.116,368.68H208.953V266.517h102.163V368.68z M311.116,248.517H208.953V146.354h102.163V248.517z M311.116,128.354H208.953
	V26.191h102.163V128.354z M431.279,368.68H329.116V266.517h102.163V368.68z M431.279,248.517H329.116V146.354h102.163V248.517z
	 M431.279,128.354H329.116V26.191h102.163V128.354z M296.159,323.914c3.515,3.515,3.515,9.213-0.001,12.728l-18.979,18.977
	c-1.757,1.757-4.061,2.636-6.363,2.636c-2.304,0-4.606-0.878-6.364-2.636c-3.515-3.515-3.515-9.213,0.001-12.728l18.979-18.977
	C286.946,320.399,292.645,320.399,296.159,323.914z M296.159,81.326c3.515,3.515,3.515,9.213,0,12.728l-18.979,18.978
	c-1.758,1.757-4.062,2.636-6.364,2.636c-2.304,0-4.606-0.878-6.364-2.636c-3.515-3.515-3.515-9.213,0.001-12.728l18.978-18.978
	C286.947,77.811,292.645,77.811,296.159,81.326z M416.327,200.698c3.516,3.515,3.516,9.213,0.001,12.728l-18.976,18.978
	c-1.757,1.757-4.061,2.636-6.364,2.636s-4.606-0.878-6.363-2.636c-3.516-3.515-3.516-9.213-0.001-12.728l18.976-18.978
	C407.113,197.184,412.813,197.184,416.327,200.698z M230.116,94.85l47.104-47.104c3.517-3.516,9.214-3.515,12.729,0
	s3.515,9.213,0,12.728l-47.104,47.104c-1.758,1.757-4.062,2.636-6.364,2.636c-2.304,0-4.606-0.878-6.364-2.636
	C226.602,104.063,226.602,98.364,230.116,94.85z M230.116,337.438l47.104-47.104c3.517-3.515,9.214-3.514,12.729,0
	s3.515,9.213,0,12.728l-47.104,47.104c-1.758,1.757-4.062,2.636-6.364,2.636c-2.304,0-4.606-0.878-6.364-2.636
	C226.602,346.651,226.602,340.953,230.116,337.438z M223.908,73.998c-3.515-3.515-3.515-9.213,0-12.728l18.978-18.978
	c3.516-3.515,9.213-3.515,12.729,0c3.515,3.515,3.515,9.213,0,12.728l-18.978,18.978c-1.758,1.757-4.061,2.636-6.364,2.636
	S225.666,75.755,223.908,73.998z M178.664,200.698c3.515,3.515,3.515,9.213,0,12.728l-18.977,18.978
	c-1.758,1.757-4.061,2.636-6.364,2.636s-4.606-0.878-6.364-2.636c-3.515-3.515-3.515-9.213,0-12.728l18.977-18.978
	C169.451,197.184,175.148,197.184,178.664,200.698z M223.908,316.586c-3.515-3.515-3.515-9.213,0-12.728l18.978-18.977
	c3.516-3.515,9.213-3.514,12.729,0c3.515,3.515,3.515,9.213,0,12.728l-18.978,18.977c-1.758,1.757-4.062,2.636-6.364,2.636
	C227.969,319.222,225.666,318.344,223.908,316.586z"
      />
    </TabIconBase>
  );
}

function TrainIcon() {
  return (
    <TabIconBase>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </TabIconBase>
  );
}

function createEmptyTree(side: Side): MoveTree {
  const rootId = `${side}-0`;
  return {
    rootId,
    nextId: 1,
    nodes: {
      [rootId]: {
        id: rootId,
        parentId: null,
        fen: START_FEN,
        moveSan: null,
        moveUci: null,
        children: [],
      },
    },
  };
}

function uciFromMove(move: Move) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function fenToChess(fen: string) {
  return fen === START_FEN ? new Chess() : new Chess(fen);
}

function boardFen(fen: string) {
  return fen === START_FEN ? START_POS_FEN : fen;
}

function createNodeId(tree: MoveTree) {
  return `n-${tree.nextId}`;
}

function insertLine(tree: MoveTree, sanMoves: string[]): MoveTree {
  const nextTree: MoveTree = {
    rootId: tree.rootId,
    nextId: tree.nextId,
    nodes: { ...tree.nodes },
  };

  let currentId = nextTree.rootId;
  const chess = new Chess();

  for (const san of sanMoves) {
    const move = chess.move(san);
    if (!move) break;

    const uci = uciFromMove(move);
    const currentNode = nextTree.nodes[currentId];
    const existingChildId = currentNode.children.find((childId) => nextTree.nodes[childId].moveUci === uci);

    if (existingChildId) {
      currentId = existingChildId;
      continue;
    }

    const nodeId = createNodeId(nextTree);
    nextTree.nextId += 1;

    nextTree.nodes[nodeId] = {
      id: nodeId,
      parentId: currentId,
      fen: chess.fen(),
      moveSan: move.san,
      moveUci: uci,
      children: [],
    };

    nextTree.nodes[currentId] = {
      ...currentNode,
      children: [...currentNode.children, nodeId],
    };

    currentId = nodeId;
  }

  return nextTree;
}

function parsePgnToTree(side: Side, pgn: string): MoveTree {
  const base = createEmptyTree(side);
  const chunks = pgn
    .split(/\r?\n\s*\r?\n/g)
    .map((part) => part.trim())
    .filter(Boolean);

  let tree = base;

  for (const chunk of chunks) {
    const chess = new Chess();
    try {
      chess.loadPgn(chunk, { strict: false });
      const sanMoves = chess.history();
      if (sanMoves.length > 0) {
        tree = insertLine(tree, sanMoves);
      }
    } catch {
      continue;
    }
  }

  return tree;
}

function buildPath(tree: MoveTree, nodeId: string): MoveNode[] {
  const path: MoveNode[] = [];
  let cursor: string | null = nodeId;

  while (cursor) {
    const node: MoveNode | undefined = tree.nodes[cursor];
    if (!node) break;
    path.push(node);
    cursor = node.parentId;
  }

  path.reverse();
  return path;
}

function sanLineToPgn(sanMoves: string[]): string {
  const tokens: string[] = [];

  for (let i = 0; i < sanMoves.length; i += 1) {
    if (i % 2 === 0) {
      tokens.push(`${Math.floor(i / 2) + 1}.`);
    }
    tokens.push(sanMoves[i]);
  }

  return `${tokens.join(' ')} *`;
}

function exportTreeToPgn(tree: MoveTree): string {
  const leafIds = Object.values(tree.nodes)
    .filter((node) => node.id !== tree.rootId && node.children.length === 0)
    .map((node) => node.id);

  const lines = leafIds.map((leafId) => {
    const path = buildPath(tree, leafId);
    const sanMoves = path
      .map((node) => node.moveSan)
      .filter((value): value is string => Boolean(value));
    return sanLineToPgn(sanMoves);
  });

  return lines.join('\n\n');
}

function buildDests(fen: string): Map<Key, Key[]> {
  const chess = fenToChess(fen);
  const map = new Map<Key, Key[]>();

  for (const move of chess.moves({ verbose: true })) {
    const key = move.from as Key;
    const target = move.to as Key;
    const current = map.get(key);
    if (current) {
      current.push(target);
    } else {
      map.set(key, [target]);
    }
  }

  return map;
}

function toTurnColor(fen: string) {
  const chess = fenToChess(fen);
  return chess.turn() === 'w' ? 'white' : 'black';
}

function parseUciMove(uci: string | null): [Key, Key] | undefined {
  if (!uci || uci.length < 4) return undefined;
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
}

function formatPercent(value: number, total: number) {
  if (total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function formatGamesCount(value: number) {
  if (value >= 1_000_000) return `${Math.floor(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.floor(value / 1_000)}k`;
  return `${Math.floor(value)}`;
}

function percentValue(value: number, total: number) {
  if (total <= 0) return 0;
  return (value / total) * 100;
}

function formatAverageElo(move: LichessMove) {
  const raw = move.averageRating ?? move.averageElo;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '';
  return `${Math.round(raw)}`;
}

function normalizeMoveThreshold(value: unknown) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 5;
  return [...MOVE_THRESHOLD_OPTIONS].reduce((best, option) =>
    Math.abs(option - numeric) < Math.abs(best - numeric) ? option : best,
  );
}

function parseLastJsonObject<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some Lichess explorer endpoints can stream multiple JSON snapshots in one response.
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let lastParsed: T | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = text.slice(start, i + 1);
        try {
          lastParsed = JSON.parse(chunk) as T;
        } catch {
          // Ignore malformed chunk and continue.
        }
        start = -1;
      }
    }
  }

  return lastParsed;
}

function extractJsonObjects<T>(raw: string): { objects: T[]; rest: string } {
  if (!raw) return { objects: [], rest: '' };

  const objects: T[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let lastEnd = -1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = raw.slice(start, i + 1);
        try {
          objects.push(JSON.parse(chunk) as T);
          lastEnd = i + 1;
        } catch {
          // Ignore malformed chunk and continue scanning.
        }
        start = -1;
      }
    }
  }

  const rest =
    depth > 0 && start >= 0
      ? raw.slice(start)
      : lastEnd >= 0
        ? raw.slice(lastEnd)
        : raw.length > 16_384
          ? raw.slice(-8192)
          : raw;

  return { objects, rest };
}

function toFigurineSan(san: string) {
  return san
    .trim()
    .replace(/[!?+#]+/g, '')
    .replace(/^[KQRBN]/, (piece) => FIGURINES[piece] ?? piece)
    .replace(/=([KQRBN])/g, (_match, piece: string) => `=${FIGURINES[piece] ?? piece}`);
}

function uciToFigurineSan(fen: string, uci: string) {
  if (!uci || uci.length < 4) return '';
  const chess = fenToChess(fen);
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
    });
    if (!move) return uci;
    return toFigurineSan(move.san);
  } catch {
    return uci;
  }
}

function pvToFigurineSan(fen: string, pv: string, maxMoves = 8) {
  const chess = fenToChess(fen);
  const parts = pv.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const uci of parts) {
    if (!/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(uci)) continue;
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined,
      });
      if (!move) break;
      out.push(toFigurineSan(move.san));
    } catch {
      break;
    }
    if (out.length >= maxMoves) break;
  }
  return out.join(' ');
}

function softenOverlappingArrows(arrows: DrawShape[]): DrawShape[] {
  const byOrig = new Map<Key, number>();
  for (const arrow of arrows) {
    byOrig.set(arrow.orig, (byOrig.get(arrow.orig) ?? 0) + 1);
  }

  return arrows.map((arrow) => {
    if ((byOrig.get(arrow.orig) ?? 0) < 2) return arrow;
    if (arrow.brush === 'green') return { ...arrow, brush: 'greenSoft' };
    if (arrow.brush === 'blue') return { ...arrow, brush: 'blueSoft' };
    if (arrow.brush === 'yellow') return { ...arrow, brush: 'yellowSoft' };
    return arrow;
  });
}

function removeBranch(tree: MoveTree, branchRootId: string): MoveTree {
  const branchRoot = tree.nodes[branchRootId];
  if (!branchRoot || !branchRoot.parentId) return tree;

  const nextNodes: Record<string, MoveNode> = { ...tree.nodes };
  const queue = [branchRootId];

  while (queue.length > 0) {
    const nodeId = queue.pop() as string;
    const node = nextNodes[nodeId];
    if (!node) continue;
    queue.push(...node.children);
    delete nextNodes[nodeId];
  }

  const parent = nextNodes[branchRoot.parentId];
  if (parent) {
    nextNodes[parent.id] = {
      ...parent,
      children: parent.children.filter((id) => id !== branchRootId),
    };
  }

  return { ...tree, nodes: nextNodes };
}

function LichessStatsBar(props: { white: number; draws: number; black: number; total: number }) {
  const { white, draws, black, total } = props;
  const whitePct = percentValue(white, total);
  const drawsPct = percentValue(draws, total);
  const blackPct = percentValue(black, total);

  const label = (pct: number) => (pct >= 8 ? `${Math.round(pct)}%` : '');

  return (
    <div className="stats-bar" aria-label="Lichess outcome distribution">
      <span className="seg seg-white" style={{ flexGrow: whitePct, flexBasis: 0 }}>
        {label(whitePct)}
      </span>
      <span className="seg seg-draw" style={{ flexGrow: drawsPct, flexBasis: 0 }}>
        {label(drawsPct)}
      </span>
      <span className="seg seg-black" style={{ flexGrow: blackPct, flexBasis: 0 }}>
        {label(blackPct)}
      </span>
    </div>
  );
}

function Board(props: {
  fen: string;
  orientation: 'white' | 'black';
  lastMove: [Key, Key] | undefined;
  arrows: DrawShape[];
  onMove: (orig: Key, dest: Key) => void;
}) {
  const { fen, orientation, lastMove, arrows, onMove } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ChessgroundApi | null>(null);
  const onMoveRef = useRef(onMove);

  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!containerRef.current) return;

    apiRef.current = Chessground(containerRef.current, {
      blockTouchScroll: true,
      movable: {
        color: 'both',
        free: true,
        events: {
          after: (orig, dest) => onMoveRef.current(orig, dest),
        },
      },
    });

    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, []);

  useEffect(() => {
    apiRef.current?.set({
      fen: boardFen(fen),
      orientation,
      turnColor: toTurnColor(fen),
      blockTouchScroll: true,
      movable: {
        color: 'both',
        free: false,
        dests: buildDests(fen),
        events: {
          after: (orig, dest) => onMove(orig, dest),
        },
      },
      drawable: {
        enabled: true,
        visible: true,
        autoShapes: arrows,
        brushes: ARROW_BRUSHES,
      },
      lastMove,
    });
  }, [fen, orientation, arrows, lastMove, onMove]);

  return <div ref={containerRef} className="board" />;
}

function App() {
  const [persistedFilterSettings] = useState<PersistedFilterSettings>(() => loadPersistedFilterSettings());
  const initialLichessSource: LichessSource =
    persistedFilterSettings.lichessSource === 'masters' || persistedFilterSettings.lichessSource === 'player'
      ? persistedFilterSettings.lichessSource
      : 'lichess';
  const initialPlayerHandle =
    typeof persistedFilterSettings.playerHandle === 'string' ? persistedFilterSettings.playerHandle : '';
  const initialDateRange: DateRange =
    persistedFilterSettings.dateRange === '1m' ||
    persistedFilterSettings.dateRange === '2m' ||
    persistedFilterSettings.dateRange === '3m' ||
    persistedFilterSettings.dateRange === '6m' ||
    persistedFilterSettings.dateRange === '1y' ||
    persistedFilterSettings.dateRange === '5y' ||
    persistedFilterSettings.dateRange === '10y' ||
    persistedFilterSettings.dateRange === '20y' ||
    persistedFilterSettings.dateRange === '30y' ||
    persistedFilterSettings.dateRange === '50y' ||
    persistedFilterSettings.dateRange === '3y'
      ? persistedFilterSettings.dateRange
      : null;
  const initialLichessArrowThreshold = normalizeMoveThreshold(
    clampInt(persistedFilterSettings.lichessArrowThreshold, 0, 100, 5),
  );
  const initialEngineDepth = clampInt(persistedFilterSettings.engineDepth, 16, 32, 24);
  const initialSelectedSpeeds = (persistedFilterSettings.selectedSpeeds ?? []).filter((speed): speed is string =>
    SPEEDS.includes(speed as (typeof SPEEDS)[number]),
  );
  const initialSelectedRatings = (persistedFilterSettings.selectedRatings ?? []).filter((rating): rating is number =>
    RATINGS.includes(rating),
  );
  const initialSelectedModes = (persistedFilterSettings.selectedModes ?? []).filter((mode): mode is string =>
    MODES.includes(mode as (typeof MODES)[number]),
  );

  const [trees, setTrees] = useState<Record<Side, MoveTree>>({
    white: createEmptyTree('white'),
    black: createEmptyTree('black'),
  });
  const [selectedNodeBySide, setSelectedNodeBySide] = useState<Record<Side, string>>({
    white: 'white-0',
    black: 'black-0',
  });
  const [orientation, setOrientation] = useState<'white' | 'black'>(() => {
    try {
      const value = window.localStorage.getItem(ORIENTATION_STORAGE_KEY);
      return value === 'black' ? 'black' : 'white';
    } catch {
      return 'white';
    }
  });
  const [status, setStatus] = useState('Ready');
  const [engineDepth, setEngineDepth] = useState(initialEngineDepth);
  const [engineMultiPv, setEngineMultiPv] = useState(3);
  const [showStockfishArrows, setShowStockfishArrows] = useState(true);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [engineStatus, setEngineStatus] = useState('stopped');
  const [engineRunning, setEngineRunning] = useState(false);
  const [lichessData, setLichessData] = useState<LichessResponse | null>(null);
  const [lichessStatus, setLichessStatus] = useState('idle');
  const [showTreeArrows, setShowTreeArrows] = useState(true);
  const [showLichessArrows, setShowLichessArrows] = useState(true);
  const [showLichessOnTreeMoves, setShowLichessOnTreeMoves] = useState(
    persistedFilterSettings.showLichessOnTreeMoves ?? true,
  );
  const [isLichessFilterOpen, setIsLichessFilterOpen] = useState(false);
  const [lichessSource, setLichessSource] = useState<LichessSource>(initialLichessSource);
  const [playerHandle, setPlayerHandle] = useState(initialPlayerHandle);
  const [dateRange, setDateRange] = useState<DateRange>(initialDateRange);
  const [lichessArrowThreshold, setLichessArrowThreshold] = useState(initialLichessArrowThreshold);
  const [selectedSpeeds, setSelectedSpeeds] = useState<string[]>(
    initialSelectedSpeeds.length > 0 ? initialSelectedSpeeds : [...SPEEDS],
  );
  const [selectedRatings, setSelectedRatings] = useState<number[]>(
    initialSelectedRatings.length > 0 ? initialSelectedRatings : [1600, 1800, 2000, 2200],
  );
  const [selectedModes, setSelectedModes] = useState<string[]>(
    initialSelectedModes.length > 0 ? initialSelectedModes : [...MODES],
  );
  const [undoStackBySide, setUndoStackBySide] = useState<Record<Side, UndoSnapshot[]>>({
    white: [],
    black: [],
  });
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [portraitTab, setPortraitTab] = useState<'lichess' | 'stockfish' | 'moves'>('moves');
  const [trainingSession, setTrainingSession] = useState<TrainingSession | null>(null);

  const stockfishRef = useRef<Worker | null>(null);
  const engineReadyRef = useRef(false);
  const isSearchingRef = useRef(false);
  const engineRunningRef = useRef(false);
  const pendingAnalysisRef = useRef<{ fen: string; depth: number; multipv: number } | null>(null);
  const tryStartPendingRef = useRef<(() => void) | null>(null);
  const currentAnalysisRef = useRef(0);
  const lineCacheRef = useRef<Map<number, EngineLine>>(new Map());
  const previousFenRef = useRef<string>(START_FEN);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [engineReadyTick, setEngineReadyTick] = useState(0);

  const activeSide: Side = orientation;
  const tree = trees[activeSide];
  const selectedNodeId = selectedNodeBySide[activeSide] ?? tree.rootId;
  const selectedNode = tree.nodes[selectedNodeId] ?? tree.nodes[tree.rootId];
  const trainingForActive = trainingSession?.side === activeSide;

  const path = useMemo(() => buildPath(tree, selectedNode.id), [tree, selectedNode.id]);

  const childNodes = useMemo(
    () => selectedNode.children.map((id) => tree.nodes[id]).filter(Boolean),
    [selectedNode.children, tree.nodes],
  );

  const autoArrows = useMemo<DrawShape[]>(() => {
    const treeArrows = showTreeArrows
      ? childNodes
          .map((node) => parseUciMove(node.moveUci))
          .filter((value): value is [Key, Key] => Boolean(value))
          .map(([orig, dest]) => ({ orig, dest, brush: 'green' }))
      : [];

    const treeChildUcis = new Set(
      childNodes.map((node) => node.moveUci).filter((uci): uci is string => Boolean(uci)),
    );

    const positionGames = (lichessData?.white ?? 0) + (lichessData?.draws ?? 0) + (lichessData?.black ?? 0);
    const thresholdShare = lichessArrowThreshold / 100;
    const lichessArrows =
      showLichessArrows && positionGames > 0
        ? (() => {
            const candidates = (lichessData?.moves ?? [])
              .filter((move) => showLichessOnTreeMoves || !treeChildUcis.has(move.uci))
              .map((move) => {
                const moveGames = move.white + move.draws + move.black;
                const share = moveGames / positionGames;
                const keyPair = parseUciMove(move.uci);
                return { share, keyPair };
              })
              .filter((entry) => entry.share >= thresholdShare && Boolean(entry.keyPair));

            if (candidates.length === 0) return [];

            const maxShare = Math.max(...candidates.map((item) => item.share), 0);
            const maxLineWidth = 18;

            return candidates.map((entry) => {
              const [orig, dest] = entry.keyPair as [Key, Key];
              const ratio = maxShare > 0 ? entry.share / maxShare : 1;
              const lineWidth = maxLineWidth * ratio;
              return {
                orig,
                dest,
                brush: 'yellow',
                modifiers: { lineWidth },
              } as DrawShape;
            });
          })()
        : [];

    const engineArrows =
      showStockfishArrows && engineLines.length > 0
        ? (() => {
            const candidates = engineLines
              .map((line) => {
                const keyPair = parseUciMove(line.bestMove);
                return keyPair ? { keyPair, evalValue: line.evalValue } : null;
              })
              .filter((entry): entry is { keyPair: [Key, Key]; evalValue: number } => Boolean(entry));

            if (candidates.length === 0) return [];

            const minLineWidth = 6;
            const maxLineWidth = 18;
            const topEval = engineLines[0]?.evalValue ?? candidates[0].evalValue;

            return candidates.map((entry) => {
              const [orig, dest] = entry.keyPair;
              const diff = Math.max(0, topEval - entry.evalValue);
              const severity = Math.min(diff / 100, 1);
              const normalized = candidates.length === 1 ? 1 : 1 - severity;
              const isClearlyWorse = diff > 100;
              return {
                orig,
                dest,
                brush: isClearlyWorse ? 'red' : 'blue',
                modifiers: { lineWidth: minLineWidth + normalized * (maxLineWidth - minLineWidth) },
              } as DrawShape;
            });
          })()
        : [];

    return softenOverlappingArrows([...treeArrows, ...lichessArrows, ...engineArrows]);
  }, [
    childNodes,
    showTreeArrows,
    lichessData,
    lichessArrowThreshold,
    engineLines,
    showLichessArrows,
    showStockfishArrows,
    showLichessOnTreeMoves,
  ]);

  const lastMove = parseUciMove(selectedNode.moveUci);

  useEffect(() => {
    try {
      window.localStorage.setItem(ORIENTATION_STORAGE_KEY, orientation);
    } catch {
      // Ignore storage write errors.
    }
  }, [orientation]);

  useEffect(() => {
    try {
      const payload: PersistedFilterSettings = {
        lichessSource,
        playerHandle,
        dateRange,
        lichessArrowThreshold,
        engineDepth,
        selectedSpeeds,
        selectedRatings,
        selectedModes,
        showLichessOnTreeMoves,
      };
      window.localStorage.setItem(FILTER_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage write errors.
    }
  }, [
    lichessSource,
    playerHandle,
    dateRange,
    lichessArrowThreshold,
    engineDepth,
    selectedSpeeds,
    selectedRatings,
    selectedModes,
    showLichessOnTreeMoves,
  ]);

  useEffect(() => {
    const loadBooks = async () => {
      setStatus('Loading PGN books...');
      try {
        const whiteTree = createEmptyTree('white');
        const blackTree = createEmptyTree('black');

        setTrees({ white: whiteTree, black: blackTree });
        setSelectedNodeBySide({ white: whiteTree.rootId, black: blackTree.rootId });
        setUndoStackBySide({ white: [], black: [] });
        setStatus('Ready');
      } catch {
        setStatus('Failed to load books');
      }
    };

    loadBooks();
  }, []);

  useEffect(() => {
    engineRunningRef.current = engineRunning;
  }, [engineRunning]);

  useEffect(() => {
    const worker = new Worker('/stockfish/stockfish-18-lite-single.js');
    stockfishRef.current = worker;
    isSearchingRef.current = false;
    pendingAnalysisRef.current = null;

    tryStartPendingRef.current = () => {
      const w = stockfishRef.current;
      if (!w || !engineReadyRef.current || !engineRunningRef.current) return;
      if (isSearchingRef.current) {
        w.postMessage('stop');
        return;
      }
      const pending = pendingAnalysisRef.current;
      if (!pending) return;

      pendingAnalysisRef.current = null;
      lineCacheRef.current = new Map();
      setEngineLines([]);
      setEngineStatus('analyzing');
      w.postMessage(`setoption name MultiPV value ${pending.multipv}`);
      w.postMessage(`position fen ${pending.fen}`);
      w.postMessage(`go depth ${pending.depth}`);
      isSearchingRef.current = true;
    };

    worker.onmessage = (event: MessageEvent<string>) => {
      const text = String(event.data || '');

      if (text === 'uciok') {
        worker.postMessage('isready');
        return;
      }

      if (text === 'readyok') {
        engineReadyRef.current = true;
        setEngineReadyTick((prev) => prev + 1);
        setEngineStatus((prev) => (prev === 'stopped' ? prev : 'idle'));
        tryStartPendingRef.current?.();
        return;
      }

      if (text.startsWith('info ') && text.includes(' pv ') && text.includes(' multipv ')) {
        const multipvMatch = text.match(/ multipv (\d+)/);
        const cpMatch = text.match(/ score cp (-?\d+)/);
        const mateMatch = text.match(/ score mate (-?\d+)/);
        const pvMatch = text.match(/ pv (.+)$/);

        if (!multipvMatch || !pvMatch) return;

        const multipv = Number(multipvMatch[1]);
        const pv = pvMatch[1].trim();
        const bestMove = pv.split(' ')[0] || '';
        const scoreText = cpMatch
          ? `${(Number(cpMatch[1]) / 100).toFixed(2)}`
          : mateMatch
            ? `M${mateMatch[1]}`
            : '?';
        const evalValue = cpMatch
          ? Number(cpMatch[1])
          : mateMatch
            ? Number(mateMatch[1]) * 100000
            : 0;

        lineCacheRef.current.set(multipv, { multipv, scoreText, pv, bestMove, evalValue });
        setEngineLines(Array.from(lineCacheRef.current.values()).sort((a, b) => a.multipv - b.multipv));
        return;
      }

      if (text.startsWith('bestmove')) {
        isSearchingRef.current = false;
        setEngineStatus('done');
        tryStartPendingRef.current?.();
      }
    };

    worker.postMessage('uci');

    return () => {
      tryStartPendingRef.current = null;
      worker.terminate();
      stockfishRef.current = null;
      engineReadyRef.current = false;
      isSearchingRef.current = false;
      pendingAnalysisRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!stockfishRef.current || !engineReadyRef.current) return;
    if (!engineRunning) {
      pendingAnalysisRef.current = null;
      isSearchingRef.current = false;
      stockfishRef.current.postMessage('stop');
      setEngineStatus('stopped');
      return;
    }

    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
    const analysisId = currentAnalysisRef.current + 1;
    currentAnalysisRef.current = analysisId;
    pendingAnalysisRef.current = { fen, depth: engineDepth, multipv: engineMultiPv };
    tryStartPendingRef.current?.();
  }, [selectedNode.fen, engineDepth, engineRunning, engineMultiPv, engineReadyTick]);

  useEffect(() => {
    const fenChanged = previousFenRef.current !== selectedNode.fen;
    if (!engineRunning && fenChanged) {
      setEngineLines([]);
      lineCacheRef.current = new Map();
    }
    previousFenRef.current = selectedNode.fen;
  }, [selectedNode.fen, engineRunning]);

  useEffect(() => {
    const controller = new AbortController();
    const isPlayerWithoutHandle = lichessSource === 'player' && playerHandle.trim().length === 0;

    if (isPlayerWithoutHandle) {
      setLichessData(null);
      setLichessStatus('idle');
      return () => {
        controller.abort();
      };
    }

    setLichessStatus('loading');

    const run = async () => {
      const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
      const params = new URLSearchParams({
        fen,
        variant: FIXED_VARIANT,
      });
      params.set('color', activeSide);
      if (lichessSource === 'lichess' || lichessSource === 'player') {
        if (selectedSpeeds.length) params.set('speeds', selectedSpeeds.join(','));
      }
      if (lichessSource === 'lichess') {
        if (selectedRatings.length) params.set('ratings', selectedRatings.join(','));
      }
      if (lichessSource === 'player') {
        params.set('player', playerHandle.trim());
        params.set('play', '');
        params.set('modes', (selectedModes.length > 0 ? selectedModes : [...MODES]).join(','));
        params.set('source', FIXED_SOURCE);
      }

      const normalizedDateRange: DateRange =
        lichessSource === 'player'
          ? dateRange === '5y' ||
            dateRange === '10y' ||
            dateRange === '20y' ||
            dateRange === '30y' ||
            dateRange === '50y'
            ? null
            : dateRange
          : lichessSource === 'masters'
            ? dateRange === '1m' || dateRange === '2m' || dateRange === '3m' || dateRange === '6m'
              ? null
              : dateRange
            : dateRange === '1m' ||
                dateRange === '2m' ||
                dateRange === '3m' ||
                dateRange === '6m' ||
                dateRange === '20y' ||
                dateRange === '30y' ||
                dateRange === '50y'
            ? null
            : dateRange;
      const effectiveDateRange: DateRange = normalizedDateRange;
      if (effectiveDateRange) {
        const now = new Date();
        const sinceDate = new Date(now);
        if (effectiveDateRange === '1m') {
          sinceDate.setMonth(now.getMonth());
        } else if (effectiveDateRange === '2m') {
          sinceDate.setMonth(now.getMonth() - 1);
        } else if (effectiveDateRange === '3m') {
          sinceDate.setMonth(now.getMonth() - 2);
        } else if (effectiveDateRange === '6m') {
          sinceDate.setMonth(now.getMonth() - 5);
        } else if (effectiveDateRange === '1y') {
          sinceDate.setFullYear(now.getFullYear() - 1);
        } else if (effectiveDateRange === '5y') {
          sinceDate.setFullYear(now.getFullYear() - 5);
        } else if (effectiveDateRange === '10y') {
          sinceDate.setFullYear(now.getFullYear() - 10);
        } else if (effectiveDateRange === '20y') {
          sinceDate.setFullYear(now.getFullYear() - 20);
        } else if (effectiveDateRange === '30y') {
          sinceDate.setFullYear(now.getFullYear() - 30);
        } else if (effectiveDateRange === '50y') {
          sinceDate.setFullYear(now.getFullYear() - 50);
        } else {
          sinceDate.setFullYear(now.getFullYear() - 3);
        }
        const since =
          lichessSource === 'masters'
            ? `${sinceDate.getFullYear()}`
            : `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}`;
        const until =
          lichessSource === 'masters'
            ? `${now.getFullYear()}`
            : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        params.set('since', since);
        params.set('until', until);
      }

      const endpoint = lichessSource === 'player' ? 'player' : lichessSource;
      const url = `https://explorer.lichess.ovh/${endpoint}?${params.toString()}`;

      const requestTimeoutMs = 120000;
      const idleTimeoutMs = 20000;
      let abortedByIdle = false;
      const requestTimeout = window.setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }, requestTimeoutMs);
      let idleTimeout = window.setTimeout(() => {
        if (!controller.signal.aborted) {
          abortedByIdle = true;
          controller.abort();
        }
      }, idleTimeoutMs);
      const resetIdleTimeout = () => {
        window.clearTimeout(idleTimeout);
        idleTimeout = window.setTimeout(() => {
          if (!controller.signal.aborted) {
            abortedByIdle = true;
            controller.abort();
          }
        }, idleTimeoutMs);
      };

      let latestData: LichessResponse | null = null;
      try {
        const res = await fetch(url, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Lichess request failed');
        const body = res.body;
        if (body) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          resetIdleTimeout();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdleTimeout();
            buffer += decoder.decode(value, { stream: true });
            const parsed = extractJsonObjects<LichessResponse>(buffer);
            buffer = parsed.rest;
            if (parsed.objects.length > 0) {
              latestData = parsed.objects[parsed.objects.length - 1];
              setLichessData(latestData);
            }
          }

          buffer += decoder.decode();
          if (!latestData) {
            const data = parseLastJsonObject<LichessResponse>(buffer);
            if (data) {
              latestData = data;
              setLichessData(data);
            }
          }
        } else {
          const rawBody = await res.text();
          const data = parseLastJsonObject<LichessResponse>(rawBody);
          if (data) {
            latestData = data;
            setLichessData(data);
          }
        }

        if (!latestData) throw new Error('Invalid Lichess payload');
        setLichessStatus('done');
      } catch {
        if (controller.signal.aborted && abortedByIdle && latestData) {
          setLichessStatus('done');
        } else if (!controller.signal.aborted) {
          setLichessStatus('error');
        } else {
          setLichessStatus('error');
        }
      } finally {
        window.clearTimeout(requestTimeout);
        window.clearTimeout(idleTimeout);
      }
    };

    const timeout = window.setTimeout(run, 280);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    selectedNode.fen,
    selectedSpeeds,
    selectedRatings,
    selectedModes,
    dateRange,
    lichessSource,
    playerHandle,
    activeSide,
  ]);

  const clearTrainingHint = () => {
    setTrainingSession((prev) =>
      prev ? { ...prev, hintRequested: false, hintVisible: false, hintMoveUci: null } : prev,
    );
  };

  const advanceTrainingPosition = (side: Side, rootNodeId: string, startNodeId: string) => {
    const sideTree = trees[side];
    const rootNode = sideTree.nodes[rootNodeId];
    if (!rootNode) return;

    let cursorId = startNodeId;
    const maxSteps = 256;
    for (let step = 0; step < maxSteps; step += 1) {
      const cursor = sideTree.nodes[cursorId] ?? rootNode;
      if (cursor.children.length === 0) {
        break;
      }

      if (toTurnColor(cursor.fen) === side) break;
      const randomChildId = cursor.children[Math.floor(Math.random() * cursor.children.length)];
      cursorId = randomChildId;
    }

    setSelectedNodeBySide((prev) => ({ ...prev, [side]: cursorId }));
    clearTrainingHint();
  };

  const startTraining = () => {
    const side = activeSide;
    const rootNodeId = selectedNode.id;
    setTrainingSession({ side, rootNodeId, hintRequested: false, hintVisible: false, hintMoveUci: null });
    advanceTrainingPosition(side, rootNodeId, rootNodeId);
    setPortraitTab('moves');
  };

  const stopTraining = () => {
    setTrainingSession(null);
  };

  const restartTrainingLine = () => {
    if (!trainingSession) return;
    clearTrainingHint();
    advanceTrainingPosition(trainingSession.side, trainingSession.rootNodeId, trainingSession.rootNodeId);
  };

  useEffect(() => {
    if (!trainingSession) return;
    if (orientation !== trainingSession.side) {
      setTrainingSession(null);
      return;
    }
    if (!trees[trainingSession.side].nodes[trainingSession.rootNodeId]) {
      setTrainingSession(null);
    }
  }, [orientation, trainingSession, trees]);

  const makeMove = (orig: Key, dest: Key, promotion: 'q' | 'r' | 'b' | 'n' = 'q') => {
    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
    const chess = fenToChess(currentNode.fen);
    const move = chess.move({ from: orig, to: dest, promotion });

    if (!move) return;

    const uci = uciFromMove(move);
    const existingChildId = currentNode.children.find((id) => currentTree.nodes[id].moveUci === uci);

    if (trainingSession && trainingSession.side === activeSide) {
      if (currentNode.children.length === 0) return;
      if (toTurnColor(currentNode.fen) !== activeSide) return;

      if (!existingChildId) {
        const hintChildId = currentNode.children[Math.floor(Math.random() * currentNode.children.length)];
        const hintMoveUci = hintChildId ? currentTree.nodes[hintChildId]?.moveUci ?? null : null;
        setTrainingSession((prev) =>
          prev && prev.side === activeSide
            ? {
                ...prev,
                hintRequested: true,
                hintVisible: false,
                hintMoveUci,
              }
            : prev,
        );
        return;
      }

      clearTrainingHint();
      advanceTrainingPosition(activeSide, trainingSession.rootNodeId, existingChildId);
      return;
    }

    let nextTree = currentTree;
    let nextNodeId = existingChildId;

    if (!existingChildId) {
      const nodeId = createNodeId(currentTree);
      const newNode: MoveNode = {
        id: nodeId,
        parentId: currentNode.id,
        fen: chess.fen(),
        moveSan: move.san,
        moveUci: uci,
        children: [],
      };

      nextTree = {
        ...currentTree,
        nextId: currentTree.nextId + 1,
        nodes: {
          ...currentTree.nodes,
          [nodeId]: newNode,
          [currentNode.id]: {
            ...currentNode,
            children: [...currentNode.children, nodeId],
          },
        },
      };
      nextNodeId = nodeId;
    }

    if (!nextNodeId || nextNodeId === currentSelectedId) return;

    setUndoStackBySide((prev) => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree: currentTree, selectedNodeId: currentSelectedId }].slice(-200),
    }));
    setTrees((prev) => ({
      ...prev,
      [activeSide]: nextTree,
    }));
    setSelectedNodeBySide((prev) => ({
      ...prev,
      [activeSide]: nextNodeId as string,
    }));
  };

  const playLichessMove = (uci: string) => {
    if (isTrainingActive) return;
    const keyPair = parseUciMove(uci);
    if (!keyPair) return;
    const promotionChar = (uci[4] ?? 'q').toLowerCase();
    const promotion: 'q' | 'r' | 'b' | 'n' = ['q', 'r', 'b', 'n'].includes(promotionChar)
      ? (promotionChar as 'q' | 'r' | 'b' | 'n')
      : 'q';
    makeMove(keyPair[0], keyPair[1], promotion);
  };

  const playStockfishMove = (uci: string) => {
    if (isTrainingActive) return;
    playLichessMove(uci);
  };

  const exportPgn = () => {
    const pgn = exportTreeToPgn(tree);
    const blob = new Blob([pgn], { type: 'application/x-chess-pgn;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeSide}.pgn`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const openImportDialog = () => {
    importInputRef.current?.click();
  };

  const openInLichessAnalysis = () => {
    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
    const url = `https://lichess.org/analysis?fen=${encodeURIComponent(fen)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const importPgn: ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const pgn = await file.text();
      const nextTree = parsePgnToTree(activeSide, pgn);
      setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
      setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: nextTree.rootId }));
      setUndoStackBySide((prev) => ({ ...prev, [activeSide]: [] }));
      setStatus(`Imported ${activeSide} PGN`);
    } catch {
      setStatus('Import failed');
    } finally {
      event.target.value = '';
    }
  };

  const lichessTotal = (lichessData?.white ?? 0) + (lichessData?.draws ?? 0) + (lichessData?.black ?? 0);
  const isTrainingActive = Boolean(trainingSession && trainingSession.side === activeSide);
  const showHintButton = Boolean(isTrainingActive && trainingSession?.hintRequested);
  const canStartTraining = childNodes.length > 0;
  const isTrainingLineEnd = Boolean(isTrainingActive && childNodes.length === 0);
  const trainingHintArrow = useMemo<DrawShape[]>(() => {
    if (!isTrainingActive || !trainingSession?.hintVisible || !trainingSession.hintMoveUci) return [];
    const keyPair = parseUciMove(trainingSession.hintMoveUci);
    if (!keyPair) return [];
    const [orig, dest] = keyPair;
    return [{ orig, dest, brush: 'green' }];
  }, [isTrainingActive, trainingSession]);
  const canGoBack = Boolean(selectedNode.parentId);
  const visibleTopStatus = status === 'Ready' ? '' : status;
  const visibleEngineStatus =
    engineStatus === 'done' || engineStatus === 'stopped' || engineStatus === 'analyzing' ? '' : engineStatus;
  const visibleLichessStatus = lichessStatus === 'done' || lichessStatus === 'idle' ? '' : lichessStatus;
  const openingFullTitle = lichessData?.opening ? `${lichessData.opening.eco} ${lichessData.opening.name}` : '';
  const openingTitleContent = useMemo(() => {
    if (!lichessData?.opening) return '';
    const { eco, name } = lichessData.opening;
    const colonIndex = name.indexOf(':');
    if (colonIndex < 0) return `${eco} ${name}`;
    const firstLine = `${eco} ${name.slice(0, colonIndex + 1).trim()}`;
    const secondLine = name.slice(colonIndex + 1).trim();
    if (!secondLine) return firstLine;
    return (
      <>
        {firstLine}
        <br />
        {secondLine}
      </>
    );
  }, [lichessData]);
  const filteredLichessMoves = useMemo(() => {
    if (!lichessData?.moves || lichessTotal <= 0) return [];
    const thresholdShare = lichessArrowThreshold / 100;
    return lichessData.moves.filter((move) => {
      const total = move.white + move.draws + move.black;
      return total / lichessTotal >= thresholdShare;
    });
  }, [lichessData, lichessTotal, lichessArrowThreshold]);
  const inlineMoves = useMemo(
    () =>
      path.slice(1).map((node, index) => ({
        id: node.id,
        san: toFigurineSan(node.moveSan ?? ''),
        prefix: index % 2 === 0 ? `${Math.floor(index / 2) + 1}.` : '',
        hasAlternatives: (node.children?.length ?? 0) > 1,
      })),
    [path],
  );

  const optionRows = useMemo(() => {
    const leafMemo = new Map<string, number>();
    const countLeaves = (nodeId: string): number => {
      const cached = leafMemo.get(nodeId);
      if (cached !== undefined) return cached;
      const node = tree.nodes[nodeId];
      if (!node) return 0;
      if (node.children.length === 0) {
        leafMemo.set(nodeId, 1);
        return 1;
      }
      const total = node.children.reduce((acc, childId) => acc + countLeaves(childId), 0);
      leafMemo.set(nodeId, total);
      return total;
    };

    return childNodes
      .map((node) => ({
        node,
        leaves: countLeaves(node.id),
      }))
      .map(({ node, leaves }) => ({ node, leaves }));
  }, [childNodes, tree.nodes]);

  useEffect(() => {
    if (lichessStatus !== 'done' || !lichessData?.moves || lichessData.moves.length === 0) return;

    setTrees((prev) => {
      const currentTree = prev[activeSide];
      const currentNodeId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
      const currentNode = currentTree.nodes[currentNodeId];
      if (!currentNode || currentNode.children.length < 2) return prev;

      const popularityByUci = new Map<string, number>();
      for (const move of lichessData.moves) {
        popularityByUci.set(move.uci, move.white + move.draws + move.black);
      }

      const reorderedChildren = [...currentNode.children].sort((aId, bId) => {
        const aUci = currentTree.nodes[aId]?.moveUci ?? '';
        const bUci = currentTree.nodes[bId]?.moveUci ?? '';
        const aPop = popularityByUci.get(aUci) ?? 0;
        const bPop = popularityByUci.get(bUci) ?? 0;
        if (bPop !== aPop) return bPop - aPop;
        return 0;
      });

      const unchanged = reorderedChildren.every((childId, idx) => childId === currentNode.children[idx]);
      if (unchanged) return prev;

      const nextTree: MoveTree = {
        ...currentTree,
        nodes: {
          ...currentTree.nodes,
          [currentNode.id]: {
            ...currentNode,
            children: reorderedChildren,
          },
        },
      };

      return {
        ...prev,
        [activeSide]: nextTree,
      };
    });
  }, [activeSide, lichessData, lichessStatus, selectedNodeBySide]);

  const goBackOneMove = () => {
    if (isTrainingActive) return;
    const parentId = selectedNode.parentId;
    if (!parentId) return;
    navigateToNode(activeSide, parentId);
  };

  const deleteLastMove = () => {
    if (isTrainingActive) return;
    const branchRootId = selectedNode.id;
    const parentId = selectedNode.parentId;
    if (!parentId) return;

    setUndoStackBySide((prev) => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree, selectedNodeId: selectedNode.id }].slice(-200),
    }));
    setTrees((prev) => {
      const currentTree = prev[activeSide];
      const nextTree = removeBranch(currentTree, branchRootId);
      return { ...prev, [activeSide]: nextTree };
    });

    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: parentId }));
  };

  const navigateToNode = (side: Side, nextId: string) => {
    if (trainingSession && trainingSession.side === side) return;
    const currentId = selectedNodeBySide[side] ?? trees[side].rootId;
    if (currentId === nextId) return;
    setUndoStackBySide((prev) => ({
      ...prev,
      [side]: [...prev[side], { tree: trees[side], selectedNodeId: currentId }].slice(-200),
    }));
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: nextId }));
  };

  const undoNavigation = () => {
    if (isTrainingActive) return;
    const stack = undoStackBySide[activeSide];
    if (stack.length === 0) return;

    const nextStack = [...stack];
    const snapshot = nextStack.pop();
    if (!snapshot) return;

    setUndoStackBySide((prev) => ({ ...prev, [activeSide]: nextStack }));
    setTrees((prev) => ({ ...prev, [activeSide]: snapshot.tree }));
    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: snapshot.selectedNodeId }));
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <div>{visibleTopStatus && <span className="status">{visibleTopStatus}</span>}</div>
        </div>
      </header>
      <input
        ref={importInputRef}
        type="file"
        accept=".pgn,.txt,text/plain,application/x-chess-pgn"
        style={{ display: 'none' }}
        onChange={importPgn}
      />

      <main className="layout">
        <section className="left-panel">
          <div className={`board-row ${isTrainingActive ? 'training-mode' : ''}`}>
            {!isTrainingActive && <aside className={`lichess-panel card portrait-pane ${portraitTab === 'lichess' ? 'active' : ''}`}>
              {(visibleLichessStatus || lichessStatus === 'loading') && (
                <div className="status lichess-status-row">
                  {lichessStatus === 'loading' && <span className="spinner" aria-hidden="true" />}
                  <span>{visibleLichessStatus || 'loading'}</span>
                </div>
              )}
              {lichessData && (
                <>
                  <div className="table">
                    {filteredLichessMoves.map((move) => {
                      const total = move.white + move.draws + move.black;
                      return (
                        <div
                          className={`table-row lichess-clickable-row ${isTrainingActive ? 'disabled' : ''}`}
                          key={`${move.uci}-${move.san}`}
                          role="button"
                          tabIndex={isTrainingActive ? -1 : 0}
                          onClick={() => playLichessMove(move.uci)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              playLichessMove(move.uci);
                            }
                          }}
                        >
                          <span className="lichess-cell-move">{toFigurineSan(move.san)}</span>
                          <span className="lichess-cell-games">
                            {formatGamesCount(total)} ({formatPercent(total, lichessTotal)})
                          </span>
                          <span className="lichess-cell-elo">{formatAverageElo(move)}</span>
                          <span className="lichess-cell-bar">
                            <LichessStatsBar white={move.white} draws={move.draws} black={move.black} total={total} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="stockfish-inline desktop-only">
                    <div className="controls-row">
                      <button
                        aria-label={engineRunning ? 'Stop Stockfish' : 'Run Stockfish'}
                        title={engineRunning ? 'Stop Stockfish' : 'Run Stockfish'}
                        onClick={() => {
                          setEngineRunning((prev) => {
                            if (prev) {
                              stockfishRef.current?.postMessage('stop');
                              setEngineStatus('stopped');
                            }
                            return !prev;
                          });
                        }}
                      >
                        {engineRunning ? '■' : '▶'}
                      </button>
                      <span className="inline-stepper">
                        <button
                          type="button"
                          onClick={() => setEngineMultiPv((prev) => Math.max(1, prev - 1))}
                          aria-label="Decrease lines"
                        >
                          -
                        </button>
                        <span className="stepper-value">{engineMultiPv}</span>
                        <button
                          type="button"
                          onClick={() => setEngineMultiPv((prev) => Math.min(10, prev + 1))}
                          aria-label="Increase lines"
                        >
                          +
                        </button>
                      </span>
                      {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
                    </div>
                    <div className="table">
                      {engineLines.map((line) => (
                        <div
                          className="table-row stockfish-clickable-row"
                          key={line.multipv}
                          role="button"
                          tabIndex={0}
                          onClick={() => playStockfishMove(line.bestMove)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              playStockfishMove(line.bestMove);
                            }
                          }}
                        >
                          <span>{uciToFigurineSan(selectedNode.fen, line.bestMove) || '-'}</span>
                          <span>{line.scoreText}</span>
                          <span>{pvToFigurineSan(selectedNode.fen, line.pv) || '-'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
              <button
                className="gear-btn left-panel-gear desktop-only"
                type="button"
                aria-label="Filters"
                title="Filters"
                onClick={() => setIsLichessFilterOpen(true)}
              >
                ⚙
              </button>
            </aside>}

            <div className="board-center">
              <div className="board-meta">
                <div className="board-head-row">
                  <div className="opening-title" title={openingFullTitle}>
                    {openingTitleContent}
                  </div>
                  <button className="hamburger-btn board-options-btn" aria-label="Options menu" onClick={() => setIsOptionsOpen(true)}>
                    &#9776;
                  </button>
                </div>
                <div className="stats-row">
                  <LichessStatsBar
                    white={lichessData?.white ?? 0}
                    draws={lichessData?.draws ?? 0}
                    black={lichessData?.black ?? 0}
                    total={lichessTotal}
                  />
                  <span className="games-total">{formatGamesCount(lichessTotal)} games</span>
                </div>
              </div>
              <Board
                fen={selectedNode.fen}
                orientation={orientation}
                lastMove={lastMove}
                arrows={trainingForActive ? trainingHintArrow : autoArrows}
                onMove={makeMove}
              />
              <div className="portrait-tabbar">
                {!isTrainingActive && (
                  <>
                    <button
                      type="button"
                      className={portraitTab === 'lichess' ? 'active' : ''}
                      onClick={() => setPortraitTab('lichess')}
                      aria-label="Lichess"
                      title="Lichess"
                    >
                      <DbIcon />
                    </button>
                    <button
                      type="button"
                      className={portraitTab === 'stockfish' ? 'active' : ''}
                      onClick={() => setPortraitTab('stockfish')}
                      aria-label="Stockfish"
                      title="Stockfish"
                    >
                      <ComputerIcon />
                    </button>
                    <button
                      type="button"
                      className={portraitTab === 'moves' ? 'active' : ''}
                      onClick={() => setPortraitTab('moves')}
                      aria-label="Moves"
                      title="Moves"
                    >
                      <MoveIcon />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={isTrainingActive ? 'active' : ''}
                  onClick={() => (isTrainingActive ? stopTraining() : startTraining())}
                  aria-label="Train"
                  title="Train"
                  disabled={!isTrainingActive && !canStartTraining}
                >
                  <TrainIcon />
                </button>
                {!isTrainingActive && (
                  <button
                    className="gear-btn portrait-filters-btn"
                    type="button"
                    aria-label="Filters"
                    title="Filters"
                    onClick={() => setIsLichessFilterOpen(true)}
                  >
                    ⚙
                  </button>
                )}
              </div>
              {isTrainingActive && showHintButton && (
                <div className="controls-row training-hint-row">
                  <button
                    type="button"
                    onClick={() =>
                      setTrainingSession((prev) => (prev ? { ...prev, hintVisible: true } : prev))
                    }
                  >
                    Hint
                  </button>
                </div>
              )}
              {isTrainingLineEnd && (
                <div className="controls-row training-hint-row">
                  <button type="button" onClick={restartTrainingLine}>
                    Continue
                  </button>
                </div>
              )}
            </div>
            {!isTrainingActive && <aside className={`stockfish-panel card portrait-only portrait-pane ${portraitTab === 'stockfish' ? 'active' : ''}`}>
              <div className="controls-row">
                <button
                  aria-label={engineRunning ? 'Stop Stockfish' : 'Run Stockfish'}
                  title={engineRunning ? 'Stop Stockfish' : 'Run Stockfish'}
                  onClick={() => {
                    setEngineRunning((prev) => {
                      if (prev) {
                        stockfishRef.current?.postMessage('stop');
                        setEngineStatus('stopped');
                      }
                      return !prev;
                    });
                  }}
                >
                  {engineRunning ? '■' : '▶'}
                </button>
                <span className="inline-stepper">
                  <button
                    type="button"
                    onClick={() => setEngineMultiPv((prev) => Math.max(1, prev - 1))}
                    aria-label="Decrease lines"
                  >
                    -
                  </button>
                  <span className="stepper-value">{engineMultiPv}</span>
                  <button
                    type="button"
                    onClick={() => setEngineMultiPv((prev) => Math.min(10, prev + 1))}
                    aria-label="Increase lines"
                  >
                    +
                  </button>
                </span>
                {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
              </div>
              <div className="table">
                {engineLines.map((line) => (
                  <div
                    className="table-row stockfish-clickable-row"
                    key={line.multipv}
                    role="button"
                    tabIndex={0}
                    onClick={() => playStockfishMove(line.bestMove)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        playStockfishMove(line.bestMove);
                      }
                    }}
                  >
                    <span>{uciToFigurineSan(selectedNode.fen, line.bestMove) || '-'}</span>
                    <span>{line.scoreText}</span>
                    <span>{pvToFigurineSan(selectedNode.fen, line.pv) || '-'}</span>
                  </div>
                ))}
              </div>
            </aside>}

            {!isTrainingActive && <aside className={`move-list card portrait-pane ${portraitTab === 'moves' ? 'active' : ''}`}>
              <div className="controls-row">
                <button
                  onClick={goBackOneMove}
                  disabled={!canGoBack || isTrainingActive}
                  aria-label="Back 1 move"
                  title="Back 1 move"
                >
                  ←
                </button>
                <button
                  className="danger"
                  onClick={deleteLastMove}
                  disabled={!canGoBack || isTrainingActive}
                  aria-label="Delete last move"
                  title="Delete last move"
                >
                  ✕
                </button>
                <button onClick={undoNavigation} disabled={undoStackBySide[activeSide].length === 0 || isTrainingActive}>
                  Undo
                </button>
                <button
                  className="desktop-only"
                  type="button"
                  onClick={() => (isTrainingActive ? stopTraining() : startTraining())}
                  disabled={!isTrainingActive && !canStartTraining}
                >
                  {isTrainingActive ? 'Stop train' : 'Train'}
                </button>
                <div className="arrow-toggle-group">
                  <button
                    type="button"
                    className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-lichess ${showLichessArrows ? 'active' : ''}`}
                    onClick={() => setShowLichessArrows((prev) => !prev)}
                    aria-label="Toggle Lichess arrows"
                    title="Toggle Lichess arrows"
                  />
                  <button
                    type="button"
                    className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-stockfish ${showStockfishArrows ? 'active' : ''}`}
                    onClick={() => setShowStockfishArrows((prev) => !prev)}
                    aria-label="Toggle Stockfish arrows"
                    title="Toggle Stockfish arrows"
                  />
                  <button
                    type="button"
                    className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-tree ${showTreeArrows ? 'active' : ''}`}
                    onClick={() => setShowTreeArrows((prev) => !prev)}
                    aria-label="Toggle tree arrows"
                    title="Toggle tree arrows"
                  />
                </div>
              </div>
              {inlineMoves.length > 0 && (
                <div className="move-inline-wrap">
                  {inlineMoves.map((move) => (
                    <button
                      key={move.id}
                      type="button"
                      className={`move-inline-item ${move.hasAlternatives ? 'has-alternatives' : ''}`}
                      disabled={isTrainingActive}
                      onClick={() => navigateToNode(activeSide, move.id)}
                    >
                      {move.prefix ? <span className="move-inline-prefix">{move.prefix}</span> : null}
                      <span>{move.san}</span>
                    </button>
                  ))}
                </div>
              )}
              {optionRows.length > 0 && (
                <div className="tree-options-wrap">
                  {optionRows.map(({ node, leaves }) => (
                    <div key={node.id} className="tree-option">
                      <button
                        type="button"
                        className="tree-option-btn"
                        disabled={isTrainingActive}
                        onClick={() => navigateToNode(activeSide, node.id)}
                      >
                        {toFigurineSan(node.moveSan ?? '')}
                      </button>
                      <span className="tree-option-leaves">{leaves}</span>
                    </div>
                  ))}
                </div>
              )}
            </aside>}
          </div>

        </section>
      </main>

      {isOptionsOpen && (
        <div className="modal-backdrop" onClick={() => setIsOptionsOpen(false)}>
          <div className="modal-card options-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>Options</h2>
            </div>
            <div className="options-grid">
              <button
                onClick={() => {
                  setOrientation((prev) => (prev === 'white' ? 'black' : 'white'));
                  setIsOptionsOpen(false);
                }}
              >
                Rotate board
              </button>
              <button
                onClick={() => {
                  exportPgn();
                  setIsOptionsOpen(false);
                }}
              >
                Export {activeSide} PGN
              </button>
              <button
                onClick={() => {
                  openImportDialog();
                  setIsOptionsOpen(false);
                }}
              >
                Import {activeSide} PGN
              </button>
              <button
                onClick={() => {
                  openInLichessAnalysis();
                  setIsOptionsOpen(false);
                }}
              >
                Analyse with Lichess
              </button>
            </div>
          </div>
        </div>
      )}

      {isLichessFilterOpen && (
        <div className="modal-backdrop" onClick={() => setIsLichessFilterOpen(false)}>
          <div className="modal-card filters-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filters-modal-main">
              <div className="filters-grid">
                <label>
                  Database
                  <span className="toggle-group database-toggle">
                    <button
                      type="button"
                      className={lichessSource === 'masters' ? 'active' : ''}
                      onClick={() => setLichessSource((prev) => (prev === 'masters' ? 'lichess' : 'masters'))}
                    >
                      Masters
                    </button>
                    <button
                      type="button"
                      className={lichessSource === 'player' ? 'active' : ''}
                      onClick={() => setLichessSource((prev) => (prev === 'player' ? 'lichess' : 'player'))}
                    >
                      Player
                    </button>
                  </span>
                  {lichessSource === 'player' && (
                    <span className="player-handle-row">
                      <input
                        className="player-handle-input"
                        type="text"
                        value={playerHandle}
                        onChange={(e) => setPlayerHandle(e.target.value)}
                        placeholder="Lichess handle"
                      />
                    </span>
                  )}
                </label>
                <label>
                  Date range
                  <span className="toggle-group date-range-toggle">
                    {lichessSource === 'player' && (
                      <button
                        type="button"
                        className={dateRange === '1m' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '1m' ? null : '1m'))}
                      >
                        1M
                      </button>
                    )}
                    {lichessSource === 'player' && (
                      <button
                        type="button"
                        className={dateRange === '2m' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '2m' ? null : '2m'))}
                      >
                        2M
                      </button>
                    )}
                    {lichessSource === 'player' && (
                      <button
                        type="button"
                        className={dateRange === '3m' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '3m' ? null : '3m'))}
                      >
                        3M
                      </button>
                    )}
                    {lichessSource === 'player' && (
                      <button
                        type="button"
                        className={dateRange === '6m' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '6m' ? null : '6m'))}
                      >
                        6M
                      </button>
                    )}
                    <button
                      type="button"
                      className={dateRange === '1y' ? 'active' : ''}
                      onClick={() => setDateRange((prev) => (prev === '1y' ? null : '1y'))}
                    >
                      1Y
                    </button>
                    <button
                      type="button"
                      className={dateRange === '3y' ? 'active' : ''}
                      onClick={() => setDateRange((prev) => (prev === '3y' ? null : '3y'))}
                    >
                      3Y
                    </button>
                    {lichessSource === 'lichess' && (
                      <button
                        type="button"
                        className={dateRange === '5y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '5y' ? null : '5y'))}
                      >
                        5Y
                      </button>
                    )}
                    {lichessSource === 'lichess' && (
                      <button
                        type="button"
                        className={dateRange === '10y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '10y' ? null : '10y'))}
                      >
                        10Y
                      </button>
                    )}
                    {lichessSource === 'masters' && (
                      <button
                        type="button"
                        className={dateRange === '10y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '10y' ? null : '10y'))}
                      >
                        10Y
                      </button>
                    )}
                    {lichessSource === 'masters' && (
                      <button
                        type="button"
                        className={dateRange === '20y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '20y' ? null : '20y'))}
                      >
                        20Y
                      </button>
                    )}
                    {lichessSource === 'masters' && (
                      <button
                        type="button"
                        className={dateRange === '30y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '30y' ? null : '30y'))}
                      >
                        30Y
                      </button>
                    )}
                    {lichessSource === 'masters' && (
                      <button
                        type="button"
                        className={dateRange === '50y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '50y' ? null : '50y'))}
                      >
                        50Y
                      </button>
                    )}
                  </span>
                </label>
              </div>

              {(lichessSource === 'lichess' || lichessSource === 'player') && (
                <div className="checkbox-grid">
                <div>
                  <strong>Speeds</strong>
                  {SPEEDS.map((speed) => (
                    <label key={speed} className="inline-check">
                      <input
                        type="checkbox"
                        checked={selectedSpeeds.includes(speed)}
                        onChange={(e) => {
                          setSelectedSpeeds((prev) =>
                            e.target.checked ? [...prev, speed] : prev.filter((item) => item !== speed),
                          );
                        }}
                      />
                      {speed}
                    </label>
                  ))}
                </div>

                {lichessSource === 'lichess' && (
                  <div>
                    <strong>Ratings</strong>
                    {RATINGS.map((rating) => (
                      <label key={rating} className="inline-check">
                        <input
                          type="checkbox"
                          checked={selectedRatings.includes(rating)}
                          onChange={(e) => {
                            setSelectedRatings((prev) =>
                              e.target.checked ? [...prev, rating] : prev.filter((item) => item !== rating),
                            );
                          }}
                        />
                        {rating}+
                      </label>
                    ))}
                  </div>
                )}

                {lichessSource === 'player' && (
                  <div>
                    <strong>Modes</strong>
                    {MODES.map((mode) => (
                      <label key={mode} className="inline-check">
                        <input
                          type="checkbox"
                          checked={selectedModes.includes(mode)}
                          onChange={(e) => {
                            setSelectedModes((prev) =>
                              e.target.checked ? [...prev, mode] : prev.filter((item) => item !== mode),
                            );
                          }}
                        />
                        {mode}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              )}
            </div>
            <div className="filters-modal-fixed">
              <div className="slider-stack">
                <label>
                  {`Moves threshold: ${lichessArrowThreshold}%`}
                  <span className="slider-field">
                    <input
                      className="threshold-slider"
                      type="range"
                      min={0}
                      max={MOVE_THRESHOLD_OPTIONS.length - 1}
                      step={1}
                      value={MOVE_THRESHOLD_OPTIONS.indexOf(lichessArrowThreshold)}
                      onChange={(e) => {
                        const idx = Number.parseInt(e.target.value, 10);
                        const next = MOVE_THRESHOLD_OPTIONS[idx] ?? 5;
                        setLichessArrowThreshold(next);
                      }}
                    />
                  </span>
                </label>
                <label>
                  {`Stockfish depth: ${engineDepth}`}
                  <span className="slider-field">
                    <input
                      className="threshold-slider"
                      type="range"
                      min={16}
                      max={32}
                      step={1}
                      value={engineDepth}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(next)) setEngineDepth(next);
                      }}
                    />
                  </span>
                </label>
              </div>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={showLichessOnTreeMoves}
                  onChange={(e) => setShowLichessOnTreeMoves(e.target.checked)}
                />
                Show Lichess arrows for tree moves
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
