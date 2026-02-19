import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Move } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './App.css';

type Side = 'white' | 'black';

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

const START_FEN = 'start';
const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'] as const;
const RATINGS = [1200, 1400, 1600, 1800, 2000, 2200, 2500];

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
  if (total === 0) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function isNodeInSubtree(tree: MoveTree, targetId: string, rootId: string) {
  let cursor: string | null = targetId;
  while (cursor) {
    if (cursor === rootId) return true;
    cursor = tree.nodes[cursor]?.parentId ?? null;
  }
  return false;
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
      fen: fen === START_FEN ? undefined : fen,
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
  const [activeSide, setActiveSide] = useState<Side>('white');
  const [selectedNodeBySide, setSelectedNodeBySide] = useState<Record<Side, string>>({
    white: 'white-0',
    black: 'black-0',
  });
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [status, setStatus] = useState('Ready');
  const [engineDepth, setEngineDepth] = useState(16);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [engineStatus, setEngineStatus] = useState('idle');
  const [lichessData, setLichessData] = useState<LichessResponse | null>(null);
  const [lichessStatus, setLichessStatus] = useState('idle');
  const [playFilter, setPlayFilter] = useState('');
  const [movesFilter, setMovesFilter] = useState(12);
  const [sinceFilter, setSinceFilter] = useState('');
  const [untilFilter, setUntilFilter] = useState('');
  const [selectedSpeeds, setSelectedSpeeds] = useState<string[]>(['blitz', 'rapid', 'classical']);
  const [selectedRatings, setSelectedRatings] = useState<number[]>([1600, 1800, 2000, 2200]);

  const stockfishRef = useRef<Worker | null>(null);
  const engineReadyRef = useRef(false);
  const currentAnalysisRef = useRef(0);
  const lineCacheRef = useRef<Map<number, EngineLine>>(new Map());

  const tree = trees[activeSide];
  const selectedNodeId = selectedNodeBySide[activeSide] ?? tree.rootId;
  const selectedNode = tree.nodes[selectedNodeId] ?? tree.nodes[tree.rootId];

  const path = useMemo(() => buildPath(tree, selectedNode.id), [tree, selectedNode.id]);

  const childNodes = useMemo(
    () => selectedNode.children.map((id) => tree.nodes[id]).filter(Boolean),
    [selectedNode.children, tree.nodes],
  );

  const autoArrows = useMemo<DrawShape[]>(() => {
    return childNodes
      .map((node) => parseUciMove(node.moveUci))
      .filter((value): value is [Key, Key] => Boolean(value))
      .map(([orig, dest]) => ({ orig, dest, brush: 'green' }));
  }, [childNodes]);

  const lastMove = parseUciMove(selectedNode.moveUci);

  useEffect(() => {
    const loadBooks = async () => {
      setStatus('Loading PGN books...');
      try {
        const [whiteRes, blackRes] = await Promise.all([
          fetch('/api/book/white').then((r) => r.json()),
          fetch('/api/book/black').then((r) => r.json()),
        ]);

        const whiteTree = parsePgnToTree('white', whiteRes.pgn || '');
        const blackTree = parsePgnToTree('black', blackRes.pgn || '');

        setTrees({ white: whiteTree, black: blackTree });
        setSelectedNodeBySide({ white: whiteTree.rootId, black: blackTree.rootId });
        setStatus('Books loaded');
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

        lineCacheRef.current.set(multipv, { multipv, scoreText, pv, bestMove });
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

    const analysisId = currentAnalysisRef.current + 1;
    currentAnalysisRef.current = analysisId;
    lineCacheRef.current = new Map();
    setEngineLines([]);
    setEngineStatus('analyzing');

    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;

    stockfishRef.current.postMessage('stop');
    stockfishRef.current.postMessage('setoption name MultiPV value 3');
    stockfishRef.current.postMessage(`position fen ${fen}`);
    stockfishRef.current.postMessage(`go depth ${engineDepth}`);
  }, [selectedNode.fen, engineDepth]);

  useEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      setLichessStatus('loading');
      const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
      const params = new URLSearchParams({
        fen,
        variant: 'standard',
        moves: String(movesFilter),
      });
      if (playFilter.trim()) params.set('play', playFilter.trim());
      if (selectedSpeeds.length) params.set('speeds', selectedSpeeds.join(','));
      if (selectedRatings.length) params.set('ratings', selectedRatings.join(','));
      if (sinceFilter) params.set('since', sinceFilter);
      if (untilFilter) params.set('until', untilFilter);

      try {
        const res = await fetch(`/api/lichess?${params.toString()}`, { signal: controller.signal });
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
  }, [selectedNode.fen, movesFilter, playFilter, selectedSpeeds, selectedRatings, sinceFilter, untilFilter]);

  const makeMove = (orig: Key, dest: Key) => {
    setTrees((prev) => {
      const currentTree = prev[activeSide];
      const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
      const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
      const chess = fenToChess(currentNode.fen);
      const move = chess.move({ from: orig, to: dest, promotion: 'q' });

      if (!move) return prev;

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

      if (nextNodeId) {
        setSelectedNodeBySide((currentSelection) => ({
          ...currentSelection,
          [activeSide]: nextNodeId as string,
        }));
      }

      return {
        ...prev,
        [activeSide]: nextTree,
      };
    });
  };

  const saveBook = async () => {
    const pgn = exportTreeToPgn(tree);
    setStatus(`Saving ${activeSide} book...`);

    try {
      const res = await fetch(`/api/book/${activeSide}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pgn }),
      });
      if (!res.ok) throw new Error('save failed');
      setStatus(`${activeSide} book saved`);
    } catch {
      setStatus(`Failed to save ${activeSide} book`);
    }
  };

  const reloadBook = async () => {
    setStatus(`Reloading ${activeSide} book...`);
    try {
      const res = await fetch(`/api/book/${activeSide}`);
      if (!res.ok) throw new Error('reload failed');
      const payload = await res.json();
      const nextTree = parsePgnToTree(activeSide, payload.pgn || '');
      setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
      setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: nextTree.rootId }));
      setStatus(`${activeSide} book reloaded`);
    } catch {
      setStatus(`Failed to reload ${activeSide} book`);
    }
  };

  const deleteBranch = (branchRootId: string) => {
    setTrees((prev) => {
      const currentTree = prev[activeSide];
      const nextTree = removeBranch(currentTree, branchRootId);
      return { ...prev, [activeSide]: nextTree };
    });

    setSelectedNodeBySide((prev) => {
      const currentSelected = prev[activeSide];
      if (!isNodeInSubtree(tree, currentSelected, branchRootId)) return prev;
      const fallback = tree.nodes[branchRootId]?.parentId ?? tree.rootId;
      return { ...prev, [activeSide]: fallback };
    });
  };

  const lichessTotal = (lichessData?.white ?? 0) + (lichessData?.draws ?? 0) + (lichessData?.black ?? 0);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Opening Prep Trainer</h1>
        <div className="controls-row">
          <label>
            Repertoire
            <select value={activeSide} onChange={(e) => setActiveSide(e.target.value as Side)}>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </label>
          <button onClick={() => setOrientation((prev) => (prev === 'white' ? 'black' : 'white'))}>Rotate board</button>
          <button onClick={saveBook}>Save {activeSide} PGN</button>
          <button onClick={reloadBook}>Reload {activeSide} PGN</button>
          <span className="status">{status}</span>
        </div>
      </header>

      <main className="layout">
        <section className="left-panel">
          <Board
            fen={selectedNode.fen}
            orientation={orientation}
            lastMove={lastMove}
            arrows={autoArrows}
            onMove={makeMove}
          />

          <div className="card">
            <h2>Variants From Current Position</h2>
            {childNodes.length === 0 && <p>No child moves yet.</p>}
            {childNodes.map((node) => (
              <div key={node.id} className="variant-row">
                <button onClick={() => setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: node.id }))}>
                  {node.moveSan}
                </button>
                <button className="danger" onClick={() => deleteBranch(node.id)}>
                  Remove branch
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Stockfish (Local)</h2>
            <div className="controls-row">
              <label>
                Depth
                <input
                  type="number"
                  min={6}
                  max={28}
                  value={engineDepth}
                  onChange={(e) => setEngineDepth(Number(e.target.value) || 16)}
                />
              </label>
              <span className="status">{engineStatus}</span>
            </div>
            <div className="table">
              {engineLines.length === 0 && <p>No analysis yet.</p>}
              {engineLines.map((line) => (
                <div className="table-row" key={line.multipv}>
                  <span>#{line.multipv}</span>
                  <span>{line.bestMove || '-'}</span>
                  <span>{line.scoreText}</span>
                  <span>{line.pv}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Lichess Opening Database</h2>
            <div className="filters-grid">
              <label>
                Play sequence
                <input value={playFilter} onChange={(e) => setPlayFilter(e.target.value)} placeholder="e2e4,e7e5" />
              </label>
              <label>
                Moves
                <input
                  type="number"
                  min={2}
                  max={30}
                  value={movesFilter}
                  onChange={(e) => setMovesFilter(Number(e.target.value) || 12)}
                />
              </label>
              <label>
                Since (YYYY-MM)
                <input value={sinceFilter} onChange={(e) => setSinceFilter(e.target.value)} placeholder="2020-01" />
              </label>
              <label>
                Until (YYYY-MM)
                <input value={untilFilter} onChange={(e) => setUntilFilter(e.target.value)} placeholder="2026-02" />
              </label>
            </div>

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
            </div>

            <div className="status">{lichessStatus}</div>
            {lichessData && (
              <>
                <p>
                  {lichessData.opening ? `${lichessData.opening.eco} ${lichessData.opening.name}` : 'Opening not named'}
                </p>
                <p>
                  White {formatPercent(lichessData.white, lichessTotal)} | Draw {formatPercent(lichessData.draws, lichessTotal)} |
                  Black {formatPercent(lichessData.black, lichessTotal)} ({lichessTotal} games)
                </p>
                <div className="table">
                  {lichessData.moves?.slice(0, 12).map((move) => {
                    const total = move.white + move.draws + move.black;
                    return (
                      <div className="table-row" key={`${move.uci}-${move.san}`}>
                        <span>{move.san}</span>
                        <span>{move.uci}</span>
                        <span>{total}</span>
                        <span>
                          W {formatPercent(move.white, total)} / D {formatPercent(move.draws, total)} / B{' '}
                          {formatPercent(move.black, total)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </section>

        <aside className="right-panel card">
          <h2>Current Move List</h2>
          {path.length <= 1 && <p>Root position</p>}
          {path.slice(1).map((node, index) => (
            <div key={node.id} className="move-row">
              <button onClick={() => setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: node.id }))}>
                {Math.floor(index / 2) + 1}{index % 2 === 0 ? '.' : '...'} {node.moveSan}
              </button>
            </div>
          ))}
          <button onClick={() => setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: tree.rootId }))}>Back to root</button>
        </aside>
      </main>
    </div>
  );
}

export default App;
