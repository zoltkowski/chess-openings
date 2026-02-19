import { useEffect, useMemo, useRef, useState, type ChangeEventHandler } from 'react';
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
type DateRange = '1y' | '3y' | 'all';

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
  const [engineDepth, setEngineDepth] = useState(16);
  const [engineMultiPv, setEngineMultiPv] = useState(3);
  const [showStockfishArrows, setShowStockfishArrows] = useState(true);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [engineStatus, setEngineStatus] = useState('stopped');
  const [engineRunning, setEngineRunning] = useState(false);
  const [lichessData, setLichessData] = useState<LichessResponse | null>(null);
  const [lichessStatus, setLichessStatus] = useState('idle');
  const [showLichessArrows, setShowLichessArrows] = useState(true);
  const [showLichessOnTreeMoves, setShowLichessOnTreeMoves] = useState(true);
  const [isLichessFilterOpen, setIsLichessFilterOpen] = useState(false);
  const [lichessSource, setLichessSource] = useState<LichessSource>('lichess');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [lichessArrowThreshold, setLichessArrowThreshold] = useState(5);
  const [selectedSpeeds, setSelectedSpeeds] = useState<string[]>(['blitz', 'rapid', 'classical']);
  const [selectedRatings, setSelectedRatings] = useState<number[]>([1600, 1800, 2000, 2200]);
  const [undoStackBySide, setUndoStackBySide] = useState<Record<Side, UndoSnapshot[]>>({
    white: [],
    black: [],
  });
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [portraitTab, setPortraitTab] = useState<'lichess' | 'stockfish' | 'moves'>('lichess');

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

  const path = useMemo(() => buildPath(tree, selectedNode.id), [tree, selectedNode.id]);

  const childNodes = useMemo(
    () => selectedNode.children.map((id) => tree.nodes[id]).filter(Boolean),
    [selectedNode.children, tree.nodes],
  );

  const autoArrows = useMemo<DrawShape[]>(() => {
    const treeArrows = childNodes
      .map((node) => parseUciMove(node.moveUci))
      .filter((value): value is [Key, Key] => Boolean(value))
      .map(([orig, dest]) => ({ orig, dest, brush: 'green' }));

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

      if (dateRange !== 'all') {
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

  const makeMove = (orig: Key, dest: Key) => {
    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
    const chess = fenToChess(currentNode.fen);
    const move = chess.move({ from: orig, to: dest, promotion: 'q' });

    if (!move) return;

    const uci = uciFromMove(move);
    const existingChildId = currentNode.children.find((id) => currentTree.nodes[id].moveUci === uci);

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
    const parentId = selectedNode.parentId;
    if (!parentId) return;
    navigateToNode(activeSide, parentId);
  };

  const deleteLastMove = () => {
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
    const currentId = selectedNodeBySide[side] ?? trees[side].rootId;
    if (currentId === nextId) return;
    setUndoStackBySide((prev) => ({
      ...prev,
      [side]: [...prev[side], { tree: trees[side], selectedNodeId: currentId }].slice(-200),
    }));
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: nextId }));
  };

  const undoNavigation = () => {
    const stack = undoStackBySide[activeSide];
    if (stack.length === 0) return;

    const nextStack = [...stack];
    const snapshot = nextStack.pop();
    if (!snapshot) return;

    setUndoStackBySide((prev) => ({ ...prev, [activeSide]: nextStack }));
    setTrees((prev) => ({ ...prev, [activeSide]: snapshot.tree }));
    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: snapshot.selectedNodeId }));
  };

  const renderMoveCell = (node?: MoveNode) => {
    if (!node) return '';
    return (
      <button
        className="table-move-btn"
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
          <div className="board-row">
            <aside className={`lichess-panel card portrait-pane ${portraitTab === 'lichess' ? 'active' : ''}`}>
              <div className="card-head">
                <span />
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={showLichessArrows}
                    onChange={(e) => setShowLichessArrows(e.target.checked)}
                    aria-label="Toggle Lichess arrows"
                  />
                </label>
              </div>
              {visibleLichessStatus && <div className="status">{visibleLichessStatus}</div>}
              {lichessData && (
                <>
                  <div className="table">
                    {filteredLichessMoves.map((move) => {
                      const total = move.white + move.draws + move.black;
                      return (
                        <div className="table-row" key={`${move.uci}-${move.san}`}>
                          <span>{toFigurineSan(move.san)}</span>
                          <span>
                            {formatGamesCount(total)} ({formatPercent(total, lichessTotal)})
                          </span>
                          <span>
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
                      <button
                        className="gear-btn"
                        type="button"
                        aria-label="Filters"
                        title="Filters"
                        onClick={() => setIsLichessFilterOpen(true)}
                      >
                        ⚙
                      </button>
                      <label className="inline-check stockfish-arrow-toggle">
                        <input
                          type="checkbox"
                          checked={showStockfishArrows}
                          onChange={(e) => setShowStockfishArrows(e.target.checked)}
                          aria-label="Toggle Stockfish arrows"
                        />
                      </label>
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
            </aside>

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
                arrows={autoArrows}
                onMove={makeMove}
              />
              <div className="portrait-tabbar">
                <button
                  type="button"
                  className={portraitTab === 'lichess' ? 'active' : ''}
                  onClick={() => setPortraitTab('lichess')}
                >
                  Lichess
                </button>
                <button
                  type="button"
                  className={portraitTab === 'stockfish' ? 'active' : ''}
                  onClick={() => setPortraitTab('stockfish')}
                >
                  Stockfish
                </button>
                <button
                  type="button"
                  className={portraitTab === 'moves' ? 'active' : ''}
                  onClick={() => setPortraitTab('moves')}
                >
                  Moves
                </button>
              </div>
            </div>

            <aside className={`stockfish-panel card portrait-only portrait-pane ${portraitTab === 'stockfish' ? 'active' : ''}`}>
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
                  <button
                    className="gear-btn"
                    type="button"
                    aria-label="Filters"
                    title="Filters"
                    onClick={() => setIsLichessFilterOpen(true)}
                  >
                    ⚙
                  </button>
                </span>
                <label className="inline-check stockfish-arrow-toggle">
                  <input
                    type="checkbox"
                    checked={showStockfishArrows}
                    onChange={(e) => setShowStockfishArrows(e.target.checked)}
                    aria-label="Toggle Stockfish arrows"
                  />
                </label>
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
            </aside>

            <aside className={`move-list card portrait-pane ${portraitTab === 'moves' ? 'active' : ''}`}>
              <div className="controls-row">
                <button onClick={goBackOneMove} disabled={!canGoBack} aria-label="Back 1 move" title="Back 1 move">
                  ←
                </button>
                <button
                  className="danger"
                  onClick={deleteLastMove}
                  disabled={!canGoBack}
                  aria-label="Delete last move"
                  title="Delete last move"
                >
                  ✕
                </button>
                <button onClick={undoNavigation} disabled={undoStackBySide[activeSide].length === 0}>
                  Undo
                </button>
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
            </aside>
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
              <button onClick={() => setIsLichessFilterOpen(false)}>Close</button>
            </div>
            <div className="filters-grid">
              <label>
                Database
                <span className="toggle-group">
                  <button
                    type="button"
                    className={lichessSource === 'lichess' ? 'active' : ''}
                    onClick={() => setLichessSource('lichess')}
                  >
                    Lichess
                  </button>
                  <button
                    type="button"
                    className={lichessSource === 'masters' ? 'active' : ''}
                    onClick={() => setLichessSource('masters')}
                  >
                    Masters
                  </button>
                </span>
              </label>
              <label>
                Date range
                <span className="toggle-group">
                  <button type="button" className={dateRange === '1y' ? 'active' : ''} onClick={() => setDateRange('1y')}>
                    Last year
                  </button>
                  <button type="button" className={dateRange === '3y' ? 'active' : ''} onClick={() => setDateRange('3y')}>
                    Last 3 years
                  </button>
                  <button type="button" className={dateRange === 'all' ? 'active' : ''} onClick={() => setDateRange('all')}>
                    All
                  </button>
                </span>
              </label>
              <label>
                Arrow threshold (%)
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={lichessArrowThreshold}
                  onChange={(e) => setLichessArrowThreshold(Number(e.target.value) || 5)}
                />
              </label>
              <label>
                Stockfish depth
                <input
                  type="number"
                  min={6}
                  max={28}
                  value={engineDepth}
                  onChange={(e) => setEngineDepth(Number(e.target.value) || 16)}
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
              Show Lichess arrows on tree moves (green arrows)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
