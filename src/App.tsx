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
type LichessSource = 'lichess' | 'masters';
type DateRange = '1y' | '3y' | null;

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
const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'] as const;
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
  dateRange?: DateRange;
  lichessArrowThreshold?: number;
  engineDepth?: number;
  selectedSpeeds?: string[];
  selectedRatings?: number[];
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
    <TabIconBase>
      <rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M9 19h6M12 16v3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </TabIconBase>
  );
}

function MoveIcon() {
  return (
    <TabIconBase>
      <rect x="4" y="5" width="16" height="14" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M4 10h16M4 14h16M9.33 5v14M14.66 5v14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
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
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '-';
  return `${Math.round(raw)}`;
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

  const label = (pct: number) => (pct >= 8 ? `${pct.toFixed(1)}%` : '');

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
    persistedFilterSettings.lichessSource === 'masters' ? 'masters' : 'lichess';
  const initialDateRange: DateRange =
    persistedFilterSettings.dateRange === '1y' || persistedFilterSettings.dateRange === '3y'
      ? persistedFilterSettings.dateRange
      : null;
  const initialLichessArrowThreshold = clampInt(persistedFilterSettings.lichessArrowThreshold, 1, 100, 5);
  const initialEngineDepth = clampInt(persistedFilterSettings.engineDepth, 6, 28, 16);
  const initialSelectedSpeeds = (persistedFilterSettings.selectedSpeeds ?? []).filter((speed): speed is string =>
    SPEEDS.includes(speed as (typeof SPEEDS)[number]),
  );
  const initialSelectedRatings = (persistedFilterSettings.selectedRatings ?? []).filter((rating): rating is number =>
    RATINGS.includes(rating),
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
  const [engineDepthInput, setEngineDepthInput] = useState(String(initialEngineDepth));
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
  const [dateRange, setDateRange] = useState<DateRange>(initialDateRange);
  const [lichessArrowThreshold, setLichessArrowThreshold] = useState(initialLichessArrowThreshold);
  const [lichessArrowThresholdInput, setLichessArrowThresholdInput] = useState(String(initialLichessArrowThreshold));
  const [selectedSpeeds, setSelectedSpeeds] = useState<string[]>(
    initialSelectedSpeeds.length > 0 ? initialSelectedSpeeds : ['blitz', 'rapid', 'classical'],
  );
  const [selectedRatings, setSelectedRatings] = useState<number[]>(
    initialSelectedRatings.length > 0 ? initialSelectedRatings : [1600, 1800, 2000, 2200],
  );
  const [undoStackBySide, setUndoStackBySide] = useState<Record<Side, UndoSnapshot[]>>({
    white: [],
    black: [],
  });
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [portraitTab, setPortraitTab] = useState<'lichess' | 'stockfish' | 'moves'>('lichess');
  const [trainingSession, setTrainingSession] = useState<TrainingSession | null>(null);

  const stockfishRef = useRef<Worker | null>(null);
  const engineReadyRef = useRef(false);
  const currentAnalysisRef = useRef(0);
  const lineCacheRef = useRef<Map<number, EngineLine>>(new Map());
  const previousFenRef = useRef<string>(START_FEN);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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
        ? (lichessData?.moves ?? [])
            .filter((move) => showLichessOnTreeMoves || !treeChildUcis.has(move.uci))
            .map((move) => {
              const moveGames = move.white + move.draws + move.black;
              const share = moveGames / positionGames;
              const keyPair = parseUciMove(move.uci);
              return { moveGames, share, keyPair };
            })
            .filter((entry) => entry.share > thresholdShare && Boolean(entry.keyPair))
            .map((entry) => {
              const [orig, dest] = entry.keyPair as [Key, Key];
              const lineWidth = 10 + entry.share * 26;
              return {
                orig,
                dest,
                brush: 'yellow',
                modifiers: { lineWidth },
              } as DrawShape;
            })
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

            const values = candidates.map((entry) => entry.evalValue);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const spread = Math.max(1, max - min);

            return candidates.map((entry) => {
              const [orig, dest] = entry.keyPair;
              const normalized = (entry.evalValue - min) / spread;
              return {
                orig,
                dest,
                brush: 'blue',
                modifiers: { lineWidth: 10 + normalized * 24 },
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
        dateRange,
        lichessArrowThreshold,
        engineDepth,
        selectedSpeeds,
        selectedRatings,
        showLichessOnTreeMoves,
      };
      window.localStorage.setItem(FILTER_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage write errors.
    }
  }, [
    lichessSource,
    dateRange,
    lichessArrowThreshold,
    engineDepth,
    selectedSpeeds,
    selectedRatings,
    showLichessOnTreeMoves,
  ]);

  useEffect(() => {
    setEngineDepthInput(String(engineDepth));
  }, [engineDepth]);

  useEffect(() => {
    setLichessArrowThresholdInput(String(lichessArrowThreshold));
  }, [lichessArrowThreshold]);

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
    const worker = new Worker('/stockfish/stockfish-18-lite-single.js');
    stockfishRef.current = worker;

    worker.onmessage = (event: MessageEvent<string>) => {
      const text = String(event.data || '');

      if (text === 'uciok') {
        worker.postMessage('isready');
        return;
      }

      if (text === 'readyok') {
        engineReadyRef.current = true;
        setEngineStatus((prev) => (prev === 'stopped' ? prev : 'idle'));
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
        setEngineStatus('done');
      }
    };

    worker.postMessage('uci');

    return () => {
      worker.terminate();
      stockfishRef.current = null;
      engineReadyRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!stockfishRef.current || !engineReadyRef.current) return;
    if (!engineRunning) {
      stockfishRef.current.postMessage('stop');
      setEngineStatus('stopped');
      return;
    }

    const analysisId = currentAnalysisRef.current + 1;
    currentAnalysisRef.current = analysisId;
    lineCacheRef.current = new Map();
    setEngineLines([]);
    setEngineStatus('analyzing');

    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;

    stockfishRef.current.postMessage('stop');
    stockfishRef.current.postMessage(`setoption name MultiPV value ${engineMultiPv}`);
    stockfishRef.current.postMessage(`position fen ${fen}`);
    stockfishRef.current.postMessage(`go depth ${engineDepth}`);
  }, [selectedNode.fen, engineDepth, engineRunning, engineMultiPv]);

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

    const run = async () => {
      setLichessStatus('loading');
      const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
      const params = new URLSearchParams({
        fen,
        variant: 'standard',
        moves: '30',
      });
      if (lichessSource === 'lichess') {
        if (selectedSpeeds.length) params.set('speeds', selectedSpeeds.join(','));
        if (selectedRatings.length) params.set('ratings', selectedRatings.join(','));
      }

      if (dateRange) {
        const now = new Date();
        const until = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const yearsBack = dateRange === '1y' ? 1 : 3;
        const sinceDate = new Date(now);
        sinceDate.setFullYear(now.getFullYear() - yearsBack);
        const since = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}`;
        params.set('since', since);
        params.set('until', until);
      }

      try {
        const res = await fetch(`https://explorer.lichess.ovh/${lichessSource}?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Lichess request failed');
        const data = (await res.json()) as LichessResponse;
        setLichessData(data);
        setLichessStatus('done');
      } catch {
        if (!controller.signal.aborted) {
          setLichessStatus('error');
        }
      }
    };

    const timeout = window.setTimeout(run, 280);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [selectedNode.fen, selectedSpeeds, selectedRatings, dateRange, lichessSource]);

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

  const makeMove = (orig: Key, dest: Key) => {
    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
    const chess = fenToChess(currentNode.fen);
    const move = chess.move({ from: orig, to: dest, promotion: 'q' });

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
  const showTrainButton = isTrainingActive || childNodes.length > 0;
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
  const filteredLichessMoves = useMemo(() => {
    if (!lichessData?.moves || lichessTotal <= 0) return [];
    const thresholdShare = lichessArrowThreshold / 100;
    return lichessData.moves.filter((move) => {
      const total = move.white + move.draws + move.black;
      return total / lichessTotal > thresholdShare;
    });
  }, [lichessData, lichessTotal, lichessArrowThreshold]);
  const pairedMoves = useMemo(() => {
    const plies = path.slice(1);
    const rows: Array<{ number: number; white?: MoveNode; black?: MoveNode }> = [];
    for (let i = 0; i < plies.length; i += 2) {
      rows.push({
        number: Math.floor(i / 2) + 1,
        white: plies[i],
        black: plies[i + 1],
      });
    }
    return rows;
  }, [path]);

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

  const commitMovesThresholdInput = () => {
    const raw = lichessArrowThresholdInput.trim();
    const parsed = Number.parseInt(raw, 10);
    const nextValue = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 5;
    setLichessArrowThreshold(nextValue);
    setLichessArrowThresholdInput(String(nextValue));
  };

  const commitEngineDepthInput = () => {
    const raw = engineDepthInput.trim();
    const parsed = Number.parseInt(raw, 10);
    const nextValue = Number.isFinite(parsed) ? Math.min(28, Math.max(6, parsed)) : 16;
    setEngineDepth(nextValue);
    setEngineDepthInput(String(nextValue));
  };

  const renderMoveCell = (node?: MoveNode) => {
    if (!node) return '';
    return (
      <button
        className="table-move-btn"
        disabled={isTrainingActive}
        onClick={() => navigateToNode(activeSide, node.id)}
      >
        {toFigurineSan(node.moveSan ?? '')}
      </button>
    );
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
              {visibleLichessStatus && <div className="status">{visibleLichessStatus}</div>}
              {lichessData && (
                <>
                  <div className="table">
                    {filteredLichessMoves.map((move) => {
                      const total = move.white + move.draws + move.black;
                      return (
                        <div className="table-row" key={`${move.uci}-${move.san}`}>
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
                        <div className="table-row" key={line.multipv}>
                          <span>{uciToFigurineSan(selectedNode.fen, line.bestMove) || '-'}</span>
                          <span>{line.scoreText}</span>
                          <span>{pvToFigurineSan(selectedNode.fen, line.pv) || '-'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </aside>}

            <div className="board-center">
              <div className="board-meta">
                <div className="board-head-row">
                  <div className="opening-title" title={lichessData?.opening ? `${lichessData.opening.eco} ${lichessData.opening.name}` : ''}>
                    {lichessData?.opening ? `${lichessData.opening.eco} ${lichessData.opening.name}` : ''}
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
                {showTrainButton && (
                  <button
                    type="button"
                    className={isTrainingActive ? 'active' : ''}
                    onClick={() => (isTrainingActive ? stopTraining() : startTraining())}
                    aria-label="Train"
                    title="Train"
                  >
                    <TrainIcon />
                  </button>
                )}
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
                  <div className="table-row" key={line.multipv}>
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
                <div className="arrow-toggle-group">
                  <button
                    type="button"
                    className={`icon-toggle-btn ${showLichessArrows ? 'active' : ''}`}
                    onClick={() => setShowLichessArrows((prev) => !prev)}
                    aria-label="Toggle Lichess arrows"
                    title="Toggle Lichess arrows"
                  >
                    <DbIcon />
                  </button>
                  <button
                    type="button"
                    className={`icon-toggle-btn ${showStockfishArrows ? 'active' : ''}`}
                    onClick={() => setShowStockfishArrows((prev) => !prev)}
                    aria-label="Toggle Stockfish arrows"
                    title="Toggle Stockfish arrows"
                  >
                    <ComputerIcon />
                  </button>
                  <button
                    type="button"
                    className={`icon-toggle-btn ${showTreeArrows ? 'active' : ''}`}
                    onClick={() => setShowTreeArrows((prev) => !prev)}
                    aria-label="Toggle tree arrows"
                    title="Toggle tree arrows"
                  >
                    <MoveIcon />
                  </button>
                </div>
              </div>
              {path.length > 1 && (
                <div className="move-table-wrap">
                  <table className="move-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>White</th>
                        <th>Black</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairedMoves.map((row) => (
                        <tr key={row.number}>
                          <td>{row.number}</td>
                          <td>{renderMoveCell(row.white)}</td>
                          <td>{renderMoveCell(row.black)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              <button onClick={() => setIsOptionsOpen(false)}>Close</button>
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
            </div>
          </div>
        </div>
      )}

      {isLichessFilterOpen && (
        <div className="modal-backdrop" onClick={() => setIsLichessFilterOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>Lichess Filters</h2>
            </div>
            <div className="filters-grid">
              <label>
                Database
                <span className="toggle-group">
                  <button
                    type="button"
                    className={lichessSource === 'masters' ? 'active' : ''}
                    onClick={() => setLichessSource((prev) => (prev === 'masters' ? 'lichess' : 'masters'))}
                  >
                    Masters
                  </button>
                </span>
              </label>
              <label>
                Date range
                <span className="toggle-group">
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
                </span>
              </label>
              <label>
                Moves threshold (%)
                <input
                  className="compact-number-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={lichessArrowThresholdInput}
                  onChange={(e) => {
                    if (/^\d*$/.test(e.target.value)) setLichessArrowThresholdInput(e.target.value);
                  }}
                  onBlur={commitMovesThresholdInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitMovesThresholdInput();
                    }
                  }}
                />
              </label>
              <label>
                Stockfish depth
                <input
                  className="compact-number-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={engineDepthInput}
                  onChange={(e) => {
                    if (/^\d*$/.test(e.target.value)) setEngineDepthInput(e.target.value);
                  }}
                  onBlur={commitEngineDepthInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitEngineDepthInput();
                    }
                  }}
                />
              </label>
            </div>

            {lichessSource === 'lichess' && <div className="checkbox-grid">
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
            </div>}
            <label className="inline-check">
              <input
                type="checkbox"
                checked={showLichessOnTreeMoves}
                onChange={(e) => setShowLichessOnTreeMoves(e.target.checked)}
              />
              Show Lichess arrows on tree moves
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
