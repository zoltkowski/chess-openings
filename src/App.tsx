import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type MouseEvent,
  type MouseEventHandler,
  type PointerEvent,
  type PointerEventHandler,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { Chess, type Move } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { DrawBrushes } from '@lichess-org/chessground/draw';
import { evaluateMaiaPosition, cancelMaiaEvaluations, isMaiaReady, MAIA_ENGINE_LABEL, subscribeMaiaStatus, type MaiaLoadingStatus } from './maiaEngine';
import { STOCKFISH_ENGINE_LABEL, STOCKFISH_ENGINE_NAME, STOCKFISH_VERSION } from './engineVersions';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './App.css';
import { GameReport } from './analysis/GameReport';
import { AnalysisButton } from './analysis/AnalysisButton';
import { runGameReview } from './analysis/gameReview';
import type { CandidateEvaluation, DecisionMetrics } from './analysis/decisionMetrics';
import type { AnalysisContext } from './analysis/AnalysisContextEditor';
import type { HumanReviewDetails } from './analysis/humanEvidence';
import { HumanMoveDetails } from './analysis/HumanMoveDetails';
import { MaiaPopularityChart, MaiaPopularityControls } from './MaiaPopularity';
import { useMaiaPopularity } from './useMaiaPopularity';
import { PlayerRepertoireTable, type PlayerMoveRow } from './analysis/PlayerRepertoireTable';
import { LichessStatsBar } from './analysis/LichessStatsBar';
import { CompactEngineArrowsButton } from './CompactEngineArrowsButton';
import { isTouchContextMenu, useLongPressAction, useLongPressMenu } from './useLongPressMenu';
import { mainMoveId, repertoireMoveStatus, setRepertoireMoveStatus, trainingMoveIds,
  type BoardAnnotation, type MoveNode, type MoveTree, type RepertoireMoveStatus } from './repertoireMoves';
import {
  indexPlayerGameHistory, playerGameHistoryStart, playerHistoryCovers, playerHistoryIndexIsCurrent,
  playerRepertoireDeviations, preprocessPlayerGameHistory, syncPlayerGameHistory, type PlayerGameHistory, type PlayerHistoryDates,
} from './analysis/playerGameHistory';
import {
  PLAYER_MISTAKE_LOSS,
  hasPlayedMistake,
  playerAssessmentKey,
  playerMistakePattern,
  playerMistakePriority,
  playerPositionLoss,
  playerScoreForWhite,
  playerTrainingBonus,
  type PlayerAssessment,
  type PlayerAssessments,
} from './analysis/playerRepertoire';

type Side = 'white' | 'black';
type RepertoireMode = 'review' | 'edit';

function RepertoireSelectButton({ name, className, mode, onSelect }: {
  name: string;
  className?: string;
  mode: RepertoireMode | null;
  onSelect: (mode: RepertoireMode) => void;
}) {
  const press = useLongPressAction(() => onSelect(mode === 'edit' ? 'review' : 'edit'), () => onSelect('review'));
  return <button type="button" className={className} title={`${name} — kliknij: przegląd otwarcia lub całej bazy, przytrzymaj lub kliknij prawym: zmień tryb edycji`}
    aria-label={`${name}, ${mode === 'edit' ? 'tryb edycji' : mode === 'review' ? 'tryb przeglądu' : 'nieaktywne'}`}
    {...press}>{name}</button>;
}

type LichessSource = 'lichess' | 'masters' | 'player';
type ExplorerDates = PlayerHistoryDates;
const MISTAKE_HISTORY_WINDOWS = [1, 3, 6, 12] as const;
type MistakeHistoryMonths = typeof MISTAKE_HISTORY_WINDOWS[number];
type DateRange = '1m' | '2m' | '3m' | '6m' | '1y' | '3y' | '5y' | '10y' | '20y' | '30y' | '50y' | null;
type ThemeMode = 'light' | 'dark';
type EngineChoice = 'stockfish' | 'maia';

type AnalysisScratchPosition = {
  fen: string;
  lastMove: [Key, Key] | null;
  playerMoves?: string[];
  enginePreview?: { previous: AnalysisScratchPosition | null; origin: AnalysisScratchPosition | null };
};

const REPERTOIRE_MOVE_LABELS: Record<RepertoireMoveStatus, string> = {
  main: 'Main move', alternative: 'Alternative', historical: 'Archived', experimental: 'Experiment',
};

type EngineLine = {
  multipv: number;
  scoreText: string;
  pv: string;
  bestMove: string;
  evalValue: number;
};

type MaiaStockfishComparison = {
  key: string;
  scores: Map<string, CandidateEvaluation>;
  stockfishMoves: CandidateEvaluation[];
  alternatives: CandidateEvaluation[];
  pending: boolean;
};

export type StockfishEvaluationResult = {
  scoreText: string; evalCp: number; bestMove: string | null; pv: string;
  depth: number; nodes: number; hasScore: boolean; wdl?: [number, number, number] | null;
  candidates?: CandidateEvaluation[];
};

export type GameAnalysisMoveResult = Partial<DecisionMetrics> & HumanReviewDetails & {
  nodeId: string;
  moveNumber: number;
  moveSan: string;
  mover: Side;
  bestMoveUci: string | null;
  bestScoreText: string | null;
  playedScoreText: string | null;
  bestScoreCp: number | null;
  playedScoreCp: number | null;
  bestWdl?: [number, number, number] | null;
  playedWdl?: [number, number, number] | null;
  bestPv: string;
  playedPv: string;
  terminalOutcome: 'checkmate' | 'draw' | null;
  depth: number;
  nodes: number;
  lossPoints: number | null;
  category: 'book' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'unavailable';
  status: 'book' | 'complete' | 'uncertain' | 'unavailable';
  bookRepertoireName?: string;
  maiaStatus?: 'complete' | 'unavailable' | 'skipped';
  maiaUnavailableReason?: string;
  maiaPlayedProbability?: number | null;
  maiaPlayedRank?: number | null;
  maiaTopMoveUci?: string | null;
  maiaTopMoveProbability?: number | null;
  maiaWinProbability?: number | null;
  maiaElo?: number;
  maiaAnchorElo?: number;
  maiaOpponentElo?: number;
  maiaRatingSource?: 'pgn' | 'manual' | 'benchmark';
  maiaBaselineTag?: 'above' | 'below' | null;
  profileOpponentElo?: number;
  goodMassLower?: number;
  goodMassUpper?: number;
  obvious?: boolean;
  greatFind?: boolean;
  attackEvidence?: string;
  checkedOpponent?: boolean;
  answeredCheck?: boolean;
  difficultyScore?: number;
  practicalGoodMassLower?: number;
  practicalGoodMassUpper?: number;
  practicalPressureScore?: number;
  practicalQualityScore?: number;
  responseEntropy?: number;
  opponentMissedPunishment?: boolean;
  openingEvidence?: { name?: string; totalGames: number; playedGames?: number; frequency?: number };
  tablebaseEvidence?: { category: string };
  ratingSystem?: string;
  ratingPool?: string;
  uncertaintyReason?: string;
};

type GameAnalysisReport = {
  version: 2;
  gameKey: string;
  sourceId?: string;
  rootNodeId?: string;
  rootFen?: string;
  side: Side;
  createdAt: number;
  engine: string;
  maiaEngine?: string;
  maiaElo?: number;
  playerRatings?: { white?: number; black?: number };
  reviewMode?: 'quick' | 'deep';
  depth: number;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'error';
  results: GameAnalysisMoveResult[];
};

type GameAnalysisProgress = {
  done: number;
  total: number;
  moveText: string;
  phase: 'book' | 'maia' | 'best' | 'played' | 'refine' | 'alternatives' | 'profile';
  liveScoreText: string | null;
  detail?: string;
};

type LichessMove = {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
  averageElo?: number;
  game?: LichessExampleGame;
  lastPlayedAt?: number;
};

type LichessExamplePlayer = {
  name?: string;
  title?: string;
  rating?: number;
};

type LichessExampleGame = {
  uci?: string;
  id?: string;
  winner?: string;
  speed?: string;
  mode?: string;
  year?: number;
  month?: string;
  createdAt?: number;
  white?: LichessExamplePlayer;
  black?: LichessExamplePlayer;
};

type LichessResponse = {
  opening?: { eco: string; name: string };
  white: number;
  draws: number;
  black: number;
  moves: LichessMove[];
  topGames?: LichessExampleGame[];
  recentGames?: LichessExampleGame[];
  queuePosition?: number;
};

type LichessResponseCacheEntry = {
  expiresAt: number;
  data: LichessResponse;
};

type RepertoireReviewNode = { node: MoveNode; prepared: Set<string> };

type MistakeReviewMove = {
  uci: string;
  inRepertoire: boolean;
  score?: string;
  provisional: boolean;
  results: { wins: number; draws: number; losses: number };
  recent: number;
  earlier: number;
  lastMonth?: string;
  lastPlayedAt?: number;
};

type MistakeReviewPosition = {
  node: MoveNode;
  moves: MistakeReviewMove[];
  recentGames: number;
  earlierGames: number;
  recentSince: string;
  sinceMonth: string;
  fromHistory: boolean;
};

type MistakeReview = {
  nodes: RepertoireReviewNode[];
  positions: MistakeReviewPosition[];
  index: number;
  nextNode: number;
  exhausted: boolean;
};

type OpponentFinding = {
  node: MoveNode;
  moves: Set<string>;
  prepared: Set<string>;
  data: LichessResponse;
};

type OpponentReview = {
  nodes: RepertoireReviewNode[];
  findings: OpponentFinding[];
  index: number;
  nextNode: number;
  waitingForNext: boolean;
  exhausted: boolean;
  fromHistory?: boolean;
};

type UndoSnapshot = {
  tree: MoveTree;
  selectedNodeId: string;
};

type TrainingSession = {
  side: Side;
  rootNodeId: string;
  entryNodeId: string;
  flashcardMode: boolean;
  suddenDeathMode: boolean;
  suddenDeathBaseEvalCp: number | null;
  hintRequested: boolean;
  hintVisible: boolean;
  hintMoveUci: string | null;
  completedLeafNodeIds: string[];
  errorCount: number;
  correctCount: number;
  currentPromptFen: string | null;
  currentPromptHadError: boolean;
  currentPromptScopeIds: string[];
};

type TrainingPositionStat = {
  recentAnswers: number[];
};

type TrainingStatsState = Record<Side, Record<string, Record<string, TrainingPositionStat>>>;
type TrainingLeafLastShownState = Record<Side, Record<string, Record<string, number>>>;
type EvalPassProgress = { done: number; total: number };
type TreeEvalProgressState = {
  running: boolean;
  phase: 'idle' | 'cloud' | 'local' | 'done';
  cloud: EvalPassProgress;
  local: EvalPassProgress;
};

type SuddenDeathPosition = {
  fen: string;
  move?: { uci: string; label: string; squares: [Key, Key] };
  evaluation?: StockfishEvaluationResult;
  terminal?: string;
};

type SuddenDeathRound = {
  startNodeId: string;
  chess: Chess;
  positions: SuddenDeathPosition[];
};

type SuddenDeathGameOverState = {
  side: Side;
  startNodeId: string;
  positions: SuddenDeathPosition[];
  index: number;
  reason: 'drop' | 'terminal' | 'unavailable';
};

function suddenDeathPositionCommand(positions: SuddenDeathPosition[], index = positions.length - 1) {
  const moves = positions.slice(1, index + 1).map(position => position.move!.uci);
  return `position fen ${positions[0].fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
}

type ExampleReplayState = {
  side: Side;
  gameId: string;
  label: string;
  fens: string[];
  lastMoves: Array<[Key, Key] | null>;
  currentIndex: number;
  playing: boolean;
};

type PersistedAppState = {
  version: 2;
  repertoiresBySide: Record<Side, RepertoireEntry[]>;
  activeRepertoireIdBySide: Record<Side, string | null>;
  browseAnnotations?: Record<string, BoardAnnotation[]>;
};

type LegacyPersistedAppState = {
  version: 1;
  trees: Record<Side, MoveTree>;
  selectedNodeBySide: Record<Side, string>;
};

type RepertoireEntry = {
  id: string;
  name: string;
  enabled: boolean;
  tree: MoveTree;
  selectedNodeId: string;
};

type BrowseMoveOption = {
  moveUci: string;
  moveSan: string;
  repertoireNames: string[];
};

type PersistedSettingsState = {
  version: 1;
  themeMode: ThemeMode;
  selectedEngine: EngineChoice;
  bothEngines: boolean;
  maiaStrengthElo: number;
  analysisBenchmarkElo: number;
  suddenDeathEngine: EngineChoice;
  suddenDeathMaiaElo: number;
  repertoireSide: Side;
  isTempBoardFlipped: boolean;
  lichessSource: LichessSource;
  playerHandle: string;
  playerSpeeds: string[];
  lichessApiToken: string;
  dateRange: DateRange;
  lichessArrowThreshold: MoveThreshold;
  engineDepth: number;
  engineMultiPv: number;
  selectedSpeeds: string[];
  selectedRatings: number[];
  selectedModes: string[];
  showLichessOnTreeMoves: boolean;
  lichessArrowsOpponentOnly: boolean;
  showMistakeArrows: boolean;
  mistakeHistoryMonths: MistakeHistoryMonths;
  showTreeArrows: boolean;
  showLichessArrows: boolean;
  showStockfishArrows: boolean;
  showMaiaArrows: boolean;
  combineCompactEngineArrows: boolean;
  stockfishEvalSeconds: number;
  trainingStatsQueueLength: number;
  trainAlternativeMoves: boolean;
  suddenDeathThreshold: number;
  suddenDeathMinMoves: number;
  suddenDeathStockfishElo: number;
  suddenDeathMaxThinkTimeSec: number;
  nextMissingMoveThreshold: MoveThreshold;
  playerNextMissingMoveThreshold: MoveThreshold;
  desktopLichessShare: number;
};

type BackupPayload = {
  version: 1;
  exportedAt: string;
  appState: PersistedAppState;
  settings: PersistedSettingsState | null;
  trainingStats: TrainingStatsState;
  trainingLeafLastShown: TrainingLeafLastShownState;
};

const START_FEN = 'start';
const START_POS_FEN = new Chess().fen();
const FIXED_VARIANT = 'standard';
const FIXED_SOURCE = 'analysis';
const MOVE_THRESHOLD_OPTIONS = [0, 1, 2, 3, 4, 5, 10, 20] as const;
const DESKTOP_SPLIT_DEFAULT = 50;
const DESKTOP_SPLIT_MIN = 15;
const DESKTOP_SPLIT_MAX = 85;
type MoveThreshold = (typeof MOVE_THRESHOLD_OPTIONS)[number];
const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const;
const PLAYER_SPEEDS = ['ultraBullet', ...SPEEDS] as const;
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
  annotation: { key: 'annotation', color: '#d10076', opacity: 1, lineWidth: 11 },
  green: { key: 'g', color: '#15781b', opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
  purple: { key: 'p', color: '#7c3aed', opacity: 1, lineWidth: 10 },
  yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
  greenSoft: { key: 'gs', color: '#15781b', opacity: 0.5, lineWidth: 10 },
  blueSoft: { key: 'bs', color: '#003088', opacity: 0.5, lineWidth: 10 },
  purpleSoft: { key: 'ps', color: '#7c3aed', opacity: 0.5, lineWidth: 10 },
  yellowSoft: { key: 'ys', color: '#e68f00', opacity: 0.5, lineWidth: 10 },
};
const APP_DB_NAME = 'opening-prep-db';
const APP_DB_VERSION = 1;
const PROJECT_GITHUB_URL = 'https://github.com/zoltkowski/chess-openings';
const APP_DB_STORE = 'kv';
const APP_STATE_KEY = 'app-state-v1';
const APP_SETTINGS_KEY = 'settings-v1';
const APP_TRAINING_STATS_KEY = 'training-stats-v1';
const APP_TRAINING_LEAF_LAST_SHOWN_KEY = 'training-leaf-last-shown-v1';
const APP_LICHESS_RESPONSE_CACHE_KEY = 'lichess-response-cache-v1';
const APP_PLAYER_ASSESSMENTS_KEY = `player-assessments-v1-${STOCKFISH_VERSION}`;
const APP_GAME_ANALYSIS_REPORT_KEY = 'game-analysis-report-v1';
const BACKUP_FILE_PREFIX = 'opening-prep-backup-';
const BACKUP_FILE_EXTENSION = '.json';
const BACKUP_FILE_MIME_TYPE = 'application/json';
const TRAINING_SCOPE_WHOLE_DB = 'whole-db';
const TRAINING_STATS_QUEUE_MIN = 1;
const TRAINING_STATS_QUEUE_MAX = 30;
const SUDDEN_DEATH_THRESHOLD_MIN = 0;
const SUDDEN_DEATH_THRESHOLD_MAX = 3;
const SUDDEN_DEATH_MIN_MOVES_MIN = 0;
const SUDDEN_DEATH_MIN_MOVES_MAX = 30;
const SUDDEN_DEATH_STOCKFISH_ELO_MIN = 1200;
const SUDDEN_DEATH_STOCKFISH_ELO_MAX = 3000;
const SUDDEN_DEATH_THINK_TIME_MIN = 0.2;
const SUDDEN_DEATH_THINK_TIME_MAX = 5;
const MAIA_STRENGTH_ELO_MIN = 1100;
const MAIA_STRENGTH_ELO_MAX = 3000;
const MAIA_STRENGTH_ELO_STEP = 100;
const MAIA_STRENGTH_ELO_VALUES = Array.from(
  { length: Math.floor((MAIA_STRENGTH_ELO_MAX - MAIA_STRENGTH_ELO_MIN) / MAIA_STRENGTH_ELO_STEP) + 1 },
  (_, index) => MAIA_STRENGTH_ELO_MIN + (index * MAIA_STRENGTH_ELO_STEP),
);
// Conservative pacing for explorer API requests to avoid 429 and respect public API usage guidance.
const LICHESS_API_MIN_INTERVAL_MS = 2000;
const LICHESS_API_COOLDOWN_FALLBACK_MS = 120000;
const LICHESS_CACHE_PLAYER_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYER_HISTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PLAYER_HISTORY_SYNC_CHECK_MS = 60_000;
const LICHESS_CACHE_PLAYER_LIMIT = 1500;
const LICHESS_CACHE_DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;
const LICHESS_CACHE_DEFAULT_JITTER_MS = 5 * 24 * 60 * 60 * 1000;
const LICHESS_CACHE_DAY_MS = 24 * 60 * 60 * 1000;
function maxTopGamesForSource(source: LichessSource) {
  if (source === 'masters') return 15;
  if (source === 'lichess') return 4;
  return 0;
}

function maxRecentGamesForSource(source: LichessSource) {
  if (source === 'player') return 8;
  if (source === 'lichess') return 4;
  return 0;
}

function explorerDateFilter(source: LichessSource, range: DateRange) {
  if (!range) return null;
  const months = { '1m': 0, '2m': 1, '3m': 2, '6m': 5 } as const;
  const years = { '1y': 1, '3y': 3, '5y': 5, '10y': 10 } as const;
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth(), 1);
  if (range in months && source === 'player') {
    since.setMonth(since.getMonth() - months[range as keyof typeof months]);
  } else if (range in years && !(source === 'player' && (range === '5y' || range === '10y'))) {
    since.setFullYear(since.getFullYear() - years[range as keyof typeof years]);
  } else {
    return null;
  }
  const format = (date: Date) => source === 'masters'
    ? String(date.getFullYear())
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return { since: format(since), until: format(now) };
}

function isPlayerExplorerUrl(url: string) {
  return url.startsWith('https://explorer.lichess.ovh/player?');
}

function lichessCacheKey(url: string) {
  if (isPlayerExplorerUrl(url)) return url;
  try {
    const parsed = new URL(url);
    const fen = parsed.searchParams.get('fen');
    if (fen) parsed.searchParams.set('fen', positionFenKey(fen) + ' 0 1');
    return parsed.toString();
  } catch {
    return url;
  }
}

function monthNumber(month: string) {
  const [year, number] = month.split('-').map(Number);
  return year * 12 + number - 1;
}

function monthKey(month: number) {
  return `${Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}`;
}

function playerGameMonth(game: LichessExampleGame | undefined) {
  const month = game?.month;
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
}

function formatPlayerMonth(month: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T00:00:00Z`));
}

function explorerGameCount(value: { white: number; draws: number; black: number }) {
  return value.white + value.draws + value.black;
}
const CLOUD_EVAL_MIN_INTERVAL_MS = 1400;
const CLOUD_EVAL_RETRY_FALLBACK_MS = 4000;
const CLOUD_EVAL_MAX_RETRIES = 3;

function createRepertoireId(side: Side) {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${side}-${Date.now().toString(36)}-${randomPart}`;
}

function normalizeRepertoireName(value: string) {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed || 'Untitled repertoire';
}

function waitMs(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(retryAfter: string | null) {
  if (!retryAfter) return null;
  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(retryAfter);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : 0;
}

function repertoireHasMoves(tree: MoveTree) {
  const root = tree.nodes[tree.rootId];
  if (root?.children.length) return true;
  return Object.values(tree.nodes).some((node) => Boolean(node.moveUci));
}

function createEmptyRepertoire(side: Side, name: string): RepertoireEntry {
  const tree = createEmptyTree(side);
  return {
    id: createRepertoireId(side),
    name: normalizeRepertoireName(name),
    enabled: true,
    tree,
    selectedNodeId: tree.rootId,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function openAppDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(APP_DB_NAME, APP_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APP_DB_STORE)) {
        db.createObjectStore(APP_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_DB_STORE, 'readonly');
    const store = tx.objectStore(APP_DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openAppDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(APP_DB_STORE, 'readwrite');
    const store = tx.objectStore(APP_DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function idbUpdate<T>(key: string, update: (previous: T | undefined) => T) {
  const db = await openAppDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(APP_DB_STORE, 'readwrite');
    const store = tx.objectStore(APP_DB_STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      store.put(update(request.result as T | undefined), key);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

function savePlayerAssessment(key: string, assessment: PlayerAssessment) {
  return idbUpdate<PlayerAssessments>(APP_PLAYER_ASSESSMENTS_KEY, (assessments = {}) => {
    const existing = assessments[key];
    const observed = { ...existing?.observed };
    for (const [uci, count] of Object.entries(assessment.observed)) {
      observed[uci] = Math.max(observed[uci] ?? 0, count);
    }
    return {
      ...assessments,
      [key]: { ...assessment, moves: { ...existing?.moves, ...assessment.moves }, observed },
    };
  });
}

function isValidMoveTree(value: unknown): value is MoveTree {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as MoveTree;
  if (typeof candidate.rootId !== 'string') return false;
  if (typeof candidate.nextId !== 'number' || !Number.isFinite(candidate.nextId)) return false;
  if (!candidate.nodes || typeof candidate.nodes !== 'object') return false;
  return true;
}

function readBoardAnnotations(value: unknown): BoardAnnotation[] {
  const isSquare = (square: unknown): square is Key => typeof square === 'string' && /^[a-h][1-8]$/.test(square);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('orig' in item) || !isSquare(item.orig)) return [];
    if ('dest' in item && item.dest !== undefined && !isSquare(item.dest)) return [];
    return [{ orig: item.orig, dest: 'dest' in item && isSquare(item.dest) ? item.dest : undefined }];
  });
}

function normalizePersistedState(value: unknown): PersistedAppState | null {
  if (!value || typeof value !== 'object') return null;

  const parsedV2 = value as PersistedAppState;
  if (parsedV2.version === 2) {
    if (!parsedV2.repertoiresBySide || !parsedV2.activeRepertoireIdBySide) return null;
    const normalizeSide = (side: Side): RepertoireEntry[] => {
      const list = Array.isArray(parsedV2.repertoiresBySide[side]) ? parsedV2.repertoiresBySide[side] : [];
      const valid = list.filter((entry): entry is RepertoireEntry => {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.id !== 'string' || !entry.id.trim()) return false;
        if (typeof entry.name !== 'string') return false;
        if (typeof entry.selectedNodeId !== 'string') return false;
        if (!isValidMoveTree(entry.tree)) return false;
        return true;
      });
      if (valid.length > 0) {
        return valid.map((entry, index) => ({
          ...entry,
          name: normalizeRepertoireName(entry.name || `${side} repertoire ${index + 1}`),
          enabled: entry.enabled !== false,
          selectedNodeId: entry.tree.nodes[entry.selectedNodeId] ? entry.selectedNodeId : entry.tree.rootId,
        }));
      }
      return [];
    };

    const whiteList = normalizeSide('white');
    const blackList = normalizeSide('black');
    const whiteActive =
      typeof parsedV2.activeRepertoireIdBySide.white === 'string' ? parsedV2.activeRepertoireIdBySide.white : null;
    const blackActive =
      typeof parsedV2.activeRepertoireIdBySide.black === 'string' ? parsedV2.activeRepertoireIdBySide.black : null;

    return {
      version: 2,
      browseAnnotations: Object.fromEntries(Object.entries(parsedV2.browseAnnotations ?? {})
        .map(([key, value]) => [key, readBoardAnnotations(value)] as const).filter(([, value]) => value.length > 0)),
      repertoiresBySide: {
        white: whiteList,
        black: blackList,
      },
      activeRepertoireIdBySide: {
        white: whiteActive && whiteList.some((entry) => entry.id === whiteActive && entry.enabled) ? whiteActive : null,
        black: blackActive && blackList.some((entry) => entry.id === blackActive && entry.enabled) ? blackActive : null,
      },
    };
  }

  const parsedV1 = value as LegacyPersistedAppState;
  if (parsedV1.version !== 1) return null;
  if (!parsedV1.trees || !parsedV1.selectedNodeBySide) return null;
  if (!isValidMoveTree(parsedV1.trees.white) || !isValidMoveTree(parsedV1.trees.black)) return null;
  if (typeof parsedV1.selectedNodeBySide.white !== 'string' || typeof parsedV1.selectedNodeBySide.black !== 'string') {
    return null;
  }

  const whiteTree = parsedV1.trees.white;
  const blackTree = parsedV1.trees.black;
  const whiteRepertoire: RepertoireEntry = {
    id: createRepertoireId('white'),
    name: 'Imported white repertoire',
    enabled: true,
    tree: whiteTree,
    selectedNodeId: whiteTree.nodes[parsedV1.selectedNodeBySide.white] ? parsedV1.selectedNodeBySide.white : whiteTree.rootId,
  };
  const blackRepertoire: RepertoireEntry = {
    id: createRepertoireId('black'),
    name: 'Imported black repertoire',
    enabled: true,
    tree: blackTree,
    selectedNodeId: blackTree.nodes[parsedV1.selectedNodeBySide.black] ? parsedV1.selectedNodeBySide.black : blackTree.rootId,
  };

  return {
    version: 2,
    repertoiresBySide: {
      white: [whiteRepertoire],
      black: [blackRepertoire],
    },
    activeRepertoireIdBySide: {
      white: null,
      black: null,
    },
  };
}

function normalizePersistedSettings(value: unknown): PersistedSettingsState | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as PersistedSettingsState;
  if (parsed.version !== 1) return null;
  if (parsed.repertoireSide !== 'white' && parsed.repertoireSide !== 'black') return null;
  if (parsed.lichessSource !== 'lichess' && parsed.lichessSource !== 'masters' && parsed.lichessSource !== 'player') {
    return null;
  }
  const normalizedSelectedEngine: EngineChoice = parsed.selectedEngine === 'maia' ? 'maia' : 'stockfish';
  const normalizedThemeMode: ThemeMode = parsed.themeMode === 'dark' ? 'dark' : 'light';
  const dateRangeValues: DateRange[] = ['1m', '2m', '3m', '6m', '1y', '3y', '5y', '10y', '20y', '30y', '50y', null];
  if (!dateRangeValues.includes(parsed.dateRange)) return null;
  return {
    ...parsed,
    themeMode: normalizedThemeMode,
    selectedEngine: normalizedSelectedEngine,
    bothEngines: normalizedSelectedEngine === 'maia' && parsed.bothEngines === true,
    showStockfishArrows: parsed.showStockfishArrows ?? true,
    showMaiaArrows: parsed.showMaiaArrows ?? parsed.showStockfishArrows ?? true,
    combineCompactEngineArrows: parsed.combineCompactEngineArrows === true,
    trainAlternativeMoves: parsed.trainAlternativeMoves === true,
    lichessArrowsOpponentOnly: parsed.lichessArrowsOpponentOnly === true,
    showMistakeArrows: parsed.showMistakeArrows === true,
    mistakeHistoryMonths: MISTAKE_HISTORY_WINDOWS.includes(parsed.mistakeHistoryMonths) ? parsed.mistakeHistoryMonths : 12,
    analysisBenchmarkElo: clampInt((parsed as Partial<PersistedSettingsState>).analysisBenchmarkElo, 1100, 3000, 1800),
    maiaStrengthElo: clampInt(
      (parsed as Partial<PersistedSettingsState>).maiaStrengthElo,
      MAIA_STRENGTH_ELO_MIN,
      MAIA_STRENGTH_ELO_MAX,
      1500,
    ),
    suddenDeathEngine:
      (parsed as Partial<PersistedSettingsState>).suddenDeathEngine === 'maia' ? 'maia' : 'stockfish',
    suddenDeathMaiaElo: clampInt(
      (parsed as Partial<PersistedSettingsState>).suddenDeathMaiaElo,
      MAIA_STRENGTH_ELO_MIN,
      MAIA_STRENGTH_ELO_MAX,
      1500,
    ),
    lichessArrowThreshold: normalizeMoveThreshold(parsed.lichessArrowThreshold),
    engineDepth: clampInt(parsed.engineDepth, 16, 32, 24),
    engineMultiPv: clampInt(parsed.engineMultiPv, 1, 10, 3),
    selectedSpeeds: (parsed.selectedSpeeds ?? []).filter((speed): speed is string =>
      SPEEDS.includes(speed as (typeof SPEEDS)[number]),
    ),
    selectedRatings: (parsed.selectedRatings ?? []).filter((rating): rating is number => RATINGS.includes(rating)),
    selectedModes: (parsed.selectedModes ?? []).filter((mode): mode is string =>
      MODES.includes(mode as (typeof MODES)[number]),
    ),
    playerHandle: typeof parsed.playerHandle === 'string' ? parsed.playerHandle : '',
    playerSpeeds: Array.isArray(parsed.playerSpeeds)
      ? PLAYER_SPEEDS.filter(speed => parsed.playerSpeeds.includes(speed)) : [...PLAYER_SPEEDS],
    lichessApiToken: typeof (parsed as Partial<PersistedSettingsState>).lichessApiToken === 'string'
      ? (parsed as Partial<PersistedSettingsState>).lichessApiToken as string
      : '',
    stockfishEvalSeconds: clampInt((parsed as Partial<PersistedSettingsState>).stockfishEvalSeconds, 1, 30, 10),
    trainingStatsQueueLength: clampInt(
      (parsed as Partial<PersistedSettingsState>).trainingStatsQueueLength,
      TRAINING_STATS_QUEUE_MIN,
      TRAINING_STATS_QUEUE_MAX,
      5,
    ),
    suddenDeathThreshold:
      typeof (parsed as Partial<PersistedSettingsState>).suddenDeathThreshold === 'number' &&
      Number.isFinite((parsed as Partial<PersistedSettingsState>).suddenDeathThreshold)
        ? Math.min(
            SUDDEN_DEATH_THRESHOLD_MAX,
            Math.max(SUDDEN_DEATH_THRESHOLD_MIN, (parsed as Partial<PersistedSettingsState>).suddenDeathThreshold as number),
          )
        : 1,
    suddenDeathMinMoves: clampInt(
      (parsed as Partial<PersistedSettingsState>).suddenDeathMinMoves,
      SUDDEN_DEATH_MIN_MOVES_MIN,
      SUDDEN_DEATH_MIN_MOVES_MAX,
      4,
    ),
    suddenDeathStockfishElo: clampInt(
      (parsed as Partial<PersistedSettingsState>).suddenDeathStockfishElo,
      SUDDEN_DEATH_STOCKFISH_ELO_MIN,
      SUDDEN_DEATH_STOCKFISH_ELO_MAX,
      2000,
    ),
    suddenDeathMaxThinkTimeSec:
      typeof (parsed as Partial<PersistedSettingsState>).suddenDeathMaxThinkTimeSec === 'number' &&
      Number.isFinite((parsed as Partial<PersistedSettingsState>).suddenDeathMaxThinkTimeSec)
        ? Math.min(
            SUDDEN_DEATH_THINK_TIME_MAX,
            Math.max(
              SUDDEN_DEATH_THINK_TIME_MIN,
              (parsed as Partial<PersistedSettingsState>).suddenDeathMaxThinkTimeSec as number,
            ),
          )
        : 1,
    nextMissingMoveThreshold: normalizeMoveThreshold(
      (parsed as Partial<PersistedSettingsState>).nextMissingMoveThreshold,
    ),
    playerNextMissingMoveThreshold: normalizeMoveThreshold(parsed.playerNextMissingMoveThreshold ?? 0),
    desktopLichessShare: normalizeDesktopLichessShare(parsed.desktopLichessShare),
  };
}

function normalizeDesktopLichessShare(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DESKTOP_SPLIT_DEFAULT;
  return Math.min(DESKTOP_SPLIT_MAX, Math.max(DESKTOP_SPLIT_MIN, value));
}

function createEmptyTrainingStatsState(): TrainingStatsState {
  return {
    white: {},
    black: {},
  };
}

function createEmptyTrainingLeafLastShownState(): TrainingLeafLastShownState {
  return {
    white: {},
    black: {},
  };
}

function normalizeTrainingStats(value: unknown): TrainingStatsState | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<TrainingStatsState>;
  const normalizeSide = (side: Side) => {
    const sideValue = parsed[side];
    if (!sideValue || typeof sideValue !== 'object') return {};
    const nextScopes: Record<string, Record<string, TrainingPositionStat>> = {};
    Object.entries(sideValue as Record<string, unknown>).forEach(([scopeKey, scopeValue]) => {
      if (!scopeValue || typeof scopeValue !== 'object') return;
      const nextFenStats: Record<string, TrainingPositionStat> = {};
      Object.entries(scopeValue as Record<string, unknown>).forEach(([fenKey, fenStatValue]) => {
        if (!fenStatValue || typeof fenStatValue !== 'object') return;
        const raw = fenStatValue as Partial<TrainingPositionStat> & { shown?: number; correct?: number };
        if (Array.isArray(raw.recentAnswers)) {
          const normalizedRecentAnswers = raw.recentAnswers
            .map((value) => (value ? 1 : 0))
            .slice(-TRAINING_STATS_QUEUE_MAX);
          nextFenStats[fenKey] = {
            recentAnswers: normalizedRecentAnswers,
          };
          return;
        }

        // Backward compatibility: old format stored cumulative shown/correct counts.
        const shown = typeof raw.shown === 'number' && Number.isFinite(raw.shown) ? Math.max(0, Math.floor(raw.shown)) : 0;
        const correct = typeof raw.correct === 'number' && Number.isFinite(raw.correct)
          ? Math.max(0, Math.floor(raw.correct))
          : 0;
        const boundedShown = Math.min(TRAINING_STATS_QUEUE_MAX, shown);
        const boundedCorrect = Math.min(boundedShown, correct);
        nextFenStats[fenKey] = {
          recentAnswers: [
            ...new Array(boundedCorrect).fill(1),
            ...new Array(boundedShown - boundedCorrect).fill(0),
          ],
        };
      });
      if (Object.keys(nextFenStats).length > 0) {
        nextScopes[scopeKey] = nextFenStats;
      }
    });
    return nextScopes;
  };
  return {
    white: normalizeSide('white'),
    black: normalizeSide('black'),
  };
}

function normalizeTrainingLeafLastShown(value: unknown): TrainingLeafLastShownState | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<TrainingLeafLastShownState>;
  const normalizeSide = (side: Side) => {
    const sideValue = parsed[side];
    if (!sideValue || typeof sideValue !== 'object') return {};
    const nextScopes: Record<string, Record<string, number>> = {};
    Object.entries(sideValue as Record<string, unknown>).forEach(([scopeId, scopeValue]) => {
      if (!scopeValue || typeof scopeValue !== 'object') return;
      const nextLeafEntries: Record<string, number> = {};
      Object.entries(scopeValue as Record<string, unknown>).forEach(([leafKey, rawTimestamp]) => {
        if (typeof rawTimestamp !== 'number' || !Number.isFinite(rawTimestamp)) return;
        nextLeafEntries[leafKey] = rawTimestamp;
      });
      if (Object.keys(nextLeafEntries).length > 0) {
        nextScopes[scopeId] = nextLeafEntries;
      }
    });
    return nextScopes;
  };
  return {
    white: normalizeSide('white'),
    black: normalizeSide('black'),
  };
}

function formatBackupTimestamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}Z`;
}

function createBackupFilename(date = new Date()) {
  return `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(date)}${BACKUP_FILE_EXTENSION}`;
}

function readBackupTimestampFromFilename(filename: string) {
  const match = filename.match(/opening-prep-backup-(\d{8})-(\d{6})Z\.json$/);
  if (match) {
    const [, datePart, timePart] = match;
    const year = Number.parseInt(datePart.slice(0, 4), 10);
    const month = Number.parseInt(datePart.slice(4, 6), 10) - 1;
    const day = Number.parseInt(datePart.slice(6, 8), 10);
    const hour = Number.parseInt(timePart.slice(0, 2), 10);
    const minute = Number.parseInt(timePart.slice(2, 4), 10);
    const second = Number.parseInt(timePart.slice(4, 6), 10);
    const timestamp = Date.UTC(year, month, day, hour, minute, second);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toLocaleString();
    }
  }
  return null;
}

function normalizeBackupPayload(value: unknown): BackupPayload | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<BackupPayload>;
  if (parsed.version !== 1) return null;

  const normalizedAppState = normalizePersistedState(parsed.appState);
  if (!normalizedAppState) return null;
  const normalizedSettings = parsed.settings ? normalizePersistedSettings(parsed.settings) : null;
  const normalizedTrainingStats = normalizeTrainingStats(parsed.trainingStats) ?? createEmptyTrainingStatsState();
  const normalizedLeafLastShown =
    normalizeTrainingLeafLastShown(parsed.trainingLeafLastShown) ?? createEmptyTrainingLeafLastShownState();
  const exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString();

  return {
    version: 1,
    exportedAt,
    appState: normalizedAppState,
    settings: normalizedSettings,
    trainingStats: normalizedTrainingStats,
    trainingLeafLastShown: normalizedLeafLastShown,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
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

type BookRepertoireIndex = {
  id: string;
  name: string;
  movesByFen: Map<string, Set<string>>;
};

function buildBookRepertoireIndex(repertoires: RepertoireEntry[]): BookRepertoireIndex[] {
  return repertoires.filter((entry) => repertoireHasMoves(entry.tree)).map((repertoire) => {
    const movesByFen = new Map<string, Set<string>>();
    for (const node of Object.values(repertoire.tree.nodes)) {
      const fenKey = bookPositionFenKey(node.fen);
      for (const childId of node.children) {
        const moveUci = repertoire.tree.nodes[childId]?.moveUci;
        if (!moveUci) continue;
        const moves = movesByFen.get(fenKey) ?? new Set<string>();
        moves.add(moveUci);
        movesByFen.set(fenKey, moves);
      }
    }
    return { id: repertoire.id, name: repertoire.name, movesByFen };
  });
}

function findBookMovesForGame(gamePath: MoveNode[], repertoires: BookRepertoireIndex[]) {
  const matchesByNodeId = new Map<string, BookRepertoireIndex[]>();
  const matchCounts = new Map<string, number>();

  for (const repertoire of repertoires) {
    let matchedMoveCount = 0;
    for (let index = 1; index < gamePath.length; index += 1) {
      const beforeNode = gamePath[index - 1];
      const playedNode = gamePath[index];
      if (!playedNode.moveUci) continue;
      const targetFenKey = bookPositionFenKey(beforeNode.fen);
      const isInRepertoire = repertoire.movesByFen.get(targetFenKey)?.has(playedNode.moveUci) ?? false;
      if (!isInRepertoire) continue;
      matchedMoveCount += 1;
      const providers = matchesByNodeId.get(playedNode.id) ?? [];
      providers.push(repertoire);
      matchesByNodeId.set(playedNode.id, providers);
    }
    matchCounts.set(repertoire.id, matchedMoveCount);
  }

  const result = new Map<string, { repertoireName: string }>();
  for (const [nodeId, providers] of matchesByNodeId) {
    const preferred = [...providers].sort(
      (a, b) => (matchCounts.get(b.id) ?? 0) - (matchCounts.get(a.id) ?? 0) || a.name.localeCompare(b.name),
    )[0];
    if (preferred) result.set(nodeId, { repertoireName: preferred.name });
  }
  return result;
}

function playerExplorerMoves(fen: string, moves: LichessMove[]) {
  if (!moves.some(move => /^O-O/.test(move.san))) return moves;
  const legal = new Map(fenToChess(fen).moves({ verbose: true }).map(move => [move.san, uciFromMove(move)]));
  return moves.flatMap(move => {
    // The explorer encodes castling as king-to-rook, even in standard chess.
    const uci = /^O-O/.test(move.san) ? legal.get(move.san) : move.uci;
    return uci ? [{ ...move, uci }] : [];
  });
}

function explorerReplyFen(fen: string, uci: string) {
  const chess = fenToChess(fen);
  try {
    chess.move(uci);
    return chess.fen();
  } catch {
    return null;
  }
}

function repertoireBranchNodes(tree: MoveTree, rootId: string) {
  const nodes: MoveNode[] = [];
  const stack = [rootId];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    const node = tree.nodes[id];
    if (!node || visited.has(id)) continue;
    visited.add(id);
    nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
  }
  return nodes;
}

const historyPositionsByTree = new WeakMap<MoveTree, Set<string>>();

function historyPositionsForTree(tree: MoveTree) {
  let positions = historyPositionsByTree.get(tree);
  if (!positions) {
    positions = new Set(repertoireBranchNodes(tree, tree.rootId).map(node => bookPositionFenKey(node.fen)));
    historyPositionsByTree.set(tree, positions);
  }
  return positions;
}

function BackIcon() {
  return (
    <TabIconBase>
      <path
        d="M18 12H7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 8.8L7 12l3.5 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </TabIconBase>
  );
}

function UndoIcon() {
  return (
    <TabIconBase>
      <path d="M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </TabIconBase>
  );
}

function ForwardIcon() {
  return (
    <TabIconBase>
      <path d="M6 12h11m-3.5-3.2L17 12l-3.5 3.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </TabIconBase>
  );
}

function PlayIcon() {
  return (
    <TabIconBase>
      <path d="M9 7.5v9l7-4.5z" fill="currentColor" />
    </TabIconBase>
  );
}

function StopIcon() {
  return (
    <TabIconBase>
      <rect x="7.6" y="7.6" width="8.8" height="8.8" fill="currentColor" rx="1.1" />
    </TabIconBase>
  );
}

function PrevIcon() {
  return (
    <TabIconBase>
      <path d="M8 7.4v9.2M16 8l-5.4 4 5.4 4z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </TabIconBase>
  );
}

function NextIcon() {
  return (
    <TabIconBase>
      <path d="M16 7.4v9.2M8 8l5.4 4L8 16z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </TabIconBase>
  );
}

function QuitIcon() {
  return (
    <TabIconBase>
      <path d="M7.8 7.8l8.4 8.4M16.2 7.8l-8.4 8.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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

function fullBoardFen(fen: string) {
  return fen === START_FEN ? START_POS_FEN : fen;
}

function positionFenKey(fen: string) {
  const fullFen = fullBoardFen(fen);
  const parts = fullFen.split(' ');
  return parts.slice(0, 4).join(' ');
}

function bookPositionFenKey(fen: string) {
  const fullFen = fullBoardFen(fen);
  const parts = fullFen.split(' ');
  if (parts[3] && parts[3] !== '-') {
    const chess = new Chess(fullFen);
    const hasLegalEnPassant = chess.moves({ verbose: true }).some((move) => move.flags.includes('e'));
    if (!hasLegalEnPassant) parts[3] = '-';
  }
  return parts.slice(0, 4).join(' ');
}

function FlashcardIcon() {
  return (
    <TabIconBase>
      <rect x="4.5" y="5.5" width="15" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 9h8M8 12h5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </TabIconBase>
  );
}

function SuddenDeathIcon() {
  return (
    <TabIconBase>
      <path d="M12 3.8L5.8 12.1h4.1L8.7 20.2l7.5-10.1h-4.1z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    </TabIconBase>
  );
}

function weightedPickIndex(weights: number[]) {
  const total = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (total <= 0) return -1;
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= Math.max(0, weights[i]);
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

function whitePerspectiveMultiplierFromFen(fen: string) {
  const turn = fen.split(' ')[1];
  return turn === 'b' ? -1 : 1;
}

function createNodeId(tree: MoveTree) {
  return `n-${tree.nextId}`;
}

function splitPgnGames(pgn: string): string[] {
  const normalized = pgn.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks = normalized
    .split(/\n{2,}(?=\[Event )/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const fallbackChunks = normalized
    .split(/\n{2,}/g)
    .map((part) => part.trim())
    .filter(Boolean);

  return chunks.length > 0 ? chunks : fallbackChunks;
}

function parsePgnHeaders(chunk: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = chunk.split('\n');
  for (const line of lines) {
    const match = line.match(/^\[([A-Za-z0-9_]+)\s+"(.*)"\]$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/\\"/g, '"');
  }
  return out;
}

function parsePgnToTree(side: Side, pgn: string, initialTree?: MoveTree): MoveTree {
  const base = initialTree ?? createEmptyTree(side);
  const candidates = splitPgnGames(pgn);
  if (candidates.length === 0) return base;

  let tree = base;

  for (const chunk of candidates) {
    tree = parsePgnChunkIntoTree(tree, chunk);
  }

  return tree;
}

function parsePgnChunkIntoTree(tree: MoveTree, chunk: string): MoveTree {
  const movetext = chunk
    .split('\n')
    .filter((line) => !line.trim().startsWith('['))
    .join(' ')
    .trim();
  if (!movetext) return tree;

  const tokens = tokenizeMovetext(movetext);
  if (tokens.length === 0) return tree;

  const nextTree: MoveTree = {
    rootId: tree.rootId,
    nextId: tree.nextId,
    nodes: { ...tree.nodes },
  };

  const parseSequence = (startChess: Chess, startNodeId: string, startIndex: number, stopOnRightParen: boolean): number => {
    const chess = new Chess(startChess.fen());
    let nodeId = startNodeId;
    let index = startIndex;
    let lastBranchFen: string | null = null;
    let lastBranchNodeId: string | null = null;

    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;

      if (token === ')') {
        if (stopOnRightParen) return index;
        continue;
      }

      if (token === '(') {
        if (lastBranchFen && lastBranchNodeId) {
          index = parseSequence(new Chess(lastBranchFen), lastBranchNodeId, index, true);
        } else {
          index = parseSequence(new Chess(chess.fen()), nodeId, index, true);
        }
        continue;
      }

      if (isIgnorablePgnToken(token)) continue;

      const san = sanitizeSanToken(token);
      if (!san) continue;

      const branchFen = chess.fen();
      const branchNodeId = nodeId;
      const move = chess.move(san);
      if (!move) continue;

      lastBranchFen = branchFen;
      lastBranchNodeId = branchNodeId;
      nodeId = ensureChildNode(nextTree, nodeId, move, chess);
    }

    return index;
  };

  parseSequence(new Chess(), nextTree.rootId, 0, false);
  return nextTree;
}

function tokenizeMovetext(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '{') {
      i += 1;
      while (i < text.length && text[i] !== '}') i += 1;
      if (i < text.length) i += 1;
      continue;
    }

    if (ch === ';') {
      i += 1;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push(ch);
      i += 1;
      continue;
    }

    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (/\s/.test(c) || c === '(' || c === ')' || c === '{' || c === ';') break;
      j += 1;
    }
    const token = text.slice(i, j).trim();
    if (token) tokens.push(token);
    i = j;
  }

  return tokens;
}

function isIgnorablePgnToken(token: string) {
  if (!token) return true;
  if (token === '*' || token === '1-0' || token === '0-1' || token === '1/2-1/2') return true;
  if (/^\$\d+$/.test(token)) return true;
  if (/^\d+\.(\.\.)?$/.test(token)) return true;
  if (/^\d+\.\.\.$/.test(token)) return true;
  return false;
}

function sanitizeSanToken(token: string) {
  let value = token.trim();
  if (!value) return null;

  while (/^\d+\.(\.\.)?/.test(value)) {
    value = value.replace(/^\d+\.(\.\.)?/, '');
  }
  value = value.replace(/^\.\.\./, '');
  value = value.replace(/(?:\$\d+)+$/, '');
  value = value.replace(/[!?]+$/, '');
  value = value.replace(/\*$/, '');
  value = value.trim();

  if (!value || value === '*' || value === '1-0' || value === '0-1' || value === '1/2-1/2') return null;
  return value;
}

function ensureChildNode(tree: MoveTree, parentId: string, move: Move, chessAfterMove: Chess) {
  const parent = tree.nodes[parentId];
  if (!parent) return parentId;

  const uci = uciFromMove(move);
  const existingChildId = parent.children.find((childId) => tree.nodes[childId]?.moveUci === uci);
  if (existingChildId) return existingChildId;

  const nodeId = createNodeId(tree);
  tree.nextId += 1;
  tree.nodes[nodeId] = {
    id: nodeId,
    parentId,
    fen: chessAfterMove.fen(),
    moveSan: move.san,
    moveUci: uci,
    children: [],
  };
  tree.nodes[parentId] = {
    ...parent,
    children: [...parent.children, nodeId],
  };
  return nodeId;
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

function treeThroughNode(tree: MoveTree, nodeId: string): MoveTree {
  const path = buildPath(tree, nodeId);
  const nodes: Record<string, MoveNode> = {};
  path.forEach((node, index) => {
    nodes[node.id] = { ...node, children: path[index + 1] ? [path[index + 1].id] : [] };
  });
  return { ...tree, nodes };
}

function buildMainLinePath(tree: MoveTree): MoveNode[] {
  const root = tree.nodes[tree.rootId];
  if (!root) return [];
  const path = [root];
  let cursor = root;
  while (cursor.children.length > 0) {
    const mainChildId = mainMoveId(tree, cursor);
    if (!mainChildId) break;
    const mainChild = tree.nodes[mainChildId];
    if (!mainChild) break;
    path.push(mainChild);
    cursor = mainChild;
  }
  return path;
}

function uciToMoveInput(uci: string) {
  if (uci.length < 4) return null;
  const promotionChar = uci[4]?.toLowerCase();
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion:
      promotionChar && ['q', 'r', 'b', 'n'].includes(promotionChar)
        ? (promotionChar as 'q' | 'r' | 'b' | 'n')
        : undefined,
  };
}

function formatMovePrefix(chess: Chess) {
  return chess.turn() === 'w' ? `${chess.moveNumber()}.` : `${chess.moveNumber()}...`;
}

function buildVariationTokens(tree: MoveTree, nodeId: string, chess: Chess): string[] {
  const node = tree.nodes[nodeId];
  if (!node || node.children.length === 0) return [];

  const children = node.children.filter((childId) => {
    const child = tree.nodes[childId];
    return Boolean(child?.moveUci);
  });
  if (children.length === 0) return [];

  const mainChildId = mainMoveId(tree, node)!;
  const alternativeChildIds = children.filter(id => id !== mainChildId);
  const tokens: string[] = [];
  const mainNode = tree.nodes[mainChildId];
  if (!mainNode?.moveUci) return tokens;
  const mainInput = uciToMoveInput(mainNode.moveUci);
  if (!mainInput) return tokens;
  const mainPrefix = formatMovePrefix(chess);
  const mainMove = chess.move(mainInput);
  if (!mainMove) return tokens;

  tokens.push(mainPrefix, mainMove.san);

  for (const alternativeChildId of alternativeChildIds) {
    const altNode = tree.nodes[alternativeChildId];
    if (!altNode?.moveUci) continue;
    const altInput = uciToMoveInput(altNode.moveUci);
    if (!altInput) continue;
    const altChess = new Chess(node.fen === START_FEN ? START_POS_FEN : node.fen);
    const altPrefix = formatMovePrefix(altChess);
    const altMove = altChess.move(altInput);
    if (!altMove) continue;
    const altTokens = [altPrefix, altMove.san, ...buildVariationTokens(tree, alternativeChildId, altChess)];
    tokens.push(`(${altTokens.join(' ')})`);
  }

  tokens.push(...buildVariationTokens(tree, mainChildId, chess));
  return tokens;
}

function exportTreeToPgn(tree: MoveTree, side: Side, repertoireName?: string): string {
  const exportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const safeName = repertoireName ? normalizeRepertoireName(repertoireName) : '';
  const headers: Array<[string, string]> = [
    ['Event', safeName ? `Opening Prep Trainer - ${safeName}` : 'Opening Prep Trainer'],
    ['Site', 'Local'],
    ['Date', exportDate],
    ['Round', '-'],
    ['White', side === 'white' ? 'Repertoire' : 'Opponent'],
    ['Black', side === 'black' ? 'Repertoire' : 'Opponent'],
    ['Result', '*'],
  ];
  const headerBlock = headers.map(([key, value]) => `[${key} "${value.replace(/"/g, '\\"')}"]`).join('\n');

  const chess = new Chess();
  const moveTokens = buildVariationTokens(tree, tree.rootId, chess);
  const moveText = moveTokens.length > 0 ? `${moveTokens.join(' ')} *` : '*';

  return `${headerBlock}\n\n${moveText}`;
}

function exportGameToPgn(tree: MoveTree, perspective: Side, playerHandle: string): string {
  const root = tree.nodes[tree.rootId];
  const chess = fenToChess(root.fen);
  const headers: Array<[string, string]> = [
    ['Event', 'Review game'],
    ['Site', 'Local'],
  ];
  const handle = playerHandle.trim();
  if (handle) headers.push([perspective === 'white' ? 'White' : 'Black', handle]);
  if (chess.fen() !== START_POS_FEN) {
    headers.push(['SetUp', '1'], ['FEN', chess.fen()]);
  }
  const tokens: string[] = [];
  for (const node of buildMainLinePath(tree).slice(1)) {
    const input = node.moveUci ? uciToMoveInput(node.moveUci) : null;
    if (!input) throw new Error('The game contains an invalid move.');
    const prefix = formatMovePrefix(chess);
    const move = chess.move(input);
    tokens.push(prefix, move.san);
  }
  const result = chess.isCheckmate() ? (chess.turn() === 'w' ? '0-1' : '1-0') : chess.isDraw() ? '1/2-1/2' : '*';
  headers.push(['Result', result]);
  const headerBlock = headers.map(([key, value]) =>
    `[${key} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"]`,
  ).join('\n');
  return `${headerBlock}\n\n${[...tokens, result].join(' ')}\n`;
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

function formatSignedCp(cp: number) {
  const normalized = Number.isFinite(cp) ? cp : 0;
  const sign = normalized >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(normalized) / 100).toFixed(2)}`;
}

function formatSignedMate(mate: number) {
  if (!Number.isFinite(mate)) return '?';
  if (mate === 0) return 'M0';
  const sign = mate > 0 ? '+' : '-';
  return `${sign}M${Math.abs(mate)}`;
}

function winProbabilityToCp(winProbability: number) {
  const p = Math.min(0.99, Math.max(0.01, winProbability));
  return Math.round(400 * Math.log(p / (1 - p)));
}

function normalizeEvalSignText(raw: string) {
  const text = raw.trim();
  const cpMatch = text.match(/^[+-]?\d+(?:\.\d+)?$/);
  if (cpMatch) {
    const value = Number(text);
    if (!Number.isFinite(value)) return text;
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${Math.abs(value).toFixed(2)}`;
  }

  const mateClassic = text.match(/^M(-?\d+)$/i);
  if (mateClassic) {
    const mate = Number(mateClassic[1]);
    if (!Number.isFinite(mate)) return text;
    return formatSignedMate(mate);
  }

  const mateSigned = text.match(/^([+-])M(\d+)$/i);
  if (mateSigned) {
    const direction = mateSigned[1] === '-' ? -1 : 1;
    const distance = Number(mateSigned[2]);
    if (!Number.isFinite(distance)) return text;
    return formatSignedMate(direction * distance);
  }

  return text;
}

function formatRelativeTimeFromNow(timestamp: number) {
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'just now';
  const elapsedSec = Math.floor(elapsedMs / 1000);
  if (elapsedSec < 60) return 'just now';
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const elapsedHours = Math.floor(elapsedMin / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 30) return `${elapsedDays}d ago`;
  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo ago`;
  const elapsedYears = Math.floor(elapsedMonths / 12);
  return `${elapsedYears}y ago`;
}

function formatTrainedAt(timestamp: number | null) {
  if (!timestamp) return 'never';
  return `${new Date(timestamp).toLocaleString()} (${formatRelativeTimeFromNow(timestamp)})`;
}

function formatAverageElo(move: LichessMove) {
  const raw = move.averageRating ?? move.averageElo;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '';
  return `${Math.round(raw)}`;
}

function formatLichessExamplePlayer(player?: LichessExamplePlayer) {
  if (!player) return '?';
  const name = typeof player.name === 'string' && player.name.trim().length > 0 ? player.name.trim() : '?';
  const title = typeof player.title === 'string' && player.title.trim().length > 0 ? `${player.title.trim()} ` : '';
  const rating = typeof player.rating === 'number' && Number.isFinite(player.rating) ? ` (${Math.round(player.rating)})` : '';
  return `${title}${name}${rating}`;
}

function formatLichessExampleRank(player?: LichessExamplePlayer) {
  if (!player) return '?';
  const title = typeof player.title === 'string' && player.title.trim().length > 0 ? player.title.trim() : '';
  const rating = typeof player.rating === 'number' && Number.isFinite(player.rating) ? `${Math.round(player.rating)}` : '';
  if (title && rating) return `${title} ${rating}`;
  if (rating) return rating;
  if (title) return title;
  return '?';
}

function formatLichessExampleResult(game: LichessExampleGame) {
  if (game.winner === 'white') return '1-0';
  if (game.winner === 'black') return '0-1';
  return '½-½';
}

function formatLichessExampleLine(game: LichessExampleGame) {
  const ranks = game.white || game.black
    ? `${formatLichessExampleRank(game.white)} – ${formatLichessExampleRank(game.black)}` : '';
  const month = playerGameMonth(game);
  const date = typeof game.createdAt === 'number' && Number.isFinite(game.createdAt)
    ? new Date(game.createdAt).toLocaleString()
    : month ? formatPlayerMonth(month) : game.year;
  return [ranks, game.speed, formatLichessExampleResult(game), date].filter(Boolean).join(' · ');
}

function normalizeMoveThreshold(value: unknown) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 5;
  return [...MOVE_THRESHOLD_OPTIONS].reduce<MoveThreshold>(
    (best, option) => (Math.abs(option - numeric) < Math.abs(best - numeric) ? option : best),
    5,
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

function renderCommentText(comment: string): ReactNode {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of comment.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)) {
    let text = match[0];
    if (text !== comment.trim()) {
      text = text.replace(/[.,!?;:]+$/, '');
      const unmatchedParens = text.split(')').length - text.split('(').length;
      const trailingParens = text.match(/\)+$/)?.[0].length ?? 0;
      const trim = Math.min(Math.max(0, unmatchedParens), trailingParens);
      if (trim) text = text.slice(0, -trim);
    }
    const href = /^www\./i.test(text) ? `https://${text}` : text;
    try {
      new URL(href);
    } catch {
      continue;
    }
    parts.push(comment.slice(offset, match.index));
    parts.push(<a key={match.index} href={href} target="_blank" rel="noopener noreferrer">{text}</a>);
    offset = match.index + text.length;
  }
  parts.push(comment.slice(offset));
  return parts;
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

function buildEnginePvMoves(fen: string, pv: string, limit = Infinity) {
  const chess = fenToChess(fen);
  const moves: Array<{ uci: string; san: string; fen: string; lastMove: [Key, Key] }> = [];
  for (const uci of pv.split(/\s+/).filter((part) => /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(part))) {
    const input = uciToMoveInput(uci);
    if (!input) break;
    try {
      const move = chess.move(input);
      if (!move) break;
      moves.push({ uci, san: toFigurineSan(move.san), fen: chess.fen(), lastMove: [move.from as Key, move.to as Key] });
      if (moves.length >= limit) break;
    } catch {
      break;
    }
  }
  return moves;
}

function stockfishRank(evaluation: CandidateEvaluation, side: Side) {
  const mate = evaluation.scoreText.match(/^([+-])M(\d+)$/);
  const value = mate
    ? (mate[1] === '+' ? 1 : -1) * (100_000 - Number(mate[2]))
    : evaluation.evalCp;
  return side === 'white' ? value : -value;
}

function MaiaMoveSummary({ result, positionFen }: { result: GameAnalysisMoveResult; positionFen?: string }) {
  if (!result.maiaStatus || result.maiaStatus === 'skipped') return null;
  const topMove = result.maiaTopMoveUci && positionFen
    ? uciToFigurineSan(positionFen, result.maiaTopMoveUci)
    : result.maiaTopMoveUci;
  const eloLabel = result.maiaElo === undefined ? 'rating unavailable' : `${result.maiaElo} vs ${result.maiaOpponentElo ?? result.maiaElo} Elo`;
  return (
    <span className="game-analysis-maia-stat">
      <strong>{MAIA_ENGINE_LABEL} · {eloLabel}</strong>
      {result.maiaStatus === 'unavailable'
        ? <span> Maia statistics are unavailable for this position{result.maiaUnavailableReason ? `: ${result.maiaUnavailableReason}` : '.'}</span>
        : <span>
            {result.maiaPlayedProbability === null || result.maiaPlayedProbability === undefined
              ? ' Played move is not in Maia’s move vocabulary.'
              : ` Played move: #${result.maiaPlayedRank ?? '–'} in Maia’s choices (${(result.maiaPlayedProbability * 100).toFixed(1)}%).`}
            {topMove && result.maiaTopMoveProbability !== null && result.maiaTopMoveProbability !== undefined
              ? ` Top choice: ${topMove} (${(result.maiaTopMoveProbability * 100).toFixed(1)}%).`
              : ''}
            {result.maiaWinProbability !== null && result.maiaWinProbability !== undefined
              ? ` Expected score for White before the move: ${(result.maiaWinProbability * 100).toFixed(1)}%.`
              : ''}
            {result.maiaBaselineTag === 'above' ? ' Difficult find: Stockfish checked the alternatives and Maia predicts few good choices.' : ''}
            {result.maiaBaselineTag === 'below' ? ' Missed an accessible move: Maia strongly favors alternatives that Stockfish confirms are good.' : ''}
          </span>}
      {result.maiaStatus === 'complete' && <HumanMoveDetails result={result} formatMove={uci => positionFen ? uciToFigurineSan(positionFen, uci) : uci} />}
    </span>
  );
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
    if (arrow.brush === 'purple') return { ...arrow, brush: 'purpleSoft' };
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
    const updatedParent = {
      ...parent,
      children: parent.children.filter((id) => id !== branchRootId),
    };
    nextNodes[parent.id] = updatedParent;
    const main = mainMoveId({ ...tree, nodes: nextNodes }, updatedParent);
    if (main && nextNodes[main].inactiveStatus) {
      nextNodes[main] = { ...nextNodes[main], inactiveStatus: undefined };
    }
  }

  return { ...tree, nodes: nextNodes };
}

async function readExplorerResponse(
  response: Response,
  publish: (snapshot: LichessResponse) => void,
  onChunk?: () => void,
) {
  if (!response.body) {
    const snapshot = parseLastJsonObject<LichessResponse>(await response.text());
    if (Array.isArray(snapshot?.moves)) publish(snapshot);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (!done) onChunk?.();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const parsed = extractJsonObjects<LichessResponse>(buffer);
      buffer = parsed.rest;
      for (const snapshot of parsed.objects) {
        if (Array.isArray(snapshot?.moves)) publish(snapshot);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function ExplorerPanel({ className, split, onSplitChange, children }: {
  className: string;
  split: number;
  onSplitChange: (split: number) => void;
  children: [ReactNode, ReactNode];
}) {
  const [dragSplit, setDragSplit] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startY: number; startSplit: number; height: number } | null>(null);
  const shownSplit = dragSplit ?? split;

  const splitAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId !== event.pointerId) return null;
    return normalizeDesktopLichessShare(start.startSplit + 100 * (event.clientY - start.startY) / start.height);
  };

  const cancelDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragSplit(null);
  };

  return (
    <aside className={className}
      style={{ gridTemplateRows: `minmax(0, ${shownSplit}fr) 0.65rem minmax(0, ${100 - shownSplit}fr)` }}>
      {children[0]}
      <div className="explorer-divider desktop-only" role="separator" tabIndex={0}
        aria-label="Resize Lichess and AI panels" aria-orientation="horizontal" aria-controls="lichess-explorer-panel"
        aria-valuemin={DESKTOP_SPLIT_MIN} aria-valuemax={DESKTOP_SPLIT_MAX} aria-valuenow={Math.round(shownSplit)}
        aria-valuetext={`Lichess ${Math.round(shownSplit)}%, AI ${100 - Math.round(shownSplit)}%`}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          const handle = event.currentTarget;
          const height = (handle.previousElementSibling?.getBoundingClientRect().height ?? 0) +
            (handle.nextElementSibling?.getBoundingClientRect().height ?? 0);
          if (!height) return;
          event.preventDefault();
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, startY: event.clientY, startSplit: split, height };
        }}
        onPointerMove={(event) => {
          const value = splitAtPointer(event);
          if (value !== null) setDragSplit(value);
        }}
        onPointerUp={(event) => {
          const value = splitAtPointer(event);
          if (value === null) return;
          cancelDrag(event);
          onSplitChange(value);
        }}
        onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
        onKeyDown={(event) => {
          if (drag.current) return;
          const steps = { ArrowUp: split - 2, ArrowDown: split + 2, Home: DESKTOP_SPLIT_MIN, End: DESKTOP_SPLIT_MAX };
          if (!Object.hasOwn(steps, event.key)) return;
          event.preventDefault();
          onSplitChange(normalizeDesktopLichessShare(steps[event.key as keyof typeof steps]));
        }}
      />
      {children[1]}
    </aside>
  );
}

function boardAnnotationShapes(annotations: BoardAnnotation[]): DrawShape[] {
  return annotations.map(annotation => ({ ...annotation, brush: 'annotation' }));
}

function Board(props: {
  fen: string;
  orientation: 'white' | 'black';
  lastMove: [Key, Key] | undefined;
  arrows: DrawShape[];
  annotations: BoardAnnotation[];
  annotationTarget?: string;
  drawing: boolean;
  allowedMoveUcis?: string[];
  disableDrawing?: boolean;
  onAnnotationsChange: (annotations: BoardAnnotation[]) => void;
  readOnly?: boolean;
  onMove: (orig: Key, dest: Key) => void;
}) {
  const { fen, orientation, lastMove, arrows, annotations, annotationTarget, drawing,
    allowedMoveUcis, disableDrawing, onAnnotationsChange, readOnly, onMove } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<ChessgroundApi | null>(null);
  const onMoveRef = useRef(onMove);
  const drawingGesture = useRef<{ pointerId: number; target: string; orig: Key; preview?: BoardAnnotation } | null>(null);

  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    if (!containerRef.current) return;

    apiRef.current = Chessground(containerRef.current, {
      coordinates: false,
      coordinatesOnSquares: false,
      ranksPosition: 'left',
      blockTouchScroll: true,
      disableContextMenu: true,
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
    if (drawingGesture.current?.target !== annotationTarget) drawingGesture.current = null;
    const locked = readOnly || drawing;
    const preview = drawingGesture.current?.preview;
    const allowedMoves = allowedMoveUcis && new Set(allowedMoveUcis.map(uci => uci.slice(0, 4)));
    const legalDests = buildDests(fen);
    const dests = allowedMoves
      ? new Map([...legalDests].map(([orig, targets]) =>
          [orig, targets.filter(dest => allowedMoves.has(`${orig}${dest}`))] as const)
          .filter(([, targets]) => targets.length > 0))
      : legalDests;
    apiRef.current?.set({
      fen: fullBoardFen(fen),
      orientation,
      coordinates: false,
      coordinatesOnSquares: false,
      ranksPosition: 'left',
      turnColor: toTurnColor(fen),
      blockTouchScroll: true,
      movable: {
        color: locked ? undefined : 'both',
        free: false,
        dests: locked ? new Map() : dests,
        events: {
          after: (orig, dest) => onMove(orig, dest),
        },
      },
      selectable: { enabled: !drawing },
      draggable: { enabled: !drawing },
      drawable: {
        enabled: !annotationTarget && !disableDrawing,
        visible: true,
        shapes: annotationTarget ? boardAnnotationShapes(preview ? [...annotations, preview] : annotations) : undefined,
        autoShapes: drawing ? [] : annotationTarget ? arrows : [...arrows, ...boardAnnotationShapes(annotations)],
        brushes: ARROW_BRUSHES,
      },
      lastMove,
    });
  }, [fen, orientation, arrows, lastMove, readOnly, drawing, annotations, annotationTarget,
    allowedMoveUcis, disableDrawing, onMove]);

  const squareAtPointer = (event: PointerEvent<HTMLDivElement>) =>
    apiRef.current?.getKeyAtDomPos([event.clientX, event.clientY]);

  const startAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    const drawGesture = event.button === 2 || (event.button === 0 && (drawing || event.shiftKey));
    if (!annotationTarget || !event.isPrimary || !drawGesture) return;
    const orig = squareAtPointer(event);
    if (!orig) return;
    event.preventDefault();
    apiRef.current?.cancelMove();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingGesture.current = { pointerId: event.pointerId, target: annotationTarget, orig, preview: { orig } };
    apiRef.current?.setShapes(boardAnnotationShapes([...annotations, { orig }]));
  };

  const moveAnnotation = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drawingGesture.current;
    if (gesture?.pointerId !== event.pointerId || gesture.target !== annotationTarget) return;
    const square = squareAtPointer(event);
    const preview = square ? { orig: gesture.orig, dest: square === gesture.orig ? undefined : square } : undefined;
    if (preview?.orig === gesture.preview?.orig && preview?.dest === gesture.preview?.dest) return;
    gesture.preview = preview;
    apiRef.current?.setShapes(boardAnnotationShapes(preview ? [...annotations, preview] : annotations));
  };

  const endAnnotation = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const gesture = drawingGesture.current;
    if (gesture?.pointerId !== event.pointerId || gesture.target !== annotationTarget) return;
    drawingGesture.current = null;
    const square = commit ? squareAtPointer(event) : undefined;
    if (!square) {
      apiRef.current?.setShapes(boardAnnotationShapes(annotations));
      return;
    }
    const annotation = { orig: gesture.orig, dest: square === gesture.orig ? undefined : square };
    const matches = (shape: BoardAnnotation) => shape.orig === annotation.orig && shape.dest === annotation.dest;
    const next = annotations.some(matches) ? annotations.filter(shape => !matches(shape)) : [...annotations, annotation];
    apiRef.current?.setShapes(boardAnnotationShapes(next));
    onAnnotationsChange(next);
  };

  return <div ref={containerRef} className="board" data-drawing={drawing || undefined}
    onPointerDown={startAnnotation} onPointerMove={moveAnnotation}
    onPointerUp={event => endAnnotation(event, true)} onPointerCancel={event => endAnnotation(event, false)}
    onLostPointerCapture={event => endAnnotation(event, false)} />;
}

function MaiaStatusView({ status }: { status: MaiaLoadingStatus | null }) {
  if (status?.phase === 'initializing') return <div className="maia-load-status" role="status">Inicjalizacja Maia-3 w WebAssembly…</div>;
  if (status?.phase === 'downloading') {
    const percent = status.totalBytes > 0 ? Math.floor(status.loadedBytes / status.totalBytes * 100) : 0;
    const loaded = (status.loadedBytes / (1024 * 1024)).toFixed(1);
    const total = (status.totalBytes / (1024 * 1024)).toFixed(1);
    const action = status.source === 'network' ? 'Pobieranie' : 'Wczytywanie z pamięci telefonu';
    return <div className="maia-load-status" role="status">
      <span>{action} modelu Maia-3: {status.totalBytes ? `${percent}% (${loaded} / ${total} MB)` : 'przygotowanie…'}</span>
      <progress max={status.totalBytes || 1} value={status.loadedBytes} aria-label="Postęp pobierania Maia-3" />
    </div>;
  }
  return <div className="maia-load-status" role="status">Uruchamianie Maia-3…</div>;
}

function App() {
  const initialThemeMode: ThemeMode = 'light';
  const initialLichessSource: LichessSource = 'lichess';
  const initialPlayerHandle = '';
  const initialLichessApiToken = '';
  const initialDateRange: DateRange = null;
  const initialLichessArrowThreshold = 5;
  const initialEngineChoice: EngineChoice = 'stockfish';
  const initialEngineDepth = 24;
  const initialMaiaStrengthElo = 1500;
  const initialSelectedSpeeds: string[] = SPEEDS.filter((speed) => speed !== 'bullet');
  const initialSelectedRatings: number[] = [2000, 2200, 2500];
  const initialSelectedModes: string[] = [...MODES];
  const initialTrainingStatsQueueLength = 5;
  const initialSuddenDeathThreshold = 1;
  const initialSuddenDeathMinMoves = 4;
  const initialSuddenDeathStockfishElo = 2000;
  const initialSuddenDeathEngine: EngineChoice = 'stockfish';
  const initialSuddenDeathMaiaElo = 1500;
  const initialSuddenDeathMaxThinkTimeSec = 1;
  const initialWhiteTree = createEmptyTree('white');
  const initialBlackTree = createEmptyTree('black');

  const [trees, setTrees] = useState<Record<Side, MoveTree>>({
    white: initialWhiteTree,
    black: initialBlackTree,
  });
  const [selectedNodeBySide, setSelectedNodeBySide] = useState<Record<Side, string>>({
    white: initialWhiteTree.rootId,
    black: initialBlackTree.rootId,
  });
  const [repertoiresBySide, setRepertoiresBySide] = useState<Record<Side, RepertoireEntry[]>>({
    white: [],
    black: [],
  });
  const [activeRepertoireIdBySide, setActiveRepertoireIdBySide] = useState<Record<Side, string | null>>({
    white: null,
    black: null,
  });
  const [repertoireModeBySide, setRepertoireModeBySide] = useState<Record<Side, RepertoireMode>>({
    white: 'review',
    black: 'review',
  });
  const [repertoireSide, setRepertoireSide] = useState<'white' | 'black'>('white');
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [isTempBoardFlipped, setIsTempBoardFlipped] = useState(false);
  const [, setStatus] = useState('Ready');
  const [engineDepth, setEngineDepth] = useState(initialEngineDepth);
  const [selectedEngine, setSelectedEngine] = useState<EngineChoice>(initialEngineChoice);
  const [bothEngines, setBothEngines] = useState(false);
  const [maiaStrengthElo, setMaiaStrengthElo] = useState(initialMaiaStrengthElo);
  const [showMaiaPopularity, setShowMaiaPopularity] = useState(false);
  const [maiaResultKey, setMaiaResultKey] = useState('');
  const [analysisBenchmarkElo, setAnalysisBenchmarkElo] = useState(1800);
  const [analysisContext, setAnalysisContext] = useState<AnalysisContext>(() => {
    try { return JSON.parse(localStorage.getItem('analysis-context') ?? '{}'); } catch { return {}; }
  });
  const [analysisContextSource, setAnalysisContextSource] = useState<'pgn' | 'manual'>('manual');
  const updateAnalysisContext = (value: AnalysisContext) => {
    setAnalysisContext(value); setAnalysisContextSource('manual');
    localStorage.setItem('analysis-context', JSON.stringify(value));
  };
  const analysisReviewAbortRef = useRef<AbortController | null>(null);
  const [stockfishEvalSeconds, setStockfishEvalSeconds] = useState(10);
  const [trainingStatsQueueLength, setTrainingStatsQueueLength] = useState(initialTrainingStatsQueueLength);
  const [trainAlternativeMoves, setTrainAlternativeMoves] = useState(false);
  const [suddenDeathThreshold, setSuddenDeathThreshold] = useState(initialSuddenDeathThreshold);
  const [suddenDeathMinMoves, setSuddenDeathMinMoves] = useState(initialSuddenDeathMinMoves);
  const [suddenDeathStockfishElo, setSuddenDeathStockfishElo] = useState(initialSuddenDeathStockfishElo);
  const [suddenDeathEngine, setSuddenDeathEngine] = useState<EngineChoice>(initialSuddenDeathEngine);
  const [suddenDeathMaiaElo, setSuddenDeathMaiaElo] = useState(initialSuddenDeathMaiaElo);
  const [suddenDeathMaxThinkTimeSec, setSuddenDeathMaxThinkTimeSec] = useState(initialSuddenDeathMaxThinkTimeSec);
  const [engineMultiPv, setEngineMultiPv] = useState(3);
  const [showStockfishArrows, setShowStockfishArrows] = useState(true);
  const [showMaiaArrows, setShowMaiaArrows] = useState(true);
  const [combineCompactEngineArrows, setCombineCompactEngineArrows] = useState(false);
  const [movesArrowGroupNeedsCompact, setMovesArrowGroupNeedsCompact] = useState(false);
  const topArrowGroupRef = useRef<HTMLDivElement>(null);
  const movesArrowGroupRef = useRef<HTMLDivElement>(null);
  const moveToolbarRef = useRef<HTMLDivElement>(null);
  const portraitForwardRef = useRef<HTMLButtonElement>(null);
  const [hidePortraitForward, setHidePortraitForward] = useState(false);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [maiaStockfishComparison, setMaiaStockfishComparison] = useState<MaiaStockfishComparison | null>(null);
  const [stockfishLinesFen, setStockfishLinesFen] = useState(START_POS_FEN);
  const [engineStatus, setEngineStatus] = useState('stopped');
  const [maiaLoadingStatus, setMaiaLoadingStatus] = useState<MaiaLoadingStatus | null>(null);
  const [maiaLoaded, setMaiaLoaded] = useState(isMaiaReady);
  const [maiaError, setMaiaError] = useState('');
  const [maiaTreeStatus, setMaiaTreeStatus] = useState('');
  const [engineRunning, setEngineRunning] = useState(false);
  const [lichessData, setLichessData] = useState<LichessResponse | null>(null);
  const [lichessDataFen, setLichessDataFen] = useState<string | null>(null);
  const [lichessDataRequestKey, setLichessDataRequestKey] = useState('');
  const [explorerRefresh, setExplorerRefresh] = useState(0);
  const explorerRefreshHandledRef = useRef(0);
  const [playerSearchNote, setPlayerSearchNote] = useState('');
  const [mistakeReview, setMistakeReview] = useState<MistakeReview | null>(null);
  const [opponentReview, setOpponentReview] = useState<OpponentReview | null>(null);
  const displayedOpponentFindingRef = useRef<OpponentFinding | undefined>(undefined);
  const [isFindingCommonMistakes, setIsFindingCommonMistakes] = useState(false);
  const [mistakeDateLookupFailed, setMistakeDateLookupFailed] = useState(false);
  const findMissingControllerRef = useRef<AbortController | null>(null);
  const [openingByFen, setOpeningByFen] = useState<Record<string, { eco: string; name: string }>>({});
  const [lichessStatus, setLichessStatus] = useState('idle');
  const [lichessApiIssueNote, setLichessApiIssueNote] = useState('');
  const [lichessAuthRequired, setLichessAuthRequired] = useState(false);
  const [lichessRateLimitedUntil, setLichessRateLimitedUntil] = useState<number | null>(null);
  const [showTreeArrows, setShowTreeArrows] = useState(true);
  const [showLichessArrows, setShowLichessArrows] = useState(true);
  const [showLichessOnTreeMoves, setShowLichessOnTreeMoves] = useState(true);
  const [lichessArrowsOpponentOnly, setLichessArrowsOpponentOnly] = useState(false);
  const [showMistakeArrows, setShowMistakeArrows] = useState(false);
  const [mistakeHistoryMonths, setMistakeHistoryMonths] = useState<MistakeHistoryMonths>(12);
  const [isTreeArrowOptionsOpen, setIsTreeArrowOptionsOpen] = useState(false);
  const [isMistakeHistoryOptionsOpen, setIsMistakeHistoryOptionsOpen] = useState(false);
  const [isLichessFilterOpen, setIsLichessFilterOpen] = useState(false);
  const [exampleReplay, setExampleReplay] = useState<ExampleReplayState | null>(null);
  const [exampleReplayLoadingId, setExampleReplayLoadingId] = useState<string | null>(null);
  const [exampleReplayError, setExampleReplayError] = useState('');
  const [isLichessTokenEditorOpen, setIsLichessTokenEditorOpen] = useState(false);
  const [lichessSource, setLichessSource] = useState<LichessSource>(initialLichessSource);
  const [playerHandle, setPlayerHandle] = useState(initialPlayerHandle);
  const [playerHistory, setPlayerHistory] = useState<{ player: string; data: PlayerGameHistory } | null>(null);
  const [playerHistorySyncing, setPlayerHistorySyncing] = useState(false);
  const [playerHistoryError, setPlayerHistoryError] = useState('');
  const [playerHistoryRefresh, setPlayerHistoryRefresh] = useState(0);
  const playerHistoryRefreshHandledRef = useRef(0);
  const playerHistoryJobRef = useRef<{ player: string; ready: Promise<PlayerGameHistory | null> } | null>(null);
  const [playerSpeeds, setPlayerSpeeds] = useState<string[]>([...PLAYER_SPEEDS]);
  const [playerAssessments, setPlayerAssessments] = useState<PlayerAssessments>({});
  const [playerAssessmentRunning, setPlayerAssessmentRunning] = useState(false);
  const [playerAssessmentNotice, setPlayerAssessmentNotice] = useState<{ key: string; message: string } | null>(null);
  const playerAssessmentJobRef = useRef<AbortController | null>(null);
  const [lichessApiToken, setLichessApiToken] = useState(initialLichessApiToken);
  const [dateRange, setDateRange] = useState<DateRange>(initialDateRange);
  const [lichessArrowThreshold, setLichessArrowThreshold] = useState<MoveThreshold>(initialLichessArrowThreshold);
  const [nextMissingMoveThreshold, setNextMissingMoveThreshold] = useState<MoveThreshold>(5);
  const [playerNextMissingMoveThreshold, setPlayerNextMissingMoveThreshold] = useState<MoveThreshold>(0);
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
  const [hasHydratedAppState, setHasHydratedAppState] = useState(false);
  const [storageLoadFailed, setStorageLoadFailed] = useState(false);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [analysisGameProgress, setAnalysisGameProgress] = useState<GameAnalysisProgress | null>(null);
  const analysisGameActiveRef = useRef(false);
  useEffect(() => {
    analysisGameActiveRef.current = Boolean(analysisGameProgress);
  }, [analysisGameProgress]);
  const [analysisMaiaNotice, setAnalysisMaiaNotice] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [gameAnalysisReport, setGameAnalysisReport] = useState<GameAnalysisReport | null>(null);
  const [showAnalysisReport, setShowAnalysisReport] = useState(false);
  useEffect(() => subscribeMaiaStatus((status) => {
    setMaiaLoaded(isMaiaReady());
    if (status.phase === 'loading' && status.detail && typeof status.detail !== 'string') {
      const detail = status.detail;
      setMaiaLoadingStatus(detail);
      setMaiaError('');
      const percent = detail.phase === 'downloading' && detail.totalBytes > 0
        ? Math.floor(detail.loadedBytes / detail.totalBytes * 100) : 0;
      const text = detail.phase === 'initializing'
        ? 'Maia-3: inicjalizacja modelu w WebAssembly…'
        : detail.totalBytes > 0
          ? `Maia-3: ${detail.source === 'network' ? 'pobieranie' : 'wczytywanie z pamięci telefonu'} ${percent}%`
          : 'Maia-3: przygotowanie modelu…';
      setAnalysisGameProgress((prev) => prev ? { ...prev, detail: text } : prev);
      if (analysisGameActiveRef.current) setAnalysisMaiaNotice(null);
    } else if (status.phase === 'evaluating') {
      setMaiaLoadingStatus(null);
      const text = 'Maia-3 załadowana. Analizowanie wybranych pozycji…';
      setAnalysisGameProgress((prev) => prev ? { ...prev, detail: text } : prev);
      if (analysisGameActiveRef.current) setAnalysisMaiaNotice(null);
    } else if (status.phase === 'ready') {
      setMaiaLoadingStatus(null);
      // Successful interactive queries do not leave engine notices in the move list.
      setMaiaError('');
    } else if (status.phase === 'error') {
      const message = typeof status.detail === 'string' ? status.detail : 'Nieznany błąd Maia';
      setMaiaError(message);
      setAnalysisGameProgress((prev) => prev ? { ...prev, detail: `Błąd Maia-3: ${message}` } : prev);
      if (analysisGameActiveRef.current) setAnalysisMaiaNotice({ kind: 'error', text: `Błąd Maia-3: ${message}` });
    }
  }), []);
  const [analysisScratchPosition, setAnalysisScratchPosition] = useState<AnalysisScratchPosition | null>(null);
  const [hoveredEngineMove, setHoveredEngineMove] = useState<{
    fen: string; lastMove: [Key, Key];
  } | null>(null);
  const [isBackupIoRunning, setIsBackupIoRunning] = useState(false);
  const [isNewRepertoireOpen, setIsNewRepertoireOpen] = useState(false);
  const [isLoadRepertoireOpen, setIsLoadRepertoireOpen] = useState(false);
  const [newRepertoireName, setNewRepertoireName] = useState('');
  const [treeOptionDeletePopup, setTreeOptionDeletePopup] = useState<{
    nodeId?: string;
    moveUci?: string;
    fenKey?: string;
    x: number;
    y: number;
    openedAt: number;
  } | null>(null);
  const [moveCommentEditor, setMoveCommentEditor] = useState<{ nodeId: string; draft: string } | null>(null);
  const [browseAnnotations, setBrowseAnnotations] = useState<Record<string, BoardAnnotation[]>>({});
  const [drawingTarget, setDrawingTarget] = useState<string | null>(null);
  const [renamingRepertoireId, setRenamingRepertoireId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [importMode, setImportMode] = useState<'current' | 'db' | 'review'>('current');
  const [portraitTab, setPortraitTab] = useState<'lichess' | 'stockfish' | 'moves'>('moves');
  const [desktopLichessShare, setDesktopLichessShare] = useState(DESKTOP_SPLIT_DEFAULT);
  const [trainingSession, setTrainingSession] = useState<TrainingSession | null>(null);
  const [trainingStatsBySide, setTrainingStatsBySide] = useState<TrainingStatsState>(createEmptyTrainingStatsState());
  const [trainingLeafLastShownBySide, setTrainingLeafLastShownBySide] = useState<TrainingLeafLastShownState>(
    createEmptyTrainingLeafLastShownState(),
  );
  const [suddenDeathGameOver, setSuddenDeathGameOver] = useState<SuddenDeathGameOverState | null>(null);
  const [suddenDeathStartNodeId, setSuddenDeathStartNodeId] = useState<string | null>(null);
  const [suddenDeathCurrentFen, setSuddenDeathCurrentFen] = useState<string | null>(null);
  const [suddenDeathLastMove, setSuddenDeathLastMove] = useState<[Key, Key] | null>(null);
  const suddenDeathRoundRef = useRef<SuddenDeathRound | null>(null);
  const [treeEvalProgress, setTreeEvalProgress] = useState<TreeEvalProgressState | null>(null);
  const [isEvalManagerOpen, setIsEvalManagerOpen] = useState(false);
  const [isDbStatsOpen, setIsDbStatsOpen] = useState(false);
  const [suddenDeathThinking, setSuddenDeathThinking] = useState(false);
  const analysisGameCancelRef = useRef(false);
  const analysisCurrentBoardNodeRef = useRef<string | null>(null);

  const stockfishRef = useRef<Worker | null>(null);
  const selectedEngineRef = useRef<EngineChoice>(initialEngineChoice);
  const maiaStrengthEloRef = useRef(initialMaiaStrengthElo);
  const engineReadyRef = useRef(false);
  const isSearchingRef = useRef(false);
  const engineRunningRef = useRef(false);
  const pendingAnalysisRef = useRef<{ fen: string; depth: number; multipv: number; positionCommand?: string } | null>(null);
  const tryStartPendingRef = useRef<(() => void) | null>(null);
  const currentAnalysisRef = useRef(0);
  const lineCacheRef = useRef<Map<number, EngineLine>>(new Map());
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const backupImportInputRef = useRef<HTMLInputElement | null>(null);
  const [engineReadyTick, setEngineReadyTick] = useState(0);
  const [stockfishLoaded, setStockfishLoaded] = useState(false);
  const [stockfishGeneration, setStockfishGeneration] = useState(0);
  const treeEvalAwaiterRef = useRef<{ latestScore: string | null; resolve: (score: string | null) => void } | null>(
    null,
  );
  const treeEvalCancelRef = useRef(false);
  const treeEvalFenCacheRef = useRef<Map<string, string>>(new Map());
  const engineWhitePerspectiveMultiplierRef = useRef(1);
  const maiaAnalysisRequestRef = useRef(0);
  const suddenDeathBusyRef = useRef(false);
  const suddenDeathAwaiterRef = useRef<{
    perspectiveMultiplier: number;
    latestEvalCp: number;
    latestScoreText: string;
    latestPv: string;
    latestDepth: number;
    latestNodes: number;
    latestScoreIsBound: boolean;
    latestWdl: [number, number, number] | null;
    wdlMultiplier: number;
    candidateLayers: Map<number, Map<number, CandidateEvaluation>>;
    requiredCandidates: number;
    onInfo?: (scoreText: string) => void;
    resolve: (result: StockfishEvaluationResult) => void;
    timeoutId: number | null;
  } | null>(null);
  const treeOptionLongPressTimeoutRef = useRef<number | null>(null);
  const treeOptionLongPressHandledNodeRef = useRef<string | null>(null);
  const inlineMoveLongPressTimeoutRef = useRef<number | null>(null);
  const inlineMoveLongPressHandledNodeRef = useRef<string | null>(null);
  const [isStockfishQuickOpen, setIsStockfishQuickOpen] = useState(false);
  const [isTrainingStatsMenuOpen, setIsTrainingStatsMenuOpen] = useState(false);
  const [isSuddenDeathSettingsOpen, setIsSuddenDeathSettingsOpen] = useState(false);
  const [isLichessArrowOptionsOpen, setIsLichessArrowOptionsOpen] = useState(false);
  const [isFindMissingOptionsOpen, setIsFindMissingOptionsOpen] = useState(false);
  const findMissingSearchAutoNavigationRef = useRef(false);
  const [isFindMissingSearchRunning, setIsFindMissingSearchRunning] = useState(false);
  const lichessRateLimitedUntilRef = useRef(0);
  const lichessNextRequestAtRef = useRef(0);
  const lichessRequestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lichessResponseCacheRef = useRef<Map<string, LichessResponseCacheEntry>>(new Map());
  const lichessResponseCacheLoadedRef = useRef(false);
  const lichessResponseCacheLoadPromiseRef = useRef<Promise<void> | null>(null);
  const moveNotationRef = useRef<HTMLDivElement | null>(null);
  const selectedMoveButtonRef = useRef<HTMLButtonElement | null>(null);
  const backLongPressTimeoutRef = useRef<number | null>(null);
  const backLongPressHandledRef = useRef(false);
  const backLongPressIsDownRef = useRef(false);
  const backLongPressStageRef = useRef<0 | 1 | 2>(0);
  const backLongPressActionRef = useRef<(stage: 1 | 2) => void>(() => {});
  const forwardLongPressTimeoutRef = useRef<number | null>(null);
  const forwardLongPressHandledRef = useRef(false);

  const activeSide: Side = repertoireSide;
  const enabledRepertoiresBySide = useMemo(() => ({
    white: repertoiresBySide.white.filter((entry) => entry.enabled),
    black: repertoiresBySide.black.filter((entry) => entry.enabled),
  }), [repertoiresBySide]);
  const activeRepertoireList = enabledRepertoiresBySide[activeSide];
  const activeRepertoireId = activeRepertoireIdBySide[activeSide];
  const activeRepertoire =
    activeRepertoireId ? activeRepertoireList.find((item) => item.id === activeRepertoireId) : null;
  const isEditingRepertoire = Boolean(activeRepertoire && repertoireModeBySide[activeSide] === 'edit');
  const isBrowseMode = !activeRepertoire;
  const isReadOnlyRepertoire = Boolean(activeRepertoire && !isEditingRepertoire &&
    !(trainingSession && trainingSession.side === activeSide));
  useEffect(() => {
    if (!isEditingRepertoire) setMoveCommentEditor(null);
  }, [isEditingRepertoire]);
  const activeRepertoireName = activeRepertoire?.name ?? 'Review mode';
  const bookRepertoireIndex = useMemo(
    () => buildBookRepertoireIndex([...enabledRepertoiresBySide.white, ...enabledRepertoiresBySide.black]),
    [enabledRepertoiresBySide],
  );
  const playerRepertoire = bookRepertoireIndex.find(entry => entry.id === activeRepertoireId);
  const boardOrientation: 'white' | 'black' =
    isTempBoardFlipped ? (repertoireSide === 'white' ? 'black' : 'white') : repertoireSide;
  const newRepertoireSide: Side = boardOrientation;
  const loadRepertoireSide: Side = boardOrientation;
  const loadableRepertoiresForBoardSide = repertoiresBySide[loadRepertoireSide];
  const hasSideTrainingContent = useCallback(
    (side: Side) => {
      const sideActiveRepertoireId = activeRepertoireIdBySide[side];
      if (sideActiveRepertoireId) return repertoireHasMoves(trees[side]);
      return enabledRepertoiresBySide[side].some((repertoire) => repertoireHasMoves(repertoire.tree));
    },
    [activeRepertoireIdBySide, trees, enabledRepertoiresBySide],
  );
  const canStartTrainingForActiveSide = hasSideTrainingContent(activeSide);
  const tree = trees[activeSide];
  const selectedNodeId = selectedNodeBySide[activeSide] ?? tree.rootId;
  const selectedNode = tree.nodes[selectedNodeId] ?? tree.nodes[tree.rootId];
  const reviewPosition = mistakeReview?.positions[mistakeReview.index];
  const browseMistakePosition = isBrowseMode ? reviewPosition : undefined;
  const reviewPositionOnBoard = reviewPosition && (isBrowseMode || reviewPosition.node.id === selectedNode.id);
  const opponentFinding = opponentReview?.findings[opponentReview.index];
  const browseOpponentPosition = isBrowseMode ? opponentFinding?.node : undefined;
  const opponentFindingOnBoard = opponentFinding && (isBrowseMode || opponentFinding.node.id === selectedNode.id) &&
    !analysisScratchPosition ? opponentFinding : null;
  const reviewTrees = isBrowseMode ? activeRepertoireList : null;
  const reviewTree = isBrowseMode ? null : tree;
  const repertoireReviewNodes = useMemo(() => {
    const positions = new Map<string, RepertoireReviewNode>();
    for (const source of reviewTree ? [reviewTree] : reviewTrees?.map(entry => entry.tree) ?? []) {
      if (!repertoireHasMoves(source)) continue;
      for (const node of repertoireBranchNodes(source, source.rootId)) {
        const key = bookPositionFenKey(node.fen);
        const position = positions.get(key) ?? { node, prepared: new Set<string>() };
        for (const id of node.children) {
          const move = source.nodes[id]?.moveUci;
          if (move) position.prepared.add(move);
        }
        positions.set(key, position);
      }
    }
    return [...positions.values()];
  }, [reviewTree, reviewTrees]);
  const mistakePreparedByFen = useMemo(() => {
    const preparedByFen = new Map(repertoireReviewNodes.map(({ node, prepared }) => [bookPositionFenKey(node.fen), prepared]));
    if (isBrowseMode) return preparedByFen;

    // Keep the loaded opening's positions, but accept prepared replies from the other openings for this side.
    const otherRepertoireIds = new Set(activeRepertoireList.filter(entry => entry.id !== activeRepertoireId).map(entry => entry.id));
    for (const repertoire of bookRepertoireIndex) {
      if (!otherRepertoireIds.has(repertoire.id)) continue;
      for (const [fen, moves] of repertoire.movesByFen) {
        const prepared = preparedByFen.get(fen);
        if (prepared) preparedByFen.set(fen, new Set([...prepared, ...moves]));
      }
    }
    return preparedByFen;
  }, [repertoireReviewNodes, isBrowseMode, activeRepertoireList, activeRepertoireId, bookRepertoireIndex]);
  const hasMistakeReviewNodes = repertoireReviewNodes.some(({ node }) => toTurnColor(node.fen) === activeSide);
  const hasOpponentReviewNodes = repertoireReviewNodes.some(({ node }) => toTurnColor(node.fen) !== activeSide);
  const analysisScratchFen = analysisScratchPosition?.fen ?? null;
  const selectedBoardFen = analysisScratchFen ?? browseMistakePosition?.node.fen ?? browseOpponentPosition?.fen ?? selectedNode.fen;
  const suddenDeathReviewPosition = suddenDeathGameOver?.positions[suddenDeathGameOver.index];
  const suddenDeathReviewCommand = suddenDeathGameOver
    ? suddenDeathPositionCommand(suddenDeathGameOver.positions, suddenDeathGameOver.index)
    : undefined;
  const hasSuddenDeathBoardOverride = Boolean(
    suddenDeathCurrentFen && trainingSession?.side === activeSide && trainingSession.suddenDeathMode,
  );
  const hasExampleReplayBoardOverride = Boolean(exampleReplay && exampleReplay.side === activeSide);
  const boardFen = suddenDeathReviewPosition?.fen ?? (hasExampleReplayBoardOverride
    ? (exampleReplay as ExampleReplayState).fens[(exampleReplay as ExampleReplayState).currentIndex]
    : hasSuddenDeathBoardOverride
      ? (suddenDeathCurrentFen as string)
      : selectedBoardFen);
  const showLichessArrowsOnBoard = showLichessArrows && (!lichessArrowsOpponentOnly || toTurnColor(boardFen) !== activeSide);
  const playerPositionKey = bookPositionFenKey(selectedBoardFen);
  const playerReviewKey = playerAssessmentKey(playerHandle, activeSide, playerPositionKey);
  const playerAssessment = playerAssessments[playerReviewKey];
  const playerRepertoireMoves = playerRepertoire?.movesByFen.get(playerPositionKey);
  const maiaPositionFen = fullBoardFen(suddenDeathReviewPosition?.fen ?? selectedBoardFen);
  const enginePvFen = selectedEngine === 'stockfish' ? stockfishLinesFen : maiaPositionFen;
  const currentMaiaKey = `${maiaPositionFen}|${maiaStrengthElo}`;
  const maiaComparisonKey = `${currentMaiaKey}|${engineMultiPv}`;
  const showMixedEngines = bothEngines && selectedEngine === 'maia';
  const useCompactEngineArrows = showMixedEngines && movesArrowGroupNeedsCompact;
  const anyEngineArrows = showStockfishArrows || showMaiaArrows;
  const stockfishArrowsVisible = useCompactEngineArrows && combineCompactEngineArrows ? anyEngineArrows : showStockfishArrows;
  const maiaArrowsVisible = useCompactEngineArrows
    ? combineCompactEngineArrows ? anyEngineArrows : showMaiaArrows && !showStockfishArrows
    : showMaiaArrows;
  const comparison = maiaStockfishComparison?.key === maiaComparisonKey ? maiaStockfishComparison : null;
  const isGameReviewRunning = Boolean(analysisGameProgress);
  const maiaPopularity = useMaiaPopularity(maiaPositionFen, maiaStrengthElo,
    showMaiaPopularity && selectedEngine === 'maia' && engineRunning && !analysisGameProgress &&
    engineStatus === 'done' && maiaResultKey === currentMaiaKey);
  const trainingForActive = trainingSession?.side === activeSide && !trainingSession.suddenDeathMode;
  const isTreeEvalRunning = Boolean(treeEvalProgress?.running);

  const path = useMemo(() => buildPath(tree, selectedNode.id), [tree, selectedNode.id]);
  const mainLinePath = useMemo(() => buildMainLinePath(tree), [tree]);
  const currentPathGameKey = path.map((node) => `${node.id}:${node.moveUci ?? ''}:${node.fen}`).join('|');
  const gameAnalysisReportMatchesLine = Boolean(
    gameAnalysisReport &&
    gameAnalysisReport.side === activeSide &&
    gameAnalysisReport.gameKey === mainLinePath.map(node => `${node.id}:${node.moveUci ?? ''}:${node.fen}`).join('|') &&
    (gameAnalysisReport.sourceId
      ? gameAnalysisReport.sourceId === (activeRepertoireIdBySide[activeSide] ?? `browse:${activeSide}`) &&
        gameAnalysisReport.rootNodeId === tree.rootId &&
        gameAnalysisReport.rootFen === tree.nodes[tree.rootId]?.fen
      : gameAnalysisReport.gameKey === currentPathGameKey || gameAnalysisReport.gameKey.startsWith(`${currentPathGameKey}|`)),
  );
  useEffect(() => {
    setAnalysisScratchPosition(null);
    setHoveredEngineMove(null);
  }, [activeSide, selectedNode.id]);

  useEffect(() => {
    if (lichessSource !== 'player') {
      setAnalysisScratchPosition(previous => previous?.playerMoves ? null : previous);
    }
  }, [lichessSource]);

  useEffect(() => () => playerAssessmentJobRef.current?.abort(),
    [selectedBoardFen, activeSide, playerHandle, lichessSource, trainingSession]);

  const childNodes = useMemo(
    () => selectedNode.children.map((id) => tree.nodes[id]).filter(Boolean),
    [selectedNode.children, tree.nodes],
  );

  const collectMergedMoveOptionsAtFen = useCallback((side: Side, fen: string, includeTrainingAlternatives?: boolean): BrowseMoveOption[] => {
    const byUci = new Map<string, { moveSan: string; repertoireNames: Set<string> }>();
    const targetFenKey = positionFenKey(fen);
    const filterOwnMoves = includeTrainingAlternatives !== undefined && toTurnColor(fen) === side;

    for (const repertoire of enabledRepertoiresBySide[side]) {
      const nodes = Object.values(repertoire.tree.nodes).filter((node) => positionFenKey(node.fen) === targetFenKey);
      if (nodes.length === 0) continue;
      for (const node of nodes) {
        const children = filterOwnMoves ? trainingMoveIds(repertoire.tree, node, true, includeTrainingAlternatives) : node.children;
        for (const childId of children) {
          const child = repertoire.tree.nodes[childId];
          if (!child?.moveUci || !child.moveSan) continue;
          const existing = byUci.get(child.moveUci);
          if (existing) {
            existing.repertoireNames.add(repertoire.name);
          } else {
            byUci.set(child.moveUci, { moveSan: child.moveSan, repertoireNames: new Set([repertoire.name]) });
          }
        }
      }
    }

    return [...byUci.entries()]
      .map(([moveUci, value]) => ({
        moveUci,
        moveSan: value.moveSan,
        repertoireNames: [...value.repertoireNames],
      }))
      .sort((a, b) => b.repertoireNames.length - a.repertoireNames.length || a.moveSan.localeCompare(b.moveSan));
  }, [enabledRepertoiresBySide]);

  const browseMoveOptions = useMemo<BrowseMoveOption[]>(() => {
    if (!isBrowseMode) return [];
    return collectMergedMoveOptionsAtFen(activeSide, selectedNode.fen, trainingForActive ? trainAlternativeMoves : undefined);
  }, [isBrowseMode, selectedNode.fen, collectMergedMoveOptionsAtFen, activeSide, trainingForActive, trainAlternativeMoves]);

  const displayedChildNodes = useMemo<MoveNode[]>(() => {
    if (!isBrowseMode) return childNodes;
    return browseMoveOptions.map((option, index) => ({
      id: `browse-${index}-${option.moveUci}`,
      parentId: selectedNode.id,
      fen: selectedNode.fen,
      moveSan: option.moveSan,
      moveUci: option.moveUci,
      children: [],
    }));
  }, [isBrowseMode, childNodes, browseMoveOptions, selectedNode.id, selectedNode.fen]);

  const repertoiresAtPosition = useMemo(() => {
    const targetFenKey = positionFenKey(selectedNode.fen);
    return enabledRepertoiresBySide[boardOrientation]
      .filter((repertoire) => repertoireHasMoves(repertoire.tree))
      .filter((repertoire) =>
        Object.values(repertoire.tree.nodes).some((node) => positionFenKey(node.fen) === targetFenKey),
      )
      .map((repertoire) => ({
        id: repertoire.id,
        name: repertoire.name,
        isActive: boardOrientation === activeSide && repertoire.id === activeRepertoireIdBySide[activeSide],
      }))
      .sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [selectedNode.fen, enabledRepertoiresBySide, boardOrientation, activeSide, activeRepertoireIdBySide]);

  const historyPlayer = playerHandle.trim().toLowerCase();
  const savedPlayerHistory = playerHistory?.player === historyPlayer ? playerHistory.data : null;
  const repertoireDeviations = useMemo(() => {
    if (!showMistakeArrows || isBrowseMode || !savedPlayerHistory?.reviewIndex) return null;
    return playerRepertoireDeviations(savedPlayerHistory, mistakePreparedByFen, activeSide, playerSpeeds, selectedModes,
      playerGameHistoryStart(Date.now(), mistakeHistoryMonths));
  }, [showMistakeArrows, isBrowseMode, savedPlayerHistory, mistakePreparedByFen, activeSide, playerSpeeds,
    selectedModes, mistakeHistoryMonths]);
  const currentDeviations = boardFen === selectedNode.fen && !analysisScratchFen
    ? repertoireDeviations?.get(bookPositionFenKey(selectedNode.fen)) : undefined;
  const historyRepertoireKey = useMemo(() => {
    const positions = new Set<string>();
    for (const entry of [...enabledRepertoiresBySide.white, ...enabledRepertoiresBySide.black]) {
      if (!repertoireHasMoves(entry.tree)) continue;
      for (const fen of historyPositionsForTree(entry.tree)) positions.add(fen);
    }
    return JSON.stringify([...positions].sort());
  }, [enabledRepertoiresBySide]);
  const getExplorerUrl = useCallback((fen: string, historyDates?: ExplorerDates, source = lichessSource) => {
    const params = new URLSearchParams({ fen: fullBoardFen(fen), variant: FIXED_VARIANT, color: activeSide });
    if (source === 'player') {
      params.set('fen', bookPositionFenKey(fen) + ' 0 1');
      params.set('player', playerHandle.trim().toLowerCase());
      if (playerSpeeds.length && playerSpeeds.length !== PLAYER_SPEEDS.length) params.set('speeds', [...playerSpeeds].sort().join(','));
      params.set('modes', [...(selectedModes.length ? selectedModes : MODES)].sort().join(','));
      params.set('source', FIXED_SOURCE);
      if (historyDates) params.set('moves', '256');
    } else if (source === 'lichess') {
      if (selectedSpeeds.length) params.set('speeds', selectedSpeeds.join(','));
      if (selectedRatings.length) params.set('ratings', selectedRatings.join(','));
    }
    const dates = historyDates ?? explorerDateFilter(source, dateRange);
    if (dates?.since) params.set('since', dates.since);
    if (dates?.until) params.set('until', dates.until);
    const top = maxTopGamesForSource(source), recent = maxRecentGamesForSource(source);
    if (top) params.set('topGames', String(top));
    if (recent) params.set('recentGames', String(recent));
    return 'https://explorer.lichess.ovh/' + source + '?' + params;
  }, [activeSide, dateRange, lichessSource, playerHandle, playerSpeeds, selectedModes, selectedRatings, selectedSpeeds]);

  const explorerFen = lichessSource === 'player' ? selectedBoardFen : browseOpponentPosition?.fen ?? selectedNode.fen;
  const explorerUrl = getExplorerUrl(explorerFen);
  const explorerRequestKey = JSON.stringify([explorerUrl, lichessApiToken]);
  const isPlayerExplorer = lichessSource === 'player';
  const playerToMove = isPlayerExplorer && toTurnColor(selectedBoardFen) === activeSide;
  const playerAfterLine = isPlayerExplorer && !isBrowseMode && !playerToMove && !playerRepertoireMoves?.size;
  const [localExplorer, setLocalExplorer] = useState<{
    requestKey: string; games: PlayerGameHistory['games']; data: LichessResponse;
  } | null>(null);
  useEffect(() => {
    if (!isPlayerExplorer || !savedPlayerHistory || mistakeReview || opponentReview || trainingSession) return;
    const controller = new AbortController();
    const { signal } = controller;
    void indexPlayerGameHistory(savedPlayerHistory, new Set([playerPositionKey]), activeSide, playerSpeeds, selectedModes, signal, false)
      .then(query => {
        if (signal.aborted) return;
        const data = query(playerPositionKey, explorerDateFilter('player', dateRange) ?? undefined);
        setLocalExplorer({ requestKey: explorerRequestKey, games: savedPlayerHistory.games, data });
      })
      .catch(error => { if (!signal.aborted) console.error('Could not read local Lichess games', error); });
    return () => controller.abort();
  }, [isPlayerExplorer, savedPlayerHistory, mistakeReview, opponentReview, trainingSession, playerPositionKey,
    activeSide, playerSpeeds, selectedModes, dateRange, explorerRequestKey]);
  const networkExplorerData = lichessDataRequestKey === explorerRequestKey &&
    (!isPlayerExplorer || historyPlayer) ? lichessData : null;
  const localExplorerData = isPlayerExplorer && localExplorer?.requestKey === explorerRequestKey &&
    localExplorer.games === savedPlayerHistory?.games ? localExplorer.data : null;
  const usingLocalExplorer = !opponentFindingOnBoard && Boolean(localExplorerData && (dateRange !== '3y' || !networkExplorerData));
  const explorerData = opponentFindingOnBoard?.data ?? (usingLocalExplorer ? localExplorerData : networkExplorerData);
  const lichessTotal = explorerData ? explorerGameCount(explorerData) : 0;
  const playerExplorerPositionMoves = useMemo(() => {
    if (!isPlayerExplorer || !explorerData) return [];
    const moves = playerExplorerMoves(selectedBoardFen, explorerData.moves);
    if (opponentFindingOnBoard) return moves.filter(move => opponentFindingOnBoard.moves.has(move.uci));
    if (!playerAfterLine) return moves;
    return moves.filter(move => {
      const reply = explorerReplyFen(selectedBoardFen, move.uci);
      return reply && hasPlayedMistake(playerAssessments[playerAssessmentKey(playerHandle, activeSide, bookPositionFenKey(reply))]);
    });
  }, [isPlayerExplorer, explorerData, selectedBoardFen, opponentFindingOnBoard,
    playerAfterLine, playerAssessments, playerHandle, activeSide]);

  const autoArrows = useMemo<DrawShape[]>(() => {
    if (reviewPositionOnBoard && !analysisScratchFen) {
      return softenOverlappingArrows(reviewPosition.moves.flatMap<DrawShape>(row => {
        const move = parseUciMove(row.uci);
        return move ? [{ orig: move[0], dest: move[1], brush: row.inRepertoire ? 'green' : 'red' }] : [];
      }));
    }
    const treeChildUcis = opponentFindingOnBoard?.prepared ?? new Set(analysisScratchFen ? [] :
      displayedChildNodes.map(node => node.moveUci).filter((uci): uci is string => Boolean(uci)),
    );

    const treeArrows = !analysisScratchFen && showTreeArrows
      ? [...treeChildUcis]
          .map(parseUciMove)
          .filter((value): value is [Key, Key] => Boolean(value))
          .map(([orig, dest]) => ({ orig, dest, brush: 'green' }))
      : [];
    const mistakeArrows = (currentDeviations ?? []).flatMap<DrawShape>(uci => {
      const move = parseUciMove(uci);
      return move ? [{ orig: move[0], dest: move[1], brush: 'red' }] : [];
    });

    const thresholdShare = lichessArrowThreshold / 100;
    const lichessArrows =
      (!analysisScratchFen || isPlayerExplorer) && showLichessArrowsOnBoard && lichessTotal > 0
        ? (() => {
            const explorerMoves = isPlayerExplorer ? playerExplorerPositionMoves : (explorerData?.moves ?? [])
              .filter(move => !opponentFindingOnBoard || opponentFindingOnBoard.moves.has(move.uci));
            const allEntries = explorerMoves
              .map((move) => {
                const share = explorerGameCount(move) / lichessTotal;
                const keyPair = parseUciMove(move.uci);
                const isHiddenByTreeFilter = !showLichessOnTreeMoves && treeChildUcis.has(move.uci);
                return { share, keyPair, isHiddenByTreeFilter };
              })
              .filter((entry) => Boolean(entry.keyPair));

            const maxShare = Math.max(...allEntries.map((item) => item.share), 0);

            const candidates = allEntries.filter(
              (entry) => entry.share > 0 && !entry.isHiddenByTreeFilter && (opponentFindingOnBoard || entry.share >= thresholdShare),
            );

            if (candidates.length === 0) return [];

            const minLineWidth = 6;
            const maxLineWidth = 18;

            return candidates.map((entry) => {
              const [orig, dest] = entry.keyPair as [Key, Key];
              const ratio = maxShare > 0 ? entry.share / maxShare : 1;
              const lineWidth = minLineWidth + ratio * (maxLineWidth - minLineWidth);
              return {
                orig,
                dest,
                brush: 'yellow',
                modifiers: { lineWidth },
              } as DrawShape;
            });
          })()
        : [];

    const maiaLines = engineRunning && maiaArrowsVisible && selectedEngine === 'maia' && maiaResultKey === currentMaiaKey
      ? engineLines : [];
    const maxPopularity = Math.max(0, ...maiaLines.map(line => line.evalValue));
    const maiaArrows = maiaLines.flatMap<DrawShape>(line => {
      const move = parseUciMove(line.bestMove);
      if (!move) return [];
      const [orig, dest] = move;
      const ratio = maxPopularity > 0 ? Math.max(0, line.evalValue) / maxPopularity : 1;
      return [{ orig, dest, brush: 'purple', modifiers: { lineWidth: 6 + ratio * 12 } }];
    });

    const stockfishLines = engineRunning && stockfishArrowsVisible
      ? showMixedEngines
        ? (comparison?.stockfishMoves ?? []).map(candidate => ({
            bestMove: candidate.uci,
            evalValue: stockfishRank(candidate, toTurnColor(maiaPositionFen)),
          }))
        : selectedEngine === 'stockfish' && enginePvFen === maiaPositionFen ? engineLines : []
      : [];
    const topEval = stockfishLines[0]?.evalValue ?? 0;
    const stockfishArrows = stockfishLines.flatMap<DrawShape>(line => {
      const move = parseUciMove(line.bestMove);
      if (!move) return [];
      const [orig, dest] = move;
      const diff = Math.max(0, topEval - line.evalValue);
      return [{
        orig,
        dest,
        brush: diff > 100 ? 'red' : 'blue',
        modifiers: { lineWidth: 6 + (1 - Math.min(diff / 100, 1)) * 12 },
      }];
    });

    return suddenDeathReviewPosition ? [...maiaArrows, ...stockfishArrows]
      : softenOverlappingArrows([...treeArrows, ...lichessArrows, ...maiaArrows, ...stockfishArrows, ...mistakeArrows]);
  }, [
    suddenDeathReviewPosition,
    reviewPosition,
    reviewPositionOnBoard,
    opponentFindingOnBoard,
    displayedChildNodes,
    showTreeArrows,
    currentDeviations,
    explorerData,
    isPlayerExplorer,
    playerExplorerPositionMoves,
    lichessTotal,
    lichessArrowThreshold,
    engineLines,
    engineRunning,
    enginePvFen,
    selectedEngine,
    showMixedEngines,
    comparison,
    maiaPositionFen,
    maiaResultKey,
    currentMaiaKey,
    showLichessArrowsOnBoard,
    maiaArrowsVisible,
    stockfishArrowsVisible,
    showLichessOnTreeMoves,
    analysisScratchFen,
  ]);

  const lastMove = parseUciMove(selectedNode.moveUci);

  const applyPersistedSettingsState = useCallback((persistedSettings: PersistedSettingsState) => {
    setThemeMode(persistedSettings.themeMode);
    setSelectedEngine(persistedSettings.selectedEngine);
    setBothEngines(persistedSettings.bothEngines);
    setMaiaStrengthElo(persistedSettings.maiaStrengthElo);
    setAnalysisBenchmarkElo(persistedSettings.analysisBenchmarkElo ?? 1800);
    setRepertoireSide(persistedSettings.repertoireSide);
    setIsTempBoardFlipped(persistedSettings.isTempBoardFlipped);
    setLichessSource(persistedSettings.lichessSource);
    setPlayerHandle(persistedSettings.playerHandle);
    setPlayerSpeeds(persistedSettings.playerSpeeds.length ? persistedSettings.playerSpeeds : [...PLAYER_SPEEDS]);
    setLichessApiToken(persistedSettings.lichessApiToken);
    setDateRange(persistedSettings.dateRange);
    setLichessArrowThreshold(persistedSettings.lichessArrowThreshold);
    setNextMissingMoveThreshold(persistedSettings.nextMissingMoveThreshold);
    setPlayerNextMissingMoveThreshold(persistedSettings.playerNextMissingMoveThreshold);
    setDesktopLichessShare(persistedSettings.desktopLichessShare);
    setEngineDepth(persistedSettings.engineDepth);
    setEngineMultiPv(persistedSettings.engineMultiPv);
    setSelectedSpeeds(
      persistedSettings.selectedSpeeds.length > 0
        ? persistedSettings.selectedSpeeds
        : SPEEDS.filter((speed) => speed !== 'bullet'),
    );
    setSelectedRatings(persistedSettings.selectedRatings.length > 0 ? persistedSettings.selectedRatings : [2000, 2200, 2500]);
    setSelectedModes(persistedSettings.selectedModes.length > 0 ? persistedSettings.selectedModes : [...MODES]);
    setShowLichessOnTreeMoves(persistedSettings.showLichessOnTreeMoves);
    setLichessArrowsOpponentOnly(persistedSettings.lichessArrowsOpponentOnly);
    setShowMistakeArrows(persistedSettings.showMistakeArrows);
    setMistakeHistoryMonths(persistedSettings.mistakeHistoryMonths);
    setShowTreeArrows(persistedSettings.showTreeArrows);
    setShowLichessArrows(persistedSettings.showLichessArrows);
    setShowStockfishArrows(persistedSettings.showStockfishArrows);
    setShowMaiaArrows(persistedSettings.showMaiaArrows);
    setCombineCompactEngineArrows(persistedSettings.combineCompactEngineArrows);
    setStockfishEvalSeconds(persistedSettings.stockfishEvalSeconds);
    setTrainingStatsQueueLength(persistedSettings.trainingStatsQueueLength);
    setTrainAlternativeMoves(persistedSettings.trainAlternativeMoves);
    setSuddenDeathThreshold(persistedSettings.suddenDeathThreshold);
    setSuddenDeathMinMoves(persistedSettings.suddenDeathMinMoves);
    setSuddenDeathStockfishElo(persistedSettings.suddenDeathStockfishElo);
    setSuddenDeathEngine(persistedSettings.suddenDeathEngine);
    setSuddenDeathMaiaElo(persistedSettings.suddenDeathMaiaElo);
    setSuddenDeathMaxThinkTimeSec(persistedSettings.suddenDeathMaxThinkTimeSec);
  }, []);

  const applyPersistedDatabaseState = useCallback((persisted: PersistedAppState | null) => {
    setBrowseAnnotations(persisted?.browseAnnotations ?? {});
    setDrawingTarget(null);
    if (persisted) {
      setRepertoiresBySide(persisted.repertoiresBySide);
      setActiveRepertoireIdBySide({ white: null, black: null });
      // Review starts with a fresh working tree, independent of saved repertoires.
      const whiteTree = createEmptyTree('white');
      const blackTree = createEmptyTree('black');
      setTrees({
        white: whiteTree,
        black: blackTree,
      });
      setSelectedNodeBySide({
        white: whiteTree.rootId,
        black: blackTree.rootId,
      });
    } else {
      const whiteTree = createEmptyTree('white');
      const blackTree = createEmptyTree('black');
      setRepertoiresBySide({ white: [], black: [] });
      setActiveRepertoireIdBySide({ white: null, black: null });
      setTrees({ white: whiteTree, black: blackTree });
      setSelectedNodeBySide({ white: whiteTree.rootId, black: blackTree.rootId });
    }
    setUndoStackBySide({ white: [], black: [] });
    setTrainingSession(null);
    setSuddenDeathGameOver(null);
    suddenDeathRoundRef.current = null;
    setSuddenDeathStartNodeId(null);
    setSuddenDeathCurrentFen(null);
    setSuddenDeathLastMove(null);
    setOpponentReview(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrateAppState = async () => {
      setStatus('Loading local repertoire...');
      try {
        if (navigator.storage?.persist) {
          await navigator.storage.persist();
        }
      } catch {
        // Ignore storage persistence permission failures.
      }

      try {
        const persisted = normalizePersistedState(await idbGet<PersistedAppState>(APP_STATE_KEY));
        const persistedSettings = normalizePersistedSettings(await idbGet<PersistedSettingsState>(APP_SETTINGS_KEY));
        const persistedTrainingStats = normalizeTrainingStats(await idbGet<TrainingStatsState>(APP_TRAINING_STATS_KEY));
        const persistedTrainingLeafLastShown = normalizeTrainingLeafLastShown(
          await idbGet<TrainingLeafLastShownState>(APP_TRAINING_LEAF_LAST_SHOWN_KEY),
        );
        const persistedGameAnalysis = await idbGet<GameAnalysisReport>(APP_GAME_ANALYSIS_REPORT_KEY);
        const assessments = await idbGet<PlayerAssessments>(APP_PLAYER_ASSESSMENTS_KEY).catch(() => null);

        if (cancelled) return;

        if (persistedSettings) applyPersistedSettingsState(persistedSettings);
        applyPersistedDatabaseState(persisted);
        setTrainingStatsBySide(persistedTrainingStats ?? createEmptyTrainingStatsState());
        setTrainingLeafLastShownBySide(persistedTrainingLeafLastShown ?? createEmptyTrainingLeafLastShownState());
        if (persistedGameAnalysis?.version === 2) {
          setGameAnalysisReport({
            ...persistedGameAnalysis,
            status: persistedGameAnalysis.status === 'running' ? 'partial' : persistedGameAnalysis.status,
          });
        }
        if (assessments) setPlayerAssessments(assessments);
        setStatus('Ready');
        setHasHydratedAppState(true);
      } catch {
        if (!cancelled) {
          setStatus('Local storage load failed');
          setStorageLoadFailed(true);
        }
      }
    };

    void hydrateAppState();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if ((selectedEngine === 'stockfish' || (showMixedEngines && engineRunning && !isGameReviewRunning)) &&
      !stockfishRef.current) {
      setStockfishGeneration((value) => value + 1);
    }
  }, [selectedEngine, showMixedEngines, engineRunning, isGameReviewRunning]);

  useEffect(() => {
    if (!hasHydratedAppState || !gameAnalysisReport) return;
    const timeout = window.setTimeout(() => {
      void idbSet(APP_GAME_ANALYSIS_REPORT_KEY, gameAnalysisReport).catch(() => {
        setStatus('Game analysis save failed');
      });
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [hasHydratedAppState, gameAnalysisReport]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    setRepertoiresBySide((prev) => {
      let changed = false;
      const next = { ...prev };
      (['white', 'black'] as Side[]).forEach((side) => {
        const activeId = activeRepertoireIdBySide[side];
        if (!activeId || repertoireModeBySide[side] !== 'edit') return;
        const idx = prev[side].findIndex((entry) => entry.id === activeId);
        if (idx < 0) return;
        const current = prev[side][idx];
        const currentTree = trees[side];
        const currentSelectedId = selectedNodeBySide[side] ?? currentTree.rootId;
        if (current.tree === currentTree && current.selectedNodeId === currentSelectedId) return;
        const nextList = [...prev[side]];
        nextList[idx] = {
          ...current,
          tree: currentTree,
          selectedNodeId: currentSelectedId,
        };
        next[side] = nextList;
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [hasHydratedAppState, trees, selectedNodeBySide, activeRepertoireIdBySide, repertoireModeBySide]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const payload: PersistedAppState = {
      version: 2,
      repertoiresBySide,
      activeRepertoireIdBySide,
      browseAnnotations,
    };

    const timeout = window.setTimeout(() => {
      void idbSet(APP_STATE_KEY, payload).catch(() => {
        setStatus('Local save failed');
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [hasHydratedAppState, repertoiresBySide, activeRepertoireIdBySide, browseAnnotations]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const settingsPayload: PersistedSettingsState = {
      version: 1,
      themeMode,
      selectedEngine,
      bothEngines,
      maiaStrengthElo,
      analysisBenchmarkElo,
      suddenDeathEngine,
      suddenDeathMaiaElo,
      repertoireSide,
      isTempBoardFlipped,
      lichessSource,
      playerHandle,
      playerSpeeds,
      lichessApiToken,
      dateRange,
      lichessArrowThreshold,
      engineDepth,
      engineMultiPv,
      selectedSpeeds,
      selectedRatings,
      selectedModes,
      showLichessOnTreeMoves,
      lichessArrowsOpponentOnly,
      showMistakeArrows,
      mistakeHistoryMonths,
      showTreeArrows,
      showLichessArrows,
      showStockfishArrows,
      showMaiaArrows,
      combineCompactEngineArrows,
      stockfishEvalSeconds,
      trainingStatsQueueLength,
      trainAlternativeMoves,
      suddenDeathThreshold,
      suddenDeathMinMoves,
      suddenDeathStockfishElo,
      suddenDeathMaxThinkTimeSec,
      nextMissingMoveThreshold,
      playerNextMissingMoveThreshold,
      desktopLichessShare,
    };

    const timeout = window.setTimeout(() => {
      void idbSet(APP_SETTINGS_KEY, settingsPayload).catch(() => {
        setStatus('Local settings save failed');
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [
    hasHydratedAppState,
    themeMode,
    selectedEngine,
    bothEngines,
    maiaStrengthElo,
    analysisBenchmarkElo,
    suddenDeathEngine,
    suddenDeathMaiaElo,
    repertoireSide,
    isTempBoardFlipped,
    lichessSource,
    playerHandle,
    playerSpeeds,
    lichessApiToken,
    dateRange,
    lichessArrowThreshold,
    nextMissingMoveThreshold,
    playerNextMissingMoveThreshold,
    desktopLichessShare,
    engineDepth,
    engineMultiPv,
    selectedSpeeds,
    selectedRatings,
    selectedModes,
    showLichessOnTreeMoves,
    lichessArrowsOpponentOnly,
    showMistakeArrows,
    mistakeHistoryMonths,
    showTreeArrows,
    showLichessArrows,
    showStockfishArrows,
    showMaiaArrows,
    combineCompactEngineArrows,
    stockfishEvalSeconds,
    trainingStatsQueueLength,
    trainAlternativeMoves,
    suddenDeathThreshold,
    suddenDeathMinMoves,
    suddenDeathStockfishElo,
    suddenDeathMaxThinkTimeSec,
  ]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const timeout = window.setTimeout(() => {
      void idbSet(APP_TRAINING_STATS_KEY, trainingStatsBySide).catch(() => {
        setStatus('Local training stats save failed');
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [hasHydratedAppState, trainingStatsBySide]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const timeout = window.setTimeout(() => {
      void idbSet(APP_TRAINING_LEAF_LAST_SHOWN_KEY, trainingLeafLastShownBySide).catch(() => {
        setStatus('Local training last-shown save failed');
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [hasHydratedAppState, trainingLeafLastShownBySide]);

  useEffect(() => {
    setTrainingStatsBySide((prev) => {
      let changed = false;
      const next: TrainingStatsState = { white: {}, black: {} };
      (['white', 'black'] as Side[]).forEach((side) => {
        const sideScopes = prev[side];
        const nextScopes: Record<string, Record<string, TrainingPositionStat>> = {};
        Object.entries(sideScopes).forEach(([scopeId, fenStats]) => {
          const nextFenStats: Record<string, TrainingPositionStat> = {};
          Object.entries(fenStats).forEach(([fenKey, stat]) => {
            const trimmed = stat.recentAnswers.slice(-trainingStatsQueueLength);
            if (trimmed.length !== stat.recentAnswers.length) changed = true;
            nextFenStats[fenKey] = { recentAnswers: trimmed };
          });
          nextScopes[scopeId] = nextFenStats;
        });
        next[side] = nextScopes;
      });
      return changed ? next : prev;
    });
  }, [trainingStatsQueueLength]);

  useEffect(() => {
    engineRunningRef.current = engineRunning;
  }, [engineRunning]);

  useEffect(() => {
    selectedEngineRef.current = selectedEngine;
  }, [selectedEngine]);

  useEffect(() => {
    maiaStrengthEloRef.current = maiaStrengthElo;
  }, [maiaStrengthElo]);

  useEffect(() => {
    const worker = new Worker('/stockfish/stockfish-19-lite-single.js');
    stockfishRef.current = worker;
    isSearchingRef.current = false;
    pendingAnalysisRef.current = null;

    tryStartPendingRef.current = () => {
      const w = stockfishRef.current;
      if (!w || !engineReadyRef.current || !engineRunningRef.current || suddenDeathBusyRef.current) return;
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
      setStockfishLinesFen(pending.fen);
      engineWhitePerspectiveMultiplierRef.current = whitePerspectiveMultiplierFromFen(pending.fen);
      w.postMessage(`setoption name MultiPV value ${pending.multipv}`);
      w.postMessage('setoption name UCI_LimitStrength value false');
      w.postMessage(pending.positionCommand ?? `position fen ${pending.fen}`);
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
        setStockfishLoaded(true);
        setEngineReadyTick((prev) => prev + 1);
        if (selectedEngineRef.current === 'stockfish') setEngineStatus((prev) => (prev === 'stopped' ? prev : 'idle'));
        tryStartPendingRef.current?.();
        return;
      }

      if (text.startsWith('info ') && text.includes(' pv ') && text.includes(' multipv ')) {
        const pending = suddenDeathAwaiterRef.current;
        if (pending && !/\b(?:lowerbound|upperbound)\b/.test(text)) {
          const depth = Number(text.match(/\bdepth (\d+)/)?.[1] ?? 0);
          const rank = Number(text.match(/\bmultipv (\d+)/)?.[1] ?? 0);
          const cp = text.match(/\bscore cp (-?\d+)/);
          const mate = text.match(/\bscore mate (-?\d+)/);
          const uci = text.match(/\bpv (\S+)/)?.[1];
          const rawWdl = text.match(/\bwdl (\d+) (\d+) (\d+)/);
          if (depth && rank && uci && (cp || mate)) {
            const value = Number((cp ?? mate)![1]) * pending.perspectiveMultiplier;
            const wdl: [number, number, number] | null = rawWdl
              ? pending.wdlMultiplier < 0 ? [+rawWdl[3], +rawWdl[2], +rawWdl[1]] : [+rawWdl[1], +rawWdl[2], +rawWdl[3]] : null;
            const layer = pending.candidateLayers.get(depth) ?? new Map<number, CandidateEvaluation>();
            layer.set(rank, { uci, depth, evalCp: cp ? value : value > 0 ? 100000 : -100000,
              scoreText: cp ? formatSignedCp(value) : formatSignedMate(value), wdl, pv: text.match(/\bpv (.+)$/)?.[1] });
            pending.candidateLayers.set(depth, layer);
            for (const old of pending.candidateLayers.keys()) if (old < depth - 2) pending.candidateLayers.delete(old);
          }
        }
        if (pending && /\bmultipv 1\b/.test(text)) {
          const awaiter = pending;
          const cpMatch = text.match(/ score cp (-?\d+)/);
          const mateMatch = text.match(/ score mate (-?\d+)/);
          const wdlMatch = text.match(/\bwdl (\d+) (\d+) (\d+)/);
          const pvMatch = text.match(/ pv (.+)$/);
          const depthMatch = text.match(/ depth (\d+)/);
          const nodesMatch = text.match(/ nodes (\d+)/);
          const previousDepth = awaiter.latestDepth;
          const isBound = text.includes(' lowerbound') || text.includes(' upperbound');
          const hasScore = Boolean(cpMatch || mateMatch);
          const infoDepth = depthMatch ? Number(depthMatch[1]) : 0;
          // A later bound score is not an exact evaluation. Keep the last exact
          // score instead of replacing it and marking the whole position unavailable.
          if (isBound || !hasScore || infoDepth < previousDepth) {
            if (awaiter.latestDepth === 0 && infoDepth > 0) awaiter.onInfo?.('?');
          } else {
            if (cpMatch) {
              awaiter.latestEvalCp = Number(cpMatch[1]) * awaiter.perspectiveMultiplier;
              awaiter.latestScoreText = formatSignedCp(awaiter.latestEvalCp);
            } else if (mateMatch) {
              const matePly = Number(mateMatch[1]) * awaiter.perspectiveMultiplier;
              awaiter.latestEvalCp = matePly > 0 ? 100000 : -100000;
              awaiter.latestScoreText = formatSignedMate(matePly);
            }
            if (pvMatch) awaiter.latestPv = pvMatch[1].trim();
            if (infoDepth > 0) awaiter.latestDepth = infoDepth;
            if (nodesMatch) awaiter.latestNodes = Number(nodesMatch[1]);
            if (wdlMatch) {
              const [, win, draw, loss] = wdlMatch;
              const [w, d, l] = [Number(win), Number(draw), Number(loss)];
              awaiter.latestWdl = awaiter.wdlMultiplier < 0 ? [l, d, w] : [w, d, l];
            }
            awaiter.latestScoreIsBound = false;
            if (awaiter.latestDepth > previousDepth) awaiter.onInfo?.(awaiter.latestScoreText);
          }
        }

        if (pending) return;
        const multipvMatch = text.match(/ multipv (\d+)/);
        const cpMatch = text.match(/ score cp (-?\d+)/);
        const mateMatch = text.match(/ score mate (-?\d+)/);
        const pvMatch = text.match(/ pv (.+)$/);

        if (!multipvMatch || !pvMatch) return;

        const multipv = Number(multipvMatch[1]);
        const pv = pvMatch[1].trim();
        const bestMove = pv.split(' ')[0] || '';
        const perspective = engineWhitePerspectiveMultiplierRef.current;
        const normalizedCp = cpMatch ? Number(cpMatch[1]) * perspective : null;
        const normalizedMate = mateMatch ? Number(mateMatch[1]) * perspective : null;
        const scoreText = cpMatch
          ? formatSignedCp(normalizedCp!)
          : mateMatch
            ? formatSignedMate(normalizedMate!)
            : '?';
        const evalValue = cpMatch
          ? Number(cpMatch[1])
          : mateMatch
            ? Number(mateMatch[1]) * 100000
            : 0;

        lineCacheRef.current.set(multipv, { multipv, scoreText, pv, bestMove, evalValue });
        if (selectedEngineRef.current === 'stockfish' && engineRunningRef.current) {
          setEngineLines(Array.from(lineCacheRef.current.values()).sort((a, b) => a.multipv - b.multipv));
        }
        if (multipv === 1 && treeEvalAwaiterRef.current) {
          treeEvalAwaiterRef.current.latestScore = scoreText;
        }
        return;
      }

      if (text.startsWith('bestmove')) {
        if (suddenDeathAwaiterRef.current) {
          const awaiter = suddenDeathAwaiterRef.current;
          suddenDeathAwaiterRef.current = null;
          if (awaiter.timeoutId !== null) window.clearTimeout(awaiter.timeoutId);
          const bestMove = text.split(' ')[1] || null;
          const completeLayer = [...awaiter.candidateLayers.entries()].sort(([a], [b]) => b-a)
            .find(([, layer]) => layer.size >= awaiter.requiredCandidates)?.[1];
          const principal = completeLayer?.get(1);
          awaiter.resolve({
            scoreText: principal?.scoreText ?? awaiter.latestScoreText,
            evalCp: principal?.evalCp ?? awaiter.latestEvalCp,
            bestMove: principal?.uci ?? bestMove,
            pv: principal?.pv ?? awaiter.latestPv,
            depth: principal?.depth ?? awaiter.latestDepth,
            nodes: awaiter.latestNodes,
            hasScore: awaiter.latestDepth > 0 && !awaiter.latestScoreIsBound,
            wdl: principal?.wdl ?? awaiter.latestWdl,
            candidates: [...((completeLayer ?? awaiter.candidateLayers.get(awaiter.latestDepth))?.entries() ?? [])]
              .sort(([a], [b]) => a - b).map(([, candidate]) => candidate),
          });
          return;
        }
        isSearchingRef.current = false;
        if (treeEvalAwaiterRef.current) {
          const { latestScore, resolve } = treeEvalAwaiterRef.current;
          treeEvalAwaiterRef.current = null;
          resolve(latestScore ?? null);
        }
        if (selectedEngineRef.current === 'stockfish' && engineRunningRef.current) setEngineStatus('done');
        tryStartPendingRef.current?.();
      }
    };

    worker.postMessage('uci');

    return () => {
      tryStartPendingRef.current = null;
      const suddenDeathAwaiter = suddenDeathAwaiterRef.current;
      if (suddenDeathAwaiter?.timeoutId !== null && suddenDeathAwaiter?.timeoutId !== undefined) {
        window.clearTimeout(suddenDeathAwaiter.timeoutId);
      }
      suddenDeathAwaiterRef.current = null;
      suddenDeathAwaiter?.resolve({ scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false });
      worker.terminate();
      stockfishRef.current = null;
      engineReadyRef.current = false;
      setStockfishLoaded(false);
      isSearchingRef.current = false;
      pendingAnalysisRef.current = null;
    };
  }, [stockfishGeneration]);

  useEffect(() => {
    if (playerAssessmentJobRef.current) return;
    if (selectedEngine === 'maia') {
      const worker = stockfishRef.current;
      pendingAnalysisRef.current = null;
      worker?.postMessage('stop');
      if (!engineRunning) {
        setEngineStatus('stopped');
        return;
      }

      const fen = maiaPositionFen;
      const requestId = maiaAnalysisRequestRef.current + 1;
      maiaAnalysisRequestRef.current = requestId;
      setEngineStatus('analyzing');
      setMaiaError('');
      setEngineLines([]);

      void (async () => {
        try {
          const maiaEval = await evaluateMaiaPosition({
            fen,
            eloSelf: maiaStrengthElo,
            eloOppo: maiaStrengthElo,
            topK: 256,
          });
          if (requestId !== maiaAnalysisRequestRef.current) return;
          const lines: EngineLine[] = maiaEval.moves.slice(0, Math.max(1, engineMultiPv)).map((entry, index) => ({
            multipv: index + 1,
            scoreText: `${(entry.probability * 100).toFixed(1)}%`,
            pv: entry.uci,
            bestMove: entry.uci,
            evalValue: entry.probability * 100000,
          }));
          setEngineLines(lines);
          setMaiaResultKey(`${fen}|${maiaStrengthElo}`);
          setEngineStatus('done');
        } catch (error) {
          if (requestId !== maiaAnalysisRequestRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          setMaiaError(message);
          setEngineStatus(`${MAIA_ENGINE_LABEL}: ${message}`);
          setEngineLines([]);
        }
      })();
      return () => {
        if (maiaAnalysisRequestRef.current === requestId) maiaAnalysisRequestRef.current += 1;
      };
    }

    if (!stockfishRef.current || !engineReadyRef.current) return;
    if (!engineRunning) {
      pendingAnalysisRef.current = null;
      stockfishRef.current.postMessage('stop');
      setEngineStatus('stopped');
      return;
    }

    const analysisId = currentAnalysisRef.current + 1;
    currentAnalysisRef.current = analysisId;
    pendingAnalysisRef.current = { fen: maiaPositionFen, depth: engineDepth, multipv: engineMultiPv,
      positionCommand: suddenDeathReviewCommand };
    tryStartPendingRef.current?.();
  }, [
    maiaPositionFen,
    suddenDeathReviewCommand,
    engineDepth,
    engineRunning,
    engineMultiPv,
    engineReadyTick,
    selectedEngine,
    maiaStrengthElo,
    playerAssessmentRunning,
  ]);

  useEffect(() => {
    lichessRateLimitedUntilRef.current = lichessRateLimitedUntil ?? 0;
  }, [lichessRateLimitedUntil]);

  useEffect(() => {
    if (!lichessRateLimitedUntil) return;
    const remainingMs = lichessRateLimitedUntil - Date.now();
    if (remainingMs <= 0) {
      setLichessRateLimitedUntil(null);
      if (lichessStatus === 'limited') setLichessStatus('idle');
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setLichessRateLimitedUntil(null);
      setLichessStatus((prev) => (prev === 'limited' ? 'idle' : prev));
    }, remainingMs + 50);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [lichessRateLimitedUntil, lichessStatus]);

  const registerLichessRateLimit = useCallback((retryAfterHeader: string | null) => {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? LICHESS_API_COOLDOWN_FALLBACK_MS;
    const nextUntil = Date.now() + Math.max(1000, retryAfterMs);
    lichessRateLimitedUntilRef.current = Math.max(lichessRateLimitedUntilRef.current, nextUntil);
    setLichessRateLimitedUntil((prev) => Math.max(prev ?? 0, nextUntil));
    setLichessApiIssueNote('');
    setLichessStatus('limited');
  }, [applyPersistedDatabaseState, applyPersistedSettingsState]);

  const waitForLichessRateSlot = useCallback(async (signal?: AbortSignal) => {
    let release!: () => void;
    const previous = lichessRequestQueueRef.current;
    lichessRequestQueueRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal?.throwIfAborted();
      const now = Date.now();
      if (now < lichessRateLimitedUntilRef.current) return false;
      const wait = Math.max(0, lichessNextRequestAtRef.current - now);
      if (wait > 0) await waitMs(wait);
      signal?.throwIfAborted();
      lichessNextRequestAtRef.current = Date.now() + LICHESS_API_MIN_INTERVAL_MS;
      return true;
    } finally {
      release();
    }
  }, []);

  const playerHistoryStats = savedPlayerHistory?.games.reduce((stats, game) => ({
    count: stats.count + 1,
    first: Math.min(stats.first, game.createdAt),
    last: Math.max(stats.last, game.createdAt),
  }), { count: 0, first: Number.POSITIVE_INFINITY, last: 0 });
  useEffect(() => {
    if (!hasHydratedAppState || !isLichessFilterOpen || lichessSource !== 'player' || !historyPlayer ||
      playerHistory?.player === historyPlayer) return;
    let cancelled = false;
    void idbGet<PlayerGameHistory>(`player-game-history-v1:${historyPlayer}`).then(data => {
      if (!cancelled && data) setPlayerHistory({ player: historyPlayer, data });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [hasHydratedAppState, historyPlayer, isLichessFilterOpen, lichessSource, playerHistory?.player]);
  useEffect(() => {
    const force = playerHistoryRefresh !== playerHistoryRefreshHandledRef.current;
    if (!hasHydratedAppState || !historyPlayer || (isLichessFilterOpen && !force)) {
      setPlayerHistorySyncing(false);
      setPlayerHistoryError('');
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const key = `player-game-history-v1:${historyPlayer}`;
    const positions = new Set<string>(JSON.parse(historyRepertoireKey));
    const publish = (data: PlayerGameHistory) => {
      if (signal.aborted) return;
      setPlayerHistory(previous => {
        if (previous?.player !== historyPlayer) return { player: historyPlayer, data };
        if (previous.data.syncedAt > data.syncedAt || (previous.data.syncedAt === data.syncedAt &&
          (playerHistoryIndexIsCurrent(previous.data, positions) || !playerHistoryIndexIsCurrent(data, positions)))) return previous;
        return { player: historyPlayer, data };
      });
    };
    const store = async (data: PlayerGameHistory) => {
      signal.throwIfAborted();
      let stored = data;
      await idbUpdate<PlayerGameHistory>(key, previous => {
        if (previous && (signal.aborted || previous.syncedAt > data.syncedAt)) stored = previous;
        return stored;
      });
      signal.throwIfAborted();
      publish(stored);
      return stored;
    };
    const sync = (force: boolean, maxAge = PLAYER_HISTORY_SYNC_INTERVAL_MS) => {
      if (signal.aborted || playerHistoryJobRef.current || findMissingControllerRef.current) return;
      let saved: PlayerGameHistory | null = null;
      let releaseHistory: (data: PlayerGameHistory | null) => void;
      const ready = new Promise<PlayerGameHistory | null>(resolve => { releaseHistory = resolve; });
      const job = { player: historyPlayer, ready };
      playerHistoryJobRef.current = job;
      const run = async () => {
        saved = await idbGet<PlayerGameHistory>(key);
        signal.throwIfAborted();
        if (saved) publish(saved);
        if (saved && !playerHistoryIndexIsCurrent(saved, positions)) {
          setPlayerHistorySyncing(true);
          setPlayerHistoryError('');
          saved = await store(await preprocessPlayerGameHistory(saved, positions, signal));
        }
        if (saved) releaseHistory(saved);
        if (!force && saved && Date.now() - saved.syncedAt < maxAge) return saved;
        setPlayerHistorySyncing(true);
        setPlayerHistoryError('');
        const latest = await syncPlayerGameHistory(historyPlayer, saved, signal, async (url, requestSignal) => {
          const allowed = await waitForLichessRateSlot(requestSignal);
          requestSignal.throwIfAborted();
          if (!allowed) throw new Error('Lichess rate limit. Try again later.');
          const headers = new Headers({ Accept: 'application/x-ndjson' });
          if (lichessApiToken.trim()) headers.set('Authorization', `Bearer ${lichessApiToken.trim()}`);
          const response = await fetch(url, { signal: requestSignal, headers });
          if (response.status === 429) registerLichessRateLimit(response.headers.get('Retry-After'));
          if (!response.ok) throw new Error(`Lichess game export failed (${response.status}).`);
          return response;
        });
        signal.throwIfAborted();
        const stored = await store(await preprocessPlayerGameHistory(latest, positions, signal, saved ?? latest));
        if (force || !saved || stored.games.length !== saved.games.length ||
          stored.games.some((game, i) => game.id !== saved?.games[i]?.id)) setExplorerRefresh(value => value + 1);
        return stored;
      };
      void run().catch(error => {
        if (!signal.aborted) setPlayerHistoryError(getErrorMessage(error, 'Could not sync Lichess games.'));
        return saved;
      }).then(releaseHistory!).finally(() => {
        if (playerHistoryJobRef.current === job) playerHistoryJobRef.current = null;
        if (!signal.aborted) {
          if (force) playerHistoryRefreshHandledRef.current = playerHistoryRefresh;
          setPlayerHistorySyncing(false);
        }
      });
    };
    setPlayerHistorySyncing(false);
    setPlayerHistoryError('');
    sync(force);
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync(false, PLAYER_HISTORY_SYNC_CHECK_MS);
    };
    const timer = isLichessFilterOpen ? undefined : window.setInterval(() => {
      if (document.visibilityState === 'visible') sync(false);
    }, PLAYER_HISTORY_SYNC_CHECK_MS);
    if (!isLichessFilterOpen) document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      if (playerHistoryJobRef.current?.player === historyPlayer) playerHistoryJobRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasHydratedAppState, historyPlayer, isLichessFilterOpen, lichessApiToken, playerHistoryRefresh,
    historyRepertoireKey, registerLichessRateLimit, waitForLichessRateSlot]);

  const ensureLichessResponseCacheLoaded = useCallback(async () => {
    if (lichessResponseCacheLoadedRef.current) return;
    if (lichessResponseCacheLoadPromiseRef.current) {
      await lichessResponseCacheLoadPromiseRef.current;
      return;
    }
    lichessResponseCacheLoadPromiseRef.current = (async () => {
      try {
        const raw = await idbGet<Record<string, LichessResponseCacheEntry>>(APP_LICHESS_RESPONSE_CACHE_KEY);
        const now = Date.now();
        const nextMap = new Map<string, LichessResponseCacheEntry>();
        if (raw && typeof raw === 'object') {
          for (const [url, entry] of Object.entries(raw)) {
            if (!entry || typeof entry !== 'object') continue;
            if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) continue;
            if (entry.expiresAt <= now && !isPlayerExplorerUrl(url)) continue;
            const data = (entry as LichessResponseCacheEntry).data;
            if (!data || typeof data !== 'object' || !Array.isArray(data.moves)) continue;
            const key = lichessCacheKey(url);
            if (!nextMap.has(key) || nextMap.get(key)!.expiresAt < entry.expiresAt) {
              nextMap.set(key, { expiresAt: entry.expiresAt, data });
            }
          }
        }
        lichessResponseCacheRef.current = nextMap;
      } catch {
        lichessResponseCacheRef.current = new Map();
      } finally {
        lichessResponseCacheLoadedRef.current = true;
      }
    })().finally(() => {
      lichessResponseCacheLoadPromiseRef.current = null;
    });
    await lichessResponseCacheLoadPromiseRef.current;
  }, []);

  const persistLichessResponseCache = useCallback(async () => {
    if (!lichessResponseCacheLoadedRef.current) return;
    const now = Date.now();
    const serialized: Record<string, LichessResponseCacheEntry> = {};
    for (const [url, entry] of lichessResponseCacheRef.current.entries()) {
      if (entry.expiresAt <= now && !isPlayerExplorerUrl(url)) continue;
      serialized[url] = entry;
    }
    await idbUpdate<Record<string, LichessResponseCacheEntry>>(APP_LICHESS_RESPONSE_CACHE_KEY, (saved = {}) => {
      const merged = { ...saved };
      for (const [url, entry] of Object.entries(serialized)) {
        if (!merged[url] || entry.expiresAt >= merged[url].expiresAt) merged[url] = entry;
      }
      for (const [url, entry] of Object.entries(merged)) {
        if (!Number.isFinite(entry?.expiresAt) || !Array.isArray(entry?.data?.moves) ||
          (entry.expiresAt <= now && !isPlayerExplorerUrl(url))) delete merged[url];
      }
      const playerEntries = Object.entries(merged).filter(([url]) => isPlayerExplorerUrl(url));
      playerEntries.sort(([, a], [, b]) => b.expiresAt - a.expiresAt);
      for (const [url] of playerEntries.slice(LICHESS_CACHE_PLAYER_LIMIT)) delete merged[url];
      return merged;
    }).catch(() => {
      // Keep cache write failures silent.
    });
  }, []);

  const getCachedLichessResponse = useCallback(
    async (url: string): Promise<LichessResponseCacheEntry | null> => {
      await ensureLichessResponseCacheLoaded();
      const now = Date.now();
      const key = lichessCacheKey(url);
      const cached = lichessResponseCacheRef.current.get(key);
      if (!cached) return null;
      if (cached.expiresAt <= now && !isPlayerExplorerUrl(url)) {
        lichessResponseCacheRef.current.delete(key);
        void persistLichessResponseCache();
        return null;
      }
      return cached;
    },
    [ensureLichessResponseCacheLoaded, persistLichessResponseCache],
  );

  const setCachedLichessResponse = useCallback(
    async (url: string, data: LichessResponse, isPlayer: boolean) => {
      await ensureLichessResponseCacheLoaded();
      const games = explorerGameCount(data);
      const baseTtl = isPlayer ? LICHESS_CACHE_PLAYER_TTL_MS
        : games >= 100_000 ? 90 * LICHESS_CACHE_DAY_MS
        : games >= 10_000 ? 30 * LICHESS_CACHE_DAY_MS : LICHESS_CACHE_DEFAULT_TTL_MS;
      const jitter = isPlayer ? LICHESS_CACHE_PLAYER_TTL_MS / 2
        : games >= 10_000 ? baseTtl / 2 : LICHESS_CACHE_DEFAULT_JITTER_MS;
      const ttlMs = baseTtl + Math.floor(Math.random() * (jitter + 1));
      const cache = lichessResponseCacheRef.current;
      cache.set(lichessCacheKey(url), {
        expiresAt: Date.now() + ttlMs,
        data,
      });
      if (isPlayer) {
        const entries = [...cache].filter(([key]) => isPlayerExplorerUrl(key));
        entries.sort(([, a], [, b]) => b.expiresAt - a.expiresAt);
        for (const [key] of entries.slice(LICHESS_CACHE_PLAYER_LIMIT)) cache.delete(key);
      }
      void persistLichessResponseCache();
    },
    [ensureLichessResponseCacheLoaded, persistLichessResponseCache],
  );

  const requestExplorer = useCallback(async (url: string, signal: AbortSignal,
    publish?: (snapshot: LichessResponse) => void, onChunk?: () => void) => {
    const allowed = await waitForLichessRateSlot(signal);
    signal.throwIfAborted();
    if (!allowed) throw new Error("Lichess rate limit. Try again later.");
    const token = lichessApiToken.trim();
    const response = await fetch(url, { signal, headers: token ? { Authorization: 'Bearer ' + token } : undefined });
    if (response.status === 429) registerLichessRateLimit(response.headers.get("Retry-After"));
    if (response.status === 401) setLichessAuthRequired(true);
    if (!response.ok) throw new Error('Lichess API error (' + response.status + ')');
    const received: { last: LichessResponse | null } = { last: null };
    await readExplorerResponse(response, snapshot => {
      signal.throwIfAborted();
      received.last = snapshot;
      publish?.(snapshot);
    }, onChunk);
    signal.throwIfAborted();
    const result = received.last;
    if (!result) throw new Error('Invalid Lichess response');
    const player = isPlayerExplorerUrl(url);
    if (player && (result.queuePosition ?? 0) > 0) throw new Error('Lichess is still indexing these games.');
    setLichessAuthRequired(false);
    await setCachedLichessResponse(url, result, player);
    return result;
  }, [lichessApiToken, registerLichessRateLimit, setCachedLichessResponse, waitForLichessRateSlot]);

  const mistakeReviewOpen = mistakeReview !== null;
  const opponentReviewOpen = opponentReview !== null;
  const showingOpponentResult = opponentFindingOnBoard !== null;
  useEffect(() => {
    const controller = new AbortController();
    const isPlayer = lichessSource === 'player';
    const skip = (isPlayer && !playerHandle.trim()) || trainingSession?.side === activeSide;
    if (skip) { setLichessStatus('idle'); return; }
    if (isFindMissingSearchRunning || mistakeReviewOpen || opponentReviewOpen || (isPlayer && playerHistorySyncing)) return;
    let disposed = false;
    let timedOut = false;
    let idle: number | undefined;
    let shown: LichessResponse | null = null;
    const publish = (data: LichessResponse, status: string) => {
      shown = data;
      setLichessData(data);
      setLichessDataFen(explorerFen);
      setLichessDataRequestKey(explorerRequestKey);
      setLichessStatus(status);
    };
    const stopForTimeout = () => { timedOut = true; controller.abort(); };
    const resetIdle = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(stopForTimeout, 20_000);
    };
    const run = async () => {
      const cached = await getCachedLichessResponse(explorerUrl);
      if (disposed) return;
      setLichessApiIssueNote("");
      const forceRefresh = explorerRefresh !== explorerRefreshHandledRef.current;
      explorerRefreshHandledRef.current = explorerRefresh;
      if (cached) {
        const fresh = !forceRefresh && cached.expiresAt > Date.now();
        publish(cached.data, fresh ? 'done' : 'refreshing');
        if (fresh) return;
      } else {
        setLichessData(null);
        setLichessDataFen(null);
        setLichessStatus('loading');
      }
      if (Date.now() < lichessRateLimitedUntilRef.current) {
        setLichessStatus(cached ? 'cached' : 'limited');
        return;
      }
      const timeout = window.setTimeout(stopForTimeout, 120_000);
      resetIdle();
      try {
        const final = await requestExplorer(explorerUrl, controller.signal, data => {
          if (!cached) publish(data, isPlayer ? 'indexing' : 'loading');
        }, resetIdle);
        if (!disposed) publish(final, 'done');
      } catch (error) {
        if (disposed) return;
        setLichessApiIssueNote(timedOut ? "Lichess took too long. Retry to continue." : getErrorMessage(error, "Lichess request failed."));
        setLichessStatus(shown ? cached ? 'cached' : 'partial' : Date.now() < lichessRateLimitedUntilRef.current ? 'limited' : 'error');
      } finally {
        window.clearTimeout(timeout);
        window.clearTimeout(idle);
      }
    };
    // The cache is local, so show it before the navigation debounce expires.
    void getCachedLichessResponse(explorerUrl).then(cached => {
      if (!disposed && cached) publish(cached.data, cached.expiresAt > Date.now() ? 'done' : 'refreshing');
    });
    const timeout = window.setTimeout(() => { void run(); }, 280);
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      window.clearTimeout(idle);
      controller.abort();
    };
  }, [activeSide, explorerFen, explorerRequestKey, explorerUrl, getCachedLichessResponse, isFindMissingSearchRunning, mistakeReviewOpen,
    opponentReviewOpen, playerHistorySyncing,
    lichessRateLimitedUntil, lichessSource, playerHandle, requestExplorer, trainingSession?.side, explorerRefresh]);

  useEffect(() => {
    if (findMissingSearchAutoNavigationRef.current) {
      findMissingSearchAutoNavigationRef.current = false;
      return;
    }
    findMissingControllerRef.current?.abort();
    setPlayerSearchNote('');
    setOpponentReview(null);
  }, [selectedNode.id, activeSide, activeRepertoireId, getExplorerUrl]);

  useEffect(() => {
    setMistakeReview(null);
    setOpponentReview(null);
  }, [repertoireReviewNodes, activeRepertoireId, getExplorerUrl, lichessApiToken, trainingSession]);

  useEffect(() => () => findMissingControllerRef.current?.abort(),
    [activeSide, activeRepertoireId, repertoireReviewNodes, getExplorerUrl, lichessApiToken, trainingSession]);


  const fetchLichessNodeData = async (fen: string, signal: AbortSignal): Promise<LichessResponse | null> => {
    if (lichessSource === 'player' && !playerHandle.trim()) return null;
    const url = getExplorerUrl(fen);
    const cached = await getCachedLichessResponse(url);
    if (cached || signal.aborted) return cached?.data ?? null;
    try {
      return await requestExplorer(url, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
    } catch {
      return null;
    }
  };

  const playerSearchQuery = (signal: AbortSignal) => {
    let networkRequests = 0;
    return async (fen: string) => {
      const url = getExplorerUrl(fen);
      const cached = await getCachedLichessResponse(url);
      signal.throwIfAborted();
      if (cached && cached.expiresAt > Date.now()) return cached.data;
      if (networkRequests >= 6) throw new Error('Search paused after six requests. Run it again to continue.');
      networkRequests++;
      try {
        return await requestExplorer(url, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
      } catch (error) {
        signal.throwIfAborted();
        if (cached) return cached.data;
        throw new Error(error instanceof DOMException && error.name === 'TimeoutError'
          ? 'Lichess timed out. Run the search again to retry.' : getErrorMessage(error, 'Explorer data unavailable.'));
      }
    };
  };

  const queryMistakeExplorer = useCallback(async (fen: string, signal: AbortSignal, dates: ExplorerDates = {}) => {
    const url = getExplorerUrl(fen, dates, 'player');
    const cached = await getCachedLichessResponse(url);
    signal.throwIfAborted();
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    return requestExplorer(url, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  }, [getExplorerUrl, getCachedLichessResponse, requestExplorer]);

  const historyIndexRef = useRef<{
    history: PlayerGameHistory;
    nodes: typeof repertoireReviewNodes;
    includeReplies: boolean;
    side: Side;
    speeds: string[];
    modes: string[];
    query: Awaited<ReturnType<typeof indexPlayerGameHistory>>;
  } | null>(null);
  useEffect(() => {
    if (historyIndexRef.current?.history !== savedPlayerHistory) historyIndexRef.current = null;
  }, [savedPlayerHistory]);
  const preparePersonalReviewQuery = async (signal: AbortSignal, includeReplies = false) => {
    let history = savedPlayerHistory;
    const positions = new Set(repertoireReviewNodes.map(({ node }) => bookPositionFenKey(node.fen)));
    const job = playerHistoryJobRef.current;
    if (job?.player === historyPlayer && (!history || (!includeReplies && !playerHistoryCovers(history, positions)))) {
      let onAbort: () => void = () => {};
      const cancelled = new Promise<null>(resolve => {
        onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        signal.throwIfAborted();
        history = await Promise.race([job.ready, cancelled]) ?? history;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    signal.throwIfAborted();
    if (!history) return { fromHistory: false, query: (fen: string, dates?: ExplorerDates) => queryMistakeExplorer(fen, signal, dates) };
    const preprocessed = !includeReplies && playerHistoryCovers(history, positions);
    const cached = historyIndexRef.current;
    const index = cached?.history === history && cached.nodes === repertoireReviewNodes && cached.side === activeSide &&
      cached.includeReplies === includeReplies &&
      cached.speeds === playerSpeeds && cached.modes === selectedModes
      ? cached.query
      : await indexPlayerGameHistory(history, positions, activeSide, playerSpeeds, selectedModes, signal, includeReplies);
    signal.throwIfAborted();
    historyIndexRef.current = preprocessed ? null : {
      history, nodes: repertoireReviewNodes, includeReplies, side: activeSide, speeds: playerSpeeds, modes: selectedModes, query: index,
    };
    return {
      fromHistory: true,
      query: async (fen: string, dates?: ExplorerDates): Promise<LichessResponse> => {
        signal.throwIfAborted();
        return index(bookPositionFenKey(fen), dates);
      },
    };
  };

  useEffect(() => {
    setMistakeDateLookupFailed(false);
    if (!reviewPosition || reviewPosition.fromHistory || !reviewPositionOnBoard || isFindMissingSearchRunning) return;
    const missing = reviewPosition.moves.filter(move => !move.lastMonth && move.recent + move.earlier > 0);
    if (!missing.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    const fetchMonths = async () => {
      const now = new Date();
      const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
      const recentSince = monthNumber(reviewPosition.recentSince);
      const countsBySince = new Map<number, Set<string>>();
      for (const move of missing) {
        // Query the original position: counting the resulting position would include other move orders.
        let lower = Math.max(monthNumber(reviewPosition.sinceMonth), move.recent ? recentSince : 0);
        let upper = move.recent ? currentMonth : recentSince - 1;
        while (lower < upper) {
          const mid = Math.floor((lower + upper + 1) / 2);
          let played = countsBySince.get(mid);
          if (!played) {
            const data = await queryMistakeExplorer(reviewPosition.node.fen, signal, { since: monthKey(mid) });
            played = new Set(playerExplorerMoves(reviewPosition.node.fen, data.moves)
              .filter(entry => explorerGameCount(entry) > 0).map(entry => entry.uci));
            countsBySince.set(mid, played);
          }
          if (played.has(move.uci)) lower = mid;
          else upper = mid - 1;
        }
        signal.throwIfAborted();
        moveMonths.set(move.uci, monthKey(lower));
      }
    };
    const moveMonths = new Map<string, string>();
    void fetchMonths().catch(() => {
      if (!signal.aborted) setMistakeDateLookupFailed(true);
    }).finally(() => {
      if (signal.aborted || !moveMonths.size) return;
      setMistakeReview(prev => prev && ({
        ...prev,
        positions: prev.positions.map(position => position === reviewPosition ? ({
          ...position,
          moves: position.moves.map(move => ({ ...move, lastMonth: move.lastMonth ?? moveMonths.get(move.uci) })),
        }) : position),
      }));
    });
    return () => controller.abort();
  }, [reviewPosition, reviewPositionOnBoard, isFindMissingSearchRunning, queryMistakeExplorer]);

  const clearTrainingHint = () => {
    setTrainingSession((prev) =>
      prev ? { ...prev, hintRequested: false, hintVisible: false, hintMoveUci: null } : prev,
    );
  };

  const getScopeIdsForTrainingPosition = (side: Side, fen: string) => {
    const fenKey = positionFenKey(fen);
    const repertoireScopeIds = enabledRepertoiresBySide[side]
      .filter((repertoire) => repertoireHasMoves(repertoire.tree))
      .filter((repertoire) =>
        Object.values(repertoire.tree.nodes).some((node) => positionFenKey(node.fen) === fenKey),
      )
      .map((repertoire) => `repo:${repertoire.id}`);
    return [TRAINING_SCOPE_WHOLE_DB, ...repertoireScopeIds];
  };

  const appendTrainingAnswer = (
    side: Side,
    fen: string,
    scopeIds: string[],
    answer: 0 | 1,
  ) => {
    if (scopeIds.length === 0) return;
    const fenKey = positionFenKey(fen);
    const uniqueScopeIds = Array.from(new Set(scopeIds));
    setTrainingStatsBySide((prev) => {
      const sideStats = prev[side];
      let sideChanged = false;
      const nextSideStats: Record<string, Record<string, TrainingPositionStat>> = { ...sideStats };

      uniqueScopeIds.forEach((scopeId) => {
        const scopeStats = nextSideStats[scopeId] ?? {};
        const current = scopeStats[fenKey] ?? { recentAnswers: [] };
        const nextRecentAnswers = [...current.recentAnswers, answer].slice(-trainingStatsQueueLength);
        const unchanged =
          nextRecentAnswers.length === current.recentAnswers.length &&
          nextRecentAnswers.every((value, index) => value === current.recentAnswers[index]);
        if (unchanged) return;
        sideChanged = true;
        nextSideStats[scopeId] = {
          ...scopeStats,
          [fenKey]: {
            recentAnswers: nextRecentAnswers,
          },
        };
      });

      if (!sideChanged) return prev;
      return {
        ...prev,
        [side]: nextSideStats,
      };
    });
  };

  const runStockfishSingleQuery = useCallback(async (params: {
    fen: string;
    depth: number;
    perspectiveSide: Side;
    multipv?: number;
    movetimeMs?: number;
    limitStrengthElo?: number | null;
    engineChoice?: EngineChoice;
    maiaElo?: number;
    positionCommand?: string;
    searchMoves?: readonly string[];
    preserveInteractiveLines?: boolean;
    signal?: AbortSignal;
    onInfo?: (scoreText: string) => void;
  }): Promise<StockfishEvaluationResult> => {
    const {
      fen,
      depth,
      perspectiveSide,
      multipv = 1,
      movetimeMs,
      limitStrengthElo = null,
      engineChoice,
      maiaElo,
      positionCommand,
      searchMoves,
      preserveInteractiveLines,
      signal,
      onInfo,
    } = params;
    const effectiveEngine: EngineChoice = engineChoice ?? selectedEngineRef.current;
    const isMaia = effectiveEngine === 'maia';
    if (isMaia) {
      try {
        const effectiveMaiaElo = clampInt(maiaElo, MAIA_STRENGTH_ELO_MIN, MAIA_STRENGTH_ELO_MAX, maiaStrengthEloRef.current);
        const maiaEval = await evaluateMaiaPosition({
          fen,
          eloSelf: effectiveMaiaElo,
          eloOppo: effectiveMaiaElo,
          topK: Math.max(1, multipv),
        });
        const perspectiveMultiplier = perspectiveSide === 'white' ? 1 : -1;
        const evalCp = winProbabilityToCp(maiaEval.winProbability) * perspectiveMultiplier;
        return {
          scoreText: formatSignedCp(evalCp),
          evalCp,
          bestMove: maiaEval.moves[0]?.uci ?? null,
          pv: maiaEval.moves[0]?.uci ?? '',
          depth: 0,
          nodes: 0,
          hasScore: maiaEval.moves.length > 0,
        };
      } catch {
        return { scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false };
      }
    }

    while (suddenDeathBusyRef.current) {
      signal?.throwIfAborted();
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    signal?.throwIfAborted();
    suddenDeathBusyRef.current = true;
    let stopOnAbort: (() => void) | undefined;

    try {
      const worker = stockfishRef.current;
      if (!worker || !engineReadyRef.current) {
        return { scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false };
      }
      const effectiveMultiPv = Math.max(1, multipv);
      const effectiveElo = limitStrengthElo;

      pendingAnalysisRef.current = null;
      worker.postMessage('stop');
      // Drain the interactive search before a new awaiter can own its bestmove.
      for (let attempt = 0; attempt < 100 && isSearchingRef.current && stockfishRef.current === worker; attempt++) {
        signal?.throwIfAborted();
        await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      signal?.throwIfAborted();
      if (isSearchingRef.current || stockfishRef.current !== worker || !engineReadyRef.current) {
        return { scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false };
      }
      lineCacheRef.current = new Map();
      if (!preserveInteractiveLines) setEngineLines([]);

      const whitePerspectiveMultiplier = whitePerspectiveMultiplierFromFen(fen);
      const sidePerspectiveMultiplier = perspectiveSide === 'white' ? 1 : -1;
      const perspectiveMultiplier = whitePerspectiveMultiplier * sidePerspectiveMultiplier;
      engineWhitePerspectiveMultiplierRef.current = perspectiveMultiplier;

      const result = await new Promise<StockfishEvaluationResult>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          const awaiter = suddenDeathAwaiterRef.current;
          if (!awaiter) {
            resolve({ scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false });
            return;
          }
          // Keep ownership until bestmove arrives: otherwise a late response
          // could resolve the next position's query.
          worker.postMessage('stop');
          awaiter.timeoutId = window.setTimeout(() => {
            if (suddenDeathAwaiterRef.current !== awaiter) return;
            suddenDeathAwaiterRef.current = null;
            engineReadyRef.current = false;
            setStockfishLoaded(false);
            worker.terminate();
            if (stockfishRef.current === worker) stockfishRef.current = null;
            resolve({ scoreText: '?', evalCp: 0, bestMove: null, pv: '', depth: 0, nodes: 0, hasScore: false });
          }, 2000);
        }, Math.max(12000, (movetimeMs ?? 0) + 5000));

        suddenDeathAwaiterRef.current = {
          perspectiveMultiplier,
          latestEvalCp: 0,
          latestScoreText: '?',
          latestPv: '',
          latestDepth: 0,
          latestNodes: 0,
          latestScoreIsBound: false,
          latestWdl: null,
          wdlMultiplier: perspectiveMultiplier,
          candidateLayers: new Map(),
          requiredCandidates: Math.min(effectiveMultiPv, searchMoves?.length ?? new Chess(fen).moves().length),
          onInfo,
          timeoutId,
          resolve,
        };
        const query = suddenDeathAwaiterRef.current;
        stopOnAbort = () => {
          if (suddenDeathAwaiterRef.current === query) worker.postMessage('stop');
        };
        signal?.addEventListener('abort', stopOnAbort, { once: true });

        worker.postMessage('setoption name UCI_ShowWDL value true');
        worker.postMessage(`setoption name MultiPV value ${effectiveMultiPv}`);
        if (effectiveElo !== null) {
          worker.postMessage('setoption name UCI_LimitStrength value true');
          worker.postMessage(`setoption name UCI_Elo value ${effectiveElo}`);
        } else {
          worker.postMessage('setoption name UCI_LimitStrength value false');
        }
        worker.postMessage(positionCommand ?? `position fen ${fen}`);
        const limit = typeof movetimeMs === 'number' && Number.isFinite(movetimeMs) && movetimeMs > 0
          ? `movetime ${Math.floor(movetimeMs)}` : `depth ${Math.max(8, depth)}`;
        worker.postMessage(`go ${limit}${searchMoves?.length ? ` searchmoves ${searchMoves.join(' ')}` : ''}`);
      });

      signal?.throwIfAborted();
      return result;
    } finally {
      if (stopOnAbort) signal?.removeEventListener('abort', stopOnAbort);
      suddenDeathBusyRef.current = false;
      tryStartPendingRef.current?.();
    }
  }, []);

  useEffect(() => {
    if (!showMixedEngines || !engineRunning || !stockfishLoaded || engineStatus !== 'done' ||
      maiaResultKey !== currentMaiaKey || !engineLines.length || isGameReviewRunning ||
      isTreeEvalRunning || playerAssessmentRunning || trainingSession || exampleReplay) return;
    const controller = new AbortController();
    const { signal } = controller;
    const maiaMoves = engineLines.map(line => line.bestMove);
    const query = (multipv: number, movetimeMs: number, searchMoves?: readonly string[]) => runStockfishSingleQuery({
      fen: maiaPositionFen, depth: engineDepth, perspectiveSide: 'white', engineChoice: 'stockfish',
      multipv, movetimeMs, searchMoves, preserveInteractiveLines: true, signal, positionCommand: suddenDeathReviewCommand,
    });
    const compare = async () => {
      let top: CandidateEvaluation[] = [];
      setMaiaStockfishComparison({ key: maiaComparisonKey, scores: new Map(), stockfishMoves: [], alternatives: [], pending: true });
      try {
        top = (await query(engineMultiPv, 300)).candidates ?? [];
        if (!top.length) throw new Error('Stockfish returned no candidate moves.');
        if (!signal.aborted) {
          setMaiaStockfishComparison({ key: maiaComparisonKey, scores: new Map(), stockfishMoves: top, alternatives: [], pending: true });
        }
        const stockfishMoves = new Set(top.map(candidate => candidate.uci));
        const union = [...new Set([...stockfishMoves, ...maiaMoves])];
        // A common root search scores both sets at the same depth.
        const compared = union.length === stockfishMoves.size ? top
          : (await query(union.length, 400 + 70 * union.length, union)).candidates ?? [];
        const scores = new Map(compared.map(candidate => [candidate.uci, candidate]));
        const side = toTurnColor(maiaPositionFen);
        const maiaRanks = maiaMoves.flatMap(uci => {
          const candidate = scores.get(uci);
          return candidate ? [stockfishRank(candidate, side)] : [];
        });
        const weakestMaia = maiaRanks.length === maiaMoves.length ? Math.min(...maiaRanks) : Infinity;
        const maiaSet = new Set(maiaMoves);
        const alternatives = compared.filter(candidate => stockfishMoves.has(candidate.uci) &&
          !maiaSet.has(candidate.uci) && stockfishRank(candidate, side) > weakestMaia);
        if (!signal.aborted) {
          setMaiaStockfishComparison({ key: maiaComparisonKey, scores, stockfishMoves: top, alternatives, pending: false });
        }
      } catch {
        if (!signal.aborted) {
          setMaiaStockfishComparison({ key: maiaComparisonKey, scores: new Map(), stockfishMoves: top, alternatives: [], pending: false });
        }
      }
    };
    const timer = window.setTimeout(() => void compare(), 100);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [showMixedEngines, engineRunning, stockfishLoaded, engineStatus, maiaResultKey, currentMaiaKey, engineLines,
    isGameReviewRunning, isTreeEvalRunning, playerAssessmentRunning, trainingSession, exampleReplay, maiaPositionFen,
    engineDepth, engineMultiPv, maiaComparisonKey, suddenDeathReviewCommand, runStockfishSingleQuery]);

  const withPlayerEngine = async <T,>(controller: AbortController, run: () => Promise<T>) => {
    playerAssessmentJobRef.current = controller;
    const wasRunning = engineRunningRef.current;
    engineRunningRef.current = false;
    setPlayerAssessmentRunning(true);
    const stop = () => stockfishRef.current?.postMessage('stop');
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      return await run();
    } finally {
      controller.signal.removeEventListener('abort', stop);
      playerAssessmentJobRef.current = null;
      engineRunningRef.current = wasRunning;
      setPlayerAssessmentRunning(false);
    }
  };

  const assessPlayerPosition = async (fen: string, moves: ReadonlyMap<string, number>, signal: AbortSignal,
    reuse: boolean, saveNoticeKey?: string) => {
    const key = playerAssessmentKey(playerHandle, activeSide, bookPositionFenKey(fen));
    const previous = playerAssessments[key];
    const pending = [...moves].filter(([uci]) => !reuse || !previous?.moves[uci]);
    const observed = { ...previous?.observed };
    for (const [uci, count] of moves) {
      if (count > (observed[uci] ?? 0)) observed[uci] = count;
    }
    if (!pending.length && previous) {
      if ([...moves.keys()].every(uci => observed[uci] === previous.observed[uci])) return previous;
      const updated = { ...previous, observed };
      setPlayerAssessments(prev => ({ ...prev, [key]: updated }));
      await savePlayerAssessment(key, updated).catch(() => {});
      return updated;
    }
    const evaluate = async (movetimeMs: number, searchMove?: string) => {
      signal.throwIfAborted();
      const result = await runStockfishSingleQuery({
        fen: fullBoardFen(fen), depth: engineDepth, perspectiveSide: activeSide, movetimeMs,
        searchMoves: searchMove ? [searchMove] : undefined, engineChoice: 'stockfish', signal,
      });
      signal.throwIfAborted();
      return result;
    };
    const best = await evaluate(180);
    if (!best.hasScore) throw new Error('Stockfish could not score this position.');
    let refinedBest: StockfishEvaluationResult | undefined;
    const assessment: PlayerAssessment = {
      best, moves: { ...previous?.moves }, observed,
    };
    for (const [uci] of pending) {
      const quick = best.bestMove === uci ? best : await evaluate(180, uci);
      if (!quick.hasScore) continue;
      const initialLoss = playerPositionLoss(best, quick);
      let score = quick.scoreText;
      let confirmedLoss = initialLoss;
      const contradicts = (a: StockfishEvaluationResult, b: StockfishEvaluationResult) =>
        (playerPositionLoss(b, a) ?? 0) > 1;
      if (initialLoss === null || initialLoss >= 4 || contradicts(best, quick)) {
        refinedBest ??= await evaluate(480);
        const played = refinedBest.bestMove === uci ? refinedBest : await evaluate(480, uci);
        const refinedLoss = refinedBest.hasScore && played.hasScore ? playerPositionLoss(refinedBest, played) : null;
        if (refinedBest.hasScore) assessment.best = refinedBest;
        if (played.hasScore) score = played.scoreText;
        confirmedLoss = refinedLoss !== null && initialLoss !== null && !contradicts(refinedBest, played) &&
          [5, PLAYER_MISTAKE_LOSS].every(threshold => (initialLoss >= threshold) === (refinedLoss >= threshold))
          ? refinedLoss : null;
      }
      assessment.moves[uci] = { score, confirmedLoss };
    }
    signal.throwIfAborted();
    if (!Object.keys(assessment.moves).length) throw new Error('Stockfish could not score these moves.');
    setPlayerAssessments(prev => ({ ...prev, [key]: assessment }));
    await savePlayerAssessment(key, assessment).catch(() => {
      if (saveNoticeKey) setPlayerAssessmentNotice({ key: saveNoticeKey, message: 'Could not save the Stockfish results locally.' });
    });
    return assessment;
  };

  const assessPlayerMoves = async (moves: ReadonlyMap<string, number>) => {
    if (playerAssessmentJobRef.current) {
      playerAssessmentJobRef.current.abort();
      return;
    }
    if (!hasHydratedAppState || !stockfishLoaded || analysisGameProgress || isTreeEvalRunning ||
      trainingSession || suddenDeathGameOver || isExampleReplayActive || findMissingControllerRef.current || !moves.size ||
      toTurnColor(selectedBoardFen) !== activeSide) return;
    const controller = new AbortController();
    setPlayerAssessmentNotice(null);
    try {
      await withPlayerEngine(controller, () =>
        assessPlayerPosition(selectedBoardFen, moves, controller.signal, false, playerReviewKey));
    } catch (error) {
      if (!controller.signal.aborted) setPlayerAssessmentNotice({
        key: playerReviewKey, message: getErrorMessage(error, 'Could not evaluate moves.'),
      });
    }
  };

  const analyzeCurrentGame = async (deep = false) => {
    if (!isBrowseMode || isTrainingActive || isSuddenDeathActive || suddenDeathGameOver || isExampleReplayActive || isTreeEvalRunning || playerAssessmentJobRef.current) return;
    if (analysisGameProgress) {
      analysisGameCancelRef.current = true;
      analysisReviewAbortRef.current?.abort();
      cancelMaiaEvaluations();
      stockfishRef.current?.postMessage('stop');
      return;
    }

    const analysisTree = trees[activeSide];
    const originalNodeId = selectedNode.id;
    const gamePath = buildMainLinePath(analysisTree);
    if (gamePath.length < 2) return;
    const bookMoves = findBookMovesForGame(gamePath, bookRepertoireIndex);
    const analysisMaiaElo = analysisBenchmarkElo;
    const ratingMetadata = { white: analysisContext.whiteRating, black: analysisContext.blackRating };
    const bookResults: GameAnalysisMoveResult[] = gamePath.slice(1).flatMap((node, index) => {
      const source = bookMoves.get(node.id);
      if (!source) return [];
      const beforeNode = gamePath[index];
      const mover: Side = fenToChess(beforeNode.fen).turn() === 'w' ? 'white' : 'black';
      return [{
        nodeId: node.id,
        moveNumber: Number.parseInt(beforeNode.fen.split(' ')[5] || '1', 10),
        moveSan: node.moveSan ?? node.moveUci ?? '',
        mover,
        bestMoveUci: null,
        bestScoreText: null,
        playedScoreText: null,
        bestScoreCp: null,
        playedScoreCp: null,
        bestPv: '',
        playedPv: '',
        terminalOutcome: null,
        depth: 0,
        nodes: 0,
        lossPoints: null,
        category: 'book',
        status: 'book',
        bookRepertoireName: source.repertoireName,
      }];
    });
    const analysisSide = activeSide;
    const gameKey = gamePath.map((node) => `${node.id}:${node.moveUci ?? ''}:${node.fen}`).join('|');
    const bookMoveCount = bookResults.length;
    const initialReport: GameAnalysisReport = {
      version: 2,
      gameKey,
      sourceId: activeRepertoireIdBySide[analysisSide] ?? `browse:${analysisSide}`,
      rootNodeId: analysisTree.rootId,
      rootFen: gamePath[0].fen,
      side: analysisSide,
      createdAt: Date.now(),
      engine: STOCKFISH_ENGINE_NAME,
      maiaEngine: MAIA_ENGINE_LABEL,
      reviewMode: deep ? 'deep' : 'quick',
      maiaElo: analysisMaiaElo,
      playerRatings: ratingMetadata ? { white: ratingMetadata.white, black: ratingMetadata.black } : undefined,
      depth: engineDepth,
      status: 'running',
      results: deep ? [] : bookResults,
    };
    analysisGameCancelRef.current = false;
    const reviewAbort = new AbortController();
    analysisReviewAbortRef.current = reviewAbort;
    setGameAnalysisReport(initialReport);
    setShowAnalysisReport(false);
    setAnalysisMaiaNotice(null);
    setAnalysisGameProgress({
      done: 0,
      total: gamePath.length - 1,
      moveText: 'Preparing analysis',
      phase: 'best',
      liveScoreText: null,
    });
    setPortraitTab('moves');
    setEngineRunning(false);
    engineRunningRef.current = false;
    pendingAnalysisRef.current = null;
    stockfishRef.current?.postMessage('stop');
    const releaseStockfishForMaia = async () => {
      setAnalysisGameProgress((prev) => prev ? { ...prev, detail: 'Zamykanie Stockfish i zwalnianie pamięci przed Maia-3…' } : prev);
      const worker = stockfishRef.current;
      if (worker) {
        worker.postMessage('stop');
        worker.terminate();
        stockfishRef.current = null;
      }
      engineReadyRef.current = false;
      setStockfishLoaded(false);
      isSearchingRef.current = false;
      pendingAnalysisRef.current = null;
      lineCacheRef.current.clear();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    };

    try {
      if (!deep && bookMoveCount === gamePath.length - 1) {
        setGameAnalysisReport({ ...initialReport, status: 'complete' });
        setShowAnalysisReport(true);
        return;
      }
      if (!stockfishRef.current) {
        setStockfishGeneration((value) => value + 1);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      if (!engineReadyRef.current) {
        for (let attempt = 0; attempt < 200 && !engineReadyRef.current; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      }
      // Wait for any interactive search stopped above to send its final bestmove.
      for (let attempt = 0; attempt < 100 && isSearchingRef.current; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      if (isSearchingRef.current) throw new Error('Stockfish did not stop its previous search');
      if (!engineReadyRef.current || !stockfishRef.current) throw new Error('Stockfish is unavailable');

      const reviewResults = await runGameReview({ path: gamePath, bookResults, deep, depth: engineDepth, benchmark: analysisMaiaElo,
        ratings: ratingMetadata, ratingSystem: analysisContext.ratingSystem, ratingPool: analysisContext.ratingPool,
        ratingSource: analysisContextSource,
        explorerToken: lichessApiToken,
        releaseStockfish: releaseStockfishForMaia,
        prepareAlternatives: async () => {
          cancelMaiaEvaluations();
          setMaiaLoaded(false);
          setAnalysisGameProgress(prev => prev ? { ...prev, detail: 'SF19: sprawdzanie ruchów wskazanych przez Maię…' } : prev);
          setStockfishGeneration(value => value + 1);
          for (let attempt = 0; attempt < 200 && !engineReadyRef.current && !analysisGameCancelRef.current; attempt++) {
            await new Promise(resolve => window.setTimeout(resolve, 50));
          }
          if (!analysisGameCancelRef.current && (!engineReadyRef.current || !stockfishRef.current)) throw new Error('Stockfish is unavailable for checking human alternatives');
        },
        query: runStockfishSingleQuery, cancelled: () => analysisGameCancelRef.current,
        signal: reviewAbort.signal,
        publish: (results) => setGameAnalysisReport(prev => prev?.gameKey === gameKey ? { ...prev, results: [...results] } : prev),
        progress: (value, nodeId) => {
          if (analysisGameCancelRef.current) return;
          analysisCurrentBoardNodeRef.current = nodeId;
          setSelectedNodeBySide(prev => ({ ...prev, [analysisSide]: nodeId }));
          setAnalysisGameProgress(value);
        },
      });
      const wasCancelled = analysisGameCancelRef.current;
      if (!wasCancelled) {
        const maiaUnavailable = reviewResults.filter((result) => result.maiaStatus === 'unavailable');
        if (maiaUnavailable.length > 0) {
          setAnalysisMaiaNotice({ kind: 'error', text: `Maia-3 nie została użyta: ${maiaUnavailable[0].maiaUnavailableReason ?? 'model nie zwrócił wyniku'}` });
        } else {
          setAnalysisMaiaNotice(null);
        }
      }
      setGameAnalysisReport((prev) => prev?.gameKey === gameKey
        ? { ...prev, status: wasCancelled ? 'cancelled' : 'complete' }
        : prev);
      if (!wasCancelled) setShowAnalysisReport(true);
    } catch (error) {
      setAnalysisMaiaNotice({ kind: 'error', text: `Analiza nie została ukończona: ${error instanceof Error ? error.message : String(error)}` });
      setGameAnalysisReport((prev) => prev?.gameKey === gameKey ? { ...prev, status: 'error' } : prev);
      setShowAnalysisReport(true);
    } finally {
      reviewAbort.abort();
      if (analysisReviewAbortRef.current === reviewAbort) analysisReviewAbortRef.current = null;
      setSelectedNodeBySide((prev) => prev[analysisSide] === analysisCurrentBoardNodeRef.current
        ? { ...prev, [analysisSide]: originalNodeId }
        : prev);
      analysisCurrentBoardNodeRef.current = null;
      setAnalysisGameProgress(null);
    }
  };

  const getScopeSuccessRate = (side: Side, scopeId: string, fen: string) => {
    const recentAnswers = trainingStatsBySide[side]?.[scopeId]?.[positionFenKey(fen)]?.recentAnswers ?? [];
    if (recentAnswers.length === 0) return 0;
    const correct = recentAnswers.reduce((acc, value) => acc + (value ? 1 : 0), 0);
    return (correct / recentAnswers.length) * 100;
  };

  const flashcardWeight = (side: Side, scopeId: string, fen: string) => {
    const base = Math.max(1, 101 - getScopeSuccessRate(side, scopeId, fen));
    const position = bookPositionFenKey(fen);
    const assessment = playerAssessments[playerAssessmentKey(playerHandle, side, position)];
    if (!assessment) return base;
    const ids = scopeId === TRAINING_SCOPE_WHOLE_DB
      ? enabledRepertoiresBySide[side].map(entry => entry.id) : [scopeId.slice('repo:'.length)];
    const repertoireMoves = new Set(bookRepertoireIndex.flatMap(entry =>
      ids.includes(entry.id) ? [...(entry.movesByFen.get(position) ?? [])] : []));
    const answers = trainingStatsBySide[side]?.[scopeId]?.[positionFenKey(fen)]?.recentAnswers ?? [];
    return base + playerTrainingBonus(assessment, repertoireMoves, answers);
  };

  const collectBrowseChildFenKeys = (side: Side, fen: string) => {
    const targetFenKey = positionFenKey(fen);
    const childFenKeys = new Set<string>();
    for (const repertoire of enabledRepertoiresBySide[side]) {
      const matchingNodes = Object.values(repertoire.tree.nodes).filter((node) => positionFenKey(node.fen) === targetFenKey);
      for (const node of matchingNodes) {
        for (const childId of node.children) {
          const child = repertoire.tree.nodes[childId];
          if (child) childFenKeys.add(positionFenKey(child.fen));
        }
      }
    }
    return childFenKeys;
  };

  const ensureBrowsePromptNode = (fen: string, baseTree: MoveTree) => {
    const fenKey = positionFenKey(fen);
    const existingNode = Object.values(baseTree.nodes).find((node) => positionFenKey(node.fen) === fenKey);
    if (existingNode) {
      return { tree: baseTree, nodeId: existingNode.id };
    }
    const root = baseTree.nodes[baseTree.rootId];
    if (!root) return { tree: baseTree, nodeId: baseTree.rootId };
    const nodeId = createNodeId(baseTree);
    const nextTree: MoveTree = {
      ...baseTree,
      nextId: baseTree.nextId + 1,
      nodes: {
        ...baseTree.nodes,
        [nodeId]: {
          id: nodeId,
          parentId: root.id,
          fen,
          moveSan: null,
          moveUci: null,
          children: [],
        },
        [root.id]: {
          ...root,
          children: [...root.children, nodeId],
        },
      },
    };
    return { tree: nextTree, nodeId };
  };

  const advanceFlashcardPosition = (side: Side, rootNodeId: string, sourceTreeOverride?: MoveTree) => {
    const baseTree = sourceTreeOverride ?? trees[side];
    const rootNode = baseTree.nodes[rootNodeId];
    if (!rootNode) return;
    const scopeId = getActiveTrainingStatsScopeId(side);

    if (!isBrowseMode) {
      const candidateNodes: MoveNode[] = [];
      const stack = [rootNode.id];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const nodeId = stack.pop() as string;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        const node = baseTree.nodes[nodeId];
        if (!node) continue;
        const ownTurn = toTurnColor(node.fen) === side;
        const children = trainingMoveIds(baseTree, node, ownTurn, trainAlternativeMoves);
        if (ownTurn && children.length > 0) {
          candidateNodes.push(node);
        }
        for (const childId of children) stack.push(childId);
      }
      if (candidateNodes.length === 0) return;
      const preferred = candidateNodes.filter((node) => node.parentId !== selectedNode.id);
      const pool = preferred.length > 0 ? preferred : candidateNodes;
      const weights = pool.map(node => flashcardWeight(side, scopeId, node.fen));
      const pickedIndex = weightedPickIndex(weights);
      if (pickedIndex < 0) return;
      const pickedNode = pool[pickedIndex];
      setSelectedNodeBySide((prev) => ({ ...prev, [side]: pickedNode.id }));
      clearTrainingHint();
      setTrainingSession((prev) =>
        prev && prev.side === side && prev.rootNodeId === rootNodeId
          ? {
              ...prev,
              currentPromptFen: pickedNode.fen,
              currentPromptHadError: false,
              currentPromptScopeIds: getScopeIdsForTrainingPosition(side, pickedNode.fen),
            }
          : prev,
      );
      return;
    }

    const rootFenKey = positionFenKey(rootNode.fen);
    const candidateByFen = new Map<string, string>();
    for (const repertoire of enabledRepertoiresBySide[side]) {
      const matchingRoots = Object.values(repertoire.tree.nodes).filter((node) => positionFenKey(node.fen) === rootFenKey);
      for (const repoRoot of matchingRoots) {
        const stack = [repoRoot.id];
        const visited = new Set<string>();
        while (stack.length > 0) {
          const nodeId = stack.pop() as string;
          if (visited.has(nodeId)) continue;
          visited.add(nodeId);
          const node = repertoire.tree.nodes[nodeId];
          if (!node) continue;
          const ownTurn = toTurnColor(node.fen) === side;
          const children = trainingMoveIds(repertoire.tree, node, ownTurn, trainAlternativeMoves);
          if (ownTurn && children.length > 0) {
            const fenKey = positionFenKey(node.fen);
            if (!candidateByFen.has(fenKey)) candidateByFen.set(fenKey, node.fen);
          }
          for (const childId of children) stack.push(childId);
        }
      }
    }
    if (candidateByFen.size === 0) return;
    const childFenKeys = collectBrowseChildFenKeys(side, selectedNode.fen);
    const candidateFens = [...candidateByFen.values()];
    const preferred = candidateFens.filter((fen) => !childFenKeys.has(positionFenKey(fen)));
    const pool = preferred.length > 0 ? preferred : candidateFens;
    const weights = pool.map(fen => flashcardWeight(side, scopeId, fen));
    const pickedIndex = weightedPickIndex(weights);
    if (pickedIndex < 0) return;
    const pickedFen = pool[pickedIndex];
    const ensured = ensureBrowsePromptNode(pickedFen, baseTree);
    if (ensured.tree !== baseTree) {
      setTrees((prev) => ({ ...prev, [side]: ensured.tree }));
    }
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: ensured.nodeId }));
    clearTrainingHint();
    setTrainingSession((prev) =>
      prev && prev.side === side && prev.rootNodeId === rootNodeId
        ? {
            ...prev,
            currentPromptFen: pickedFen,
            currentPromptHadError: false,
            currentPromptScopeIds: getScopeIdsForTrainingPosition(side, pickedFen),
          }
        : prev,
    );
  };

  const recordSuddenDeathMove = (round: SuddenDeathRound, move: Move, prefix: string) => {
    const squares: [Key, Key] = [move.from, move.to];
    const fen = round.chess.fen();
    round.positions.push({ fen, move: { uci: uciFromMove(move), label: `${prefix} ${toFigurineSan(move.san)}`, squares } });
    setSuddenDeathCurrentFen(fen);
    setSuddenDeathLastMove(squares);
  };

  const querySuddenDeathPosition = (round: SuddenDeathRound, opponent = false) => runStockfishSingleQuery({
    fen: round.chess.fen(),
    positionCommand: suddenDeathPositionCommand(round.positions),
    depth: opponent ? Math.max(10, Math.min(18, engineDepth)) : engineDepth,
    perspectiveSide: 'white',
    movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
    limitStrengthElo: opponent && suddenDeathEngine === 'stockfish' ? suddenDeathStockfishElo : null,
    engineChoice: opponent ? suddenDeathEngine : 'stockfish',
    maiaElo: suddenDeathMaiaElo,
  });

  const evaluateSuddenDeathPosition = async (round: SuddenDeathRound) => {
    const position = round.positions[round.positions.length - 1];
    if (round.chess.isGameOver()) {
      position.terminal = round.chess.isCheckmate()
        ? (round.chess.turn() === 'b' ? '1–0 · Checkmate' : '0–1 · Checkmate')
        : '½–½ · Draw';
      return null;
    }
    const evaluation = await querySuddenDeathPosition(round);
    position.evaluation = evaluation;
    return evaluation;
  };

  const playSuddenDeathReply = async (round: SuddenDeathRound) => {
    const reply = await querySuddenDeathPosition(round, true);
    if (suddenDeathRoundRef.current !== round || !reply.bestMove) return;
    const input = uciToMoveInput(reply.bestMove);
    if (!input || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(reply.bestMove)) return;
    const prefix = formatMovePrefix(round.chess);
    recordSuddenDeathMove(round, round.chess.move(input), prefix);
  };

  const reviewSuddenDeathRound = (round: SuddenDeathRound, side: Side, reason: SuddenDeathGameOverState['reason']) => {
    setSuddenDeathGameOver({ side, startNodeId: round.startNodeId, positions: round.positions, index: round.positions.length - 1, reason });
    setTrainingSession(null);
    setHoveredEngineMove(null);
    setPortraitTab('moves');
  };

  const startSuddenDeathRound = async (session: TrainingSession, sourceTreeOverride?: MoveTree) => {
    const side = session.side;
    const sideTree = sourceTreeOverride ?? trees[side];
    const fixedStartNodeId = sideTree.nodes[session.entryNodeId]
      ? session.entryNodeId
      : sideTree.nodes[session.rootNodeId]
        ? session.rootNodeId
        : sideTree.rootId;
    const fixedStartNode = sideTree.nodes[fixedStartNodeId];
    if (!fixedStartNode) return;
    const chess = fenToChess(fixedStartNode.fen);
    const fixedStartFen = chess.fen();
    const round: SuddenDeathRound = { startNodeId: fixedStartNodeId, chess, positions: [{ fen: fixedStartFen }] };
    suddenDeathRoundRef.current = round;
    setExampleReplay(null);
    setAnalysisScratchPosition(null);
    setHoveredEngineMove(null);
    setSuddenDeathStartNodeId(fixedStartNodeId);
    setSuddenDeathCurrentFen(fixedStartFen);
    setSuddenDeathLastMove(null);
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: fixedStartNodeId }));

    setSuddenDeathThinking(true);
    try {
      const baseEval = await evaluateSuddenDeathPosition(round);
      if (suddenDeathRoundRef.current !== round) return;
      if (!chess.isGameOver() && toTurnColor(fixedStartFen) !== side) await playSuddenDeathReply(round);
      if (suddenDeathRoundRef.current !== round) return;

      const promptFen = chess.fen();
      const promptEval = promptFen === fixedStartFen ? baseEval : await evaluateSuddenDeathPosition(round);
      if (suddenDeathRoundRef.current !== round) return;
      if (chess.isGameOver()) {
        reviewSuddenDeathRound(round, side, 'terminal');
        return;
      }
      if (toTurnColor(promptFen) !== side) {
        reviewSuddenDeathRound(round, side, 'unavailable');
        return;
      }
      const userPerspectiveMultiplier = side === 'white' ? 1 : -1;
      setTrainingSession((prev) =>
        prev && prev.side === side && prev.suddenDeathMode
          ? {
              ...prev,
              currentPromptFen: promptFen,
              suddenDeathBaseEvalCp: promptEval?.hasScore ? promptEval.evalCp * userPerspectiveMultiplier : null,
              currentPromptHadError: false,
              currentPromptScopeIds: getScopeIdsForTrainingPosition(side, promptFen),
              hintRequested: false,
              hintVisible: false,
              hintMoveUci: null,
            }
          : prev,
      );
    } finally {
      if (suddenDeathRoundRef.current === round) setSuddenDeathThinking(false);
    }
  };

  const advanceTrainingPosition = (
    side: Side,
    rootNodeId: string,
    startNodeId: string,
    sourceTreeOverride?: MoveTree,
  ) => {
    const baseTree = sourceTreeOverride ?? trees[side];
    let sideTree = baseTree;
    const rootNode = sideTree.nodes[rootNodeId];
    if (!rootNode) return;

    let cursorId = startNodeId;
    const maxSteps = 256;
    for (let step = 0; step < maxSteps; step += 1) {
      const cursor = sideTree.nodes[cursorId] ?? rootNode;
      const turnColor = toTurnColor(cursor.fen);
      if (turnColor === side) break;

      if (isBrowseMode) {
        const options = collectMergedMoveOptionsAtFen(side, cursor.fen);
        if (options.length === 0) break;
        const randomOption = options[Math.floor(Math.random() * options.length)];
        const moveUci = randomOption.moveUci;
        const existingChildId = cursor.children.find((id) => sideTree.nodes[id]?.moveUci === moveUci);
        if (existingChildId) {
          cursorId = existingChildId;
          continue;
        }
        const chess = fenToChess(cursor.fen);
        const promotionChar = (moveUci[4] ?? 'q').toLowerCase();
        const promotion: 'q' | 'r' | 'b' | 'n' = ['q', 'r', 'b', 'n'].includes(promotionChar)
          ? (promotionChar as 'q' | 'r' | 'b' | 'n')
          : 'q';
        const move = chess.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion });
        if (!move) break;
        const nodeId = createNodeId(sideTree);
        const newNode: MoveNode = {
          id: nodeId,
          parentId: cursor.id,
          fen: chess.fen(),
          moveSan: move.san,
          moveUci,
          children: [],
        };
        sideTree = {
          ...sideTree,
          nextId: sideTree.nextId + 1,
          nodes: {
            ...sideTree.nodes,
            [nodeId]: newNode,
            [cursor.id]: {
              ...cursor,
              children: [...cursor.children, nodeId],
            },
          },
        };
        cursorId = nodeId;
        continue;
      }

      if (cursor.children.length === 0) break;
      const randomChildId = cursor.children[Math.floor(Math.random() * cursor.children.length)];
      cursorId = randomChildId;
    }

    if (sideTree !== baseTree) {
      setTrees((prev) => ({ ...prev, [side]: sideTree }));
    }
    const promptNode = sideTree.nodes[cursorId] ?? rootNode;
    const promptTurnMatches = toTurnColor(promptNode.fen) === side;
    const hasPrompt = promptTurnMatches && (isBrowseMode
      ? collectMergedMoveOptionsAtFen(side, promptNode.fen, trainAlternativeMoves).length > 0
      : trainingMoveIds(sideTree, promptNode, true, trainAlternativeMoves).length > 0);
    if (hasPrompt) {
      const scopeIds = getScopeIdsForTrainingPosition(side, promptNode.fen);
      setTrainingSession((prev) =>
        prev && prev.side === side && prev.rootNodeId === rootNodeId
          ? {
              ...prev,
              currentPromptFen: promptNode.fen,
              currentPromptHadError: false,
              currentPromptScopeIds: scopeIds,
            }
          : prev,
      );
    } else {
      setTrainingSession((prev) =>
        prev && prev.side === side && prev.rootNodeId === rootNodeId
          ? {
              ...prev,
              currentPromptFen: null,
              currentPromptHadError: false,
              currentPromptScopeIds: [],
            }
          : prev,
      );
    }
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: cursorId }));
    clearTrainingHint();
  };

  const restoreSuddenDeathStartPosition = (side: Side, startNodeId: string | null) => {
    const sideTree = trees[side];
    const restoreNodeId = startNodeId && sideTree.nodes[startNodeId] ? startNodeId : sideTree.rootId;
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: restoreNodeId }));
  };

  const clearSuddenDeathRuntime = () => {
    suddenDeathRoundRef.current = null;
    setSuddenDeathThinking(false);
    setSuddenDeathStartNodeId(null);
    setSuddenDeathCurrentFen(null);
    setSuddenDeathLastMove(null);
  };

  const finishSuddenDeathReview = () => {
    if (!suddenDeathGameOver) return;
    restoreSuddenDeathStartPosition(suddenDeathGameOver.side, suddenDeathGameOver.startNodeId);
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
    setHoveredEngineMove(null);
    setAnalysisScratchPosition(null);
    setEngineLines([]);
    setPortraitTab('moves');
  };

  const selectSuddenDeathPosition = (index: number) => {
    setHoveredEngineMove(null);
    setSuddenDeathGameOver((review) => review && ({
      ...review, index: Math.max(0, Math.min(index, review.positions.length - 1)),
    }));
  };

  const startTraining = () => {
    if (suddenDeathGameOver || playerAssessmentJobRef.current) return;
    const side = activeSide;
    if (!hasSideTrainingContent(side)) {
      setStatus('No lines to train on this side.');
      return;
    }
    const entryNodeId = selectedNode.id;
    const excludedMoveIndex = isBrowseMode ? -1 : path.findIndex((node, index) => {
      if (!index) return false;
      const parent = path[index - 1];
      return toTurnColor(parent.fen) === side && !trainingMoveIds(tree, parent, true, trainAlternativeMoves).includes(node.id);
    });
    const rootNodeId = excludedMoveIndex > 0 ? path[excludedMoveIndex - 1].id : entryNodeId;
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
    setTrainingSession({
      side,
      rootNodeId,
      entryNodeId,
      flashcardMode: false,
      suddenDeathMode: false,
      suddenDeathBaseEvalCp: null,
      hintRequested: false,
      hintVisible: false,
      hintMoveUci: null,
      completedLeafNodeIds: [],
      errorCount: 0,
      correctCount: 0,
      currentPromptFen: null,
      currentPromptHadError: false,
      currentPromptScopeIds: [],
    });
    advanceTrainingPosition(side, rootNodeId, rootNodeId);
    setPortraitTab('moves');
  };

  const startSuddenDeathTraining = () => {
    const side = activeSide;
    const rootNodeId = selectedNode.id;
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
    const nextSession: TrainingSession = {
      side,
      rootNodeId,
      entryNodeId: rootNodeId,
      flashcardMode: false,
      suddenDeathMode: true,
      suddenDeathBaseEvalCp: null,
      hintRequested: false,
      hintVisible: false,
      hintMoveUci: null,
      completedLeafNodeIds: [],
      errorCount: 0,
      correctCount: 0,
      currentPromptFen: null,
      currentPromptHadError: false,
      currentPromptScopeIds: [],
    };
    setTrainingSession(nextSession);
    void startSuddenDeathRound(nextSession);
    setPortraitTab('moves');
  };

  const toggleSuddenDeathMode = () => {
    if (suddenDeathGameOver || playerAssessmentJobRef.current) return;
    if (!trainingSession) {
      startSuddenDeathTraining();
      return;
    }
    if (trainingSession.suddenDeathMode) {
      stopTraining();
      return;
    }
    const side = trainingSession.side;
    const startNodeId = selectedNode.id;
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
    setTrainingSession((prev) =>
      prev && prev.side === side
        ? {
            ...prev,
            rootNodeId: startNodeId,
            entryNodeId: startNodeId,
            suddenDeathMode: true,
            flashcardMode: false,
            suddenDeathBaseEvalCp: null,
            hintRequested: false,
            hintVisible: false,
            hintMoveUci: null,
            currentPromptHadError: false,
          }
        : prev,
    );
    void startSuddenDeathRound({
      ...trainingSession,
      rootNodeId: startNodeId,
      entryNodeId: startNodeId,
      suddenDeathMode: true,
      flashcardMode: false,
      suddenDeathBaseEvalCp: null,
    });
  };

  const stopTraining = () => {
    if (trainingSession) {
      if (trainingSession.suddenDeathMode) {
        restoreSuddenDeathStartPosition(trainingSession.side, suddenDeathStartNodeId ?? trainingSession.entryNodeId);
      } else {
        const sideTree = trees[trainingSession.side];
        const restoreNodeId = sideTree.nodes[trainingSession.entryNodeId] ? trainingSession.entryNodeId : sideTree.rootId;
        setSelectedNodeBySide((prev) => ({ ...prev, [trainingSession.side]: restoreNodeId }));
      }
    }
    setTrainingSession(null);
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
  };

  const restartTrainingLine = () => {
    if (!trainingSession) return;
    clearTrainingHint();
    advanceTrainingPosition(trainingSession.side, trainingSession.rootNodeId, trainingSession.rootNodeId);
  };

  const toggleFlashcardMode = () => {
    if (!trainingSession) return;
    const nextFlashcardMode = !trainingSession.flashcardMode;
    const side = trainingSession.side;
    const rootNodeId = trainingSession.rootNodeId;
    setTrainingSession((prev) =>
      prev && prev.side === side
        ? {
            ...prev,
            flashcardMode: nextFlashcardMode,
            suddenDeathMode: false,
            suddenDeathBaseEvalCp: null,
            hintRequested: false,
            hintVisible: false,
            hintMoveUci: null,
            currentPromptHadError: false,
          }
        : prev,
    );
    if (nextFlashcardMode) {
      advanceFlashcardPosition(side, rootNodeId);
    } else {
      advanceTrainingPosition(side, rootNodeId, rootNodeId);
    }
  };

  const getActiveTrainingStatsScopeId = (side: Side) =>
    isBrowseMode || !activeRepertoireIdBySide[side] ? TRAINING_SCOPE_WHOLE_DB : `repo:${activeRepertoireIdBySide[side]}`;

  const getTrainingLeafKey = (node: MoveNode) => {
    if (isBrowseMode) return `fen:${positionFenKey(node.fen)}`;
    return `node:${node.id}`;
  };

  const clearActiveTrainingStatistics = () => {
    const scopeId = getActiveTrainingStatsScopeId(activeSide);
    const confirmed = window.confirm('Clear training statistics for current scope?');
    if (!confirmed) return;
    setTrainingStatsBySide((prev) => {
      const sideStats = prev[activeSide];
      if (!sideStats[scopeId]) return prev;
      const nextSideStats = { ...sideStats };
      delete nextSideStats[scopeId];
      return {
        ...prev,
        [activeSide]: nextSideStats,
      };
    });
    setTrainingLeafLastShownBySide((prev) => {
      const sideEntries = prev[activeSide];
      if (!sideEntries[scopeId]) return prev;
      const nextSideEntries = { ...sideEntries };
      delete nextSideEntries[scopeId];
      return {
        ...prev,
        [activeSide]: nextSideEntries,
      };
    });
  };

  const clearAllTrainingStatistics = () => {
    const confirmed = window.confirm('Clear all training statistics?');
    if (!confirmed) return;
    setTrainingStatsBySide(createEmptyTrainingStatsState());
    setTrainingLeafLastShownBySide(createEmptyTrainingLeafLastShownState());
  };

  useEffect(() => {
    if (!trainingSession) return;
    if (repertoireSide !== trainingSession.side) {
      if (trainingSession.suddenDeathMode) clearSuddenDeathRuntime();
      setTrainingSession(null);
      return;
    }
    if (!trainingSession.suddenDeathMode && !hasSideTrainingContent(trainingSession.side)) {
      setTrainingSession(null);
      setSuddenDeathGameOver(null);
      return;
    }
    if (!trees[trainingSession.side].nodes[trainingSession.rootNodeId]) {
      if (trainingSession.suddenDeathMode) clearSuddenDeathRuntime();
      setTrainingSession(null);
    }
  }, [repertoireSide, trainingSession, trees, hasSideTrainingContent]);

  const openEnginePreview = (position: Pick<AnalysisScratchPosition, 'fen' | 'lastMove'>) => {
    setAnalysisScratchPosition((previous) => ({
      fen: position.fen,
      lastMove: position.lastMove,
      enginePreview: { previous, origin: previous?.enginePreview ? previous.enginePreview.origin : previous },
    }));
  };

  const makeMove = (orig: Key, dest: Key, promotion: 'q' | 'r' | 'b' | 'n' = 'q') => {
    if (suddenDeathGameOver || (exampleReplay && exampleReplay.side === activeSide)) return;
    const round = isSuddenDeathActive ? suddenDeathRoundRef.current : null;
    if (isSuddenDeathActive && (!round || suddenDeathThinking || toTurnColor(round.chess.fen()) !== activeSide)) return;
    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
    if (isReadOnlyRepertoire && !currentNode.children.some(id =>
      currentTree.nodes[id]?.moveUci === `${orig}${dest}${promotion === 'q' ? '' : promotion}` ||
      currentTree.nodes[id]?.moveUci === `${orig}${dest}${promotion}`)) return;
    const reviewBoard = Boolean(reviewPositionOnBoard || opponentFindingOnBoard);
    const moveSourceFen = round?.chess.fen() ?? ((analysisScratchPosition || reviewBoard) && !isTrainingActive
      ? selectedBoardFen
      : currentNode.fen);
    const chess = round?.chess ?? fenToChess(moveSourceFen);
    const movePrefix = round ? formatMovePrefix(chess) : '';
    const move = chess.move({ from: orig, to: dest, promotion });

    if (!move) return;

    if (!engineRunning) {
      const followsStockfishLine = selectedEngine === 'stockfish' && engineLines.some(line => {
        let previousFen = stockfishLinesFen;
        for (const candidate of buildEnginePvMoves(stockfishLinesFen, line.pv)) {
          if (positionFenKey(previousFen) === positionFenKey(moveSourceFen) &&
              positionFenKey(candidate.fen) === positionFenKey(chess.fen())) return true;
          previousFen = candidate.fen;
        }
        return false;
      });
      if (!followsStockfishLine) {
        setEngineLines([]);
        lineCacheRef.current = new Map();
      }
    }

    // Engine-line previews stay separate from the move list. Review moves use
    // the working tree below; without an active repertoire it is not persisted.
    if (!round && !isTrainingActive && (analysisScratchPosition || reviewBoard)) {
      if (analysisScratchPosition?.enginePreview) {
        openEnginePreview({ fen: chess.fen(), lastMove: [move.from as Key, move.to as Key] });
        return;
      }
      setAnalysisScratchPosition({
        fen: chess.fen(),
        lastMove: [move.from as Key, move.to as Key],
        playerMoves: analysisScratchPosition?.playerMoves || reviewBoard
          ? [...(analysisScratchPosition?.playerMoves ?? []), uciFromMove(move)] : undefined,
      });
      return;
    }

    if (isBrowseMode && !isTrainingActive && !round) {
      const uci = uciFromMove(move);
      const matchingChildId = currentNode.children.find((id) => currentTree.nodes[id]?.moveUci === uci);
      const existingChildId = currentNode.children[0] === matchingChildId ? matchingChildId : undefined;
      let nextTree = currentTree;
      let nextNodeId = existingChildId;
      if (!existingChildId) {
        // Replacing a continuation discards everything after this position.
        for (const childId of [...currentNode.children]) nextTree = removeBranch(nextTree, childId);
        const nodeId = createNodeId(nextTree);
        const nextParent = nextTree.nodes[currentNode.id];
        const newNode: MoveNode = {
          id: nodeId,
          parentId: currentNode.id,
          fen: chess.fen(),
          moveSan: move.san,
          moveUci: uci,
          children: [],
        };
        nextTree = {
          ...nextTree,
          nextId: nextTree.nextId + 1,
          nodes: {
            ...nextTree.nodes,
            [nodeId]: newNode,
            [currentNode.id]: { ...nextParent, children: [nodeId] },
          },
        };
        nextNodeId = nodeId;
      }
      if (!nextNodeId || nextNodeId === currentSelectedId) return;
      if (analysisGameProgress) {
        analysisGameCancelRef.current = true;
      cancelMaiaEvaluations();
        stockfishRef.current?.postMessage('stop');
      }
      setUndoStackBySide((prev) => ({
        ...prev,
        [activeSide]: [...prev[activeSide], { tree: currentTree, selectedNodeId: currentSelectedId }].slice(-200),
      }));
      setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
      setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: nextNodeId as string }));
      setAnalysisScratchPosition(null);
      setGameAnalysisReport(null);
      void idbSet(APP_GAME_ANALYSIS_REPORT_KEY, null).catch(() => setStatus('Game analysis save failed'));
      setShowAnalysisReport(false);
      return;
    }

    const uci = uciFromMove(move);
    const existingChildId = currentNode.children.find((id) => currentTree.nodes[id].moveUci === uci);

    if (trainingSession && trainingSession.side === activeSide) {
      if (round) {
        recordSuddenDeathMove(round, move, movePrefix);
        const promptFen = moveSourceFen;
        const baseEvalCp = trainingSession.suddenDeathBaseEvalCp;
        const promptScopeIds = trainingSession.currentPromptScopeIds.length > 0
          ? trainingSession.currentPromptScopeIds
          : getScopeIdsForTrainingPosition(activeSide, promptFen);
        const thresholdCp = Math.round(suddenDeathThreshold * 100);
        const userPerspective = activeSide === 'white' ? 1 : -1;
        const exceedsDrop = (evaluation: StockfishEvaluationResult) =>
          evaluation.hasScore && baseEvalCp !== null && evaluation.evalCp * userPerspective <= baseEvalCp - thresholdCp;
        const finishPosition = (evaluation: StockfishEvaluationResult | null) => {
          const terminal = evaluation === null;
          const lost = terminal ? round.chess.isCheckmate() && toTurnColor(round.chess.fen()) === activeSide
            : exceedsDrop(evaluation);
          if (!lost && !terminal) return false;
          appendTrainingAnswer(activeSide, promptFen, promptScopeIds, lost ? 0 : 1);
          reviewSuddenDeathRound(round, activeSide, terminal ? 'terminal' : 'drop');
          return true;
        };

        setSuddenDeathThinking(true);
        void (async () => {
          try {
            const postUserEval = await evaluateSuddenDeathPosition(round);
            if (suddenDeathRoundRef.current !== round || finishPosition(postUserEval)) return;

            const userFen = round.chess.fen();
            await playSuddenDeathReply(round);
            if (suddenDeathRoundRef.current !== round) return;
            const replyFen = round.chess.fen();
            if (replyFen === userFen) {
              reviewSuddenDeathRound(round, activeSide, 'unavailable');
              return;
            }

            const replyEval = await evaluateSuddenDeathPosition(round);
            if (suddenDeathRoundRef.current !== round || finishPosition(replyEval)) return;

            appendTrainingAnswer(activeSide, promptFen, promptScopeIds, 1);
            setTrainingSession((prev) =>
              prev && prev.side === activeSide && prev.suddenDeathMode
                ? {
                    ...prev,
                    correctCount: prev.correctCount + 1,
                    currentPromptFen: replyFen,
                    currentPromptScopeIds: getScopeIdsForTrainingPosition(activeSide, replyFen),
                    currentPromptHadError: false,
                  }
                : prev,
            );
          } finally {
            if (suddenDeathRoundRef.current === round) setSuddenDeathThinking(false);
          }
        })();
        return;
      }

      if (toTurnColor(currentNode.fen) !== activeSide) return;
      const trainingOptions = isBrowseMode
        ? collectMergedMoveOptionsAtFen(activeSide, currentNode.fen, trainAlternativeMoves).map((option) => option.moveUci)
        : trainingMoveIds(currentTree, currentNode, true, trainAlternativeMoves)
            .map((childId) => currentTree.nodes[childId].moveUci!);
      if (trainingOptions.length === 0) return;

      const isAllowedMove = trainingOptions.includes(uci);
      if (trainingSession.flashcardMode) {
        const scoredFen = trainingSession.currentPromptFen ?? currentNode.fen;
        const scoredScopeIds =
          trainingSession.currentPromptScopeIds.length > 0
            ? trainingSession.currentPromptScopeIds
            : getScopeIdsForTrainingPosition(activeSide, scoredFen);
        if (!isAllowedMove) {
          if (!trainingSession.currentPromptHadError) {
            appendTrainingAnswer(activeSide, scoredFen, scoredScopeIds, 0);
          }
          const hintMoveUci = trainingOptions[Math.floor(Math.random() * trainingOptions.length)] ?? null;
          setTrainingSession((prev) =>
            prev && prev.side === activeSide
              ? {
                  ...prev,
                  hintRequested: true,
                  hintVisible: prev.hintVisible,
                  hintMoveUci,
                  errorCount: prev.errorCount + 1,
                  currentPromptHadError: true,
                }
              : prev,
          );
          return;
        }
        if (!trainingSession.currentPromptHadError) {
          appendTrainingAnswer(activeSide, scoredFen, scoredScopeIds, 1);
        }
        setTrainingSession((prev) =>
          prev && prev.side === activeSide
            ? {
                ...prev,
                hintRequested: false,
                hintVisible: false,
                hintMoveUci: null,
                correctCount: prev.correctCount + 1,
                currentPromptHadError: false,
              }
            : prev,
        );
        advanceFlashcardPosition(activeSide, trainingSession.rootNodeId, currentTree);
        return;
      }

      if (!isAllowedMove) {
        if (!trainingSession.currentPromptHadError) {
          const scoredFen = trainingSession.currentPromptFen ?? currentNode.fen;
          const scoredScopeIds =
            trainingSession.currentPromptScopeIds.length > 0
              ? trainingSession.currentPromptScopeIds
              : getScopeIdsForTrainingPosition(activeSide, scoredFen);
          appendTrainingAnswer(activeSide, scoredFen, scoredScopeIds, 0);
        }
        const hintMoveUci = trainingOptions[Math.floor(Math.random() * trainingOptions.length)] ?? null;
        setTrainingSession((prev) =>
          prev && prev.side === activeSide
            ? {
              ...prev,
              hintRequested: true,
              hintVisible: false,
              hintMoveUci,
              errorCount: prev.errorCount + 1,
              currentPromptHadError: true,
            }
          : prev,
      );
        return;
      }

      const scoredFen = trainingSession.currentPromptFen ?? currentNode.fen;
      const scoredScopeIds =
        trainingSession.currentPromptScopeIds.length > 0
          ? trainingSession.currentPromptScopeIds
          : getScopeIdsForTrainingPosition(activeSide, scoredFen);
      if (!trainingSession.currentPromptHadError) {
        appendTrainingAnswer(activeSide, scoredFen, scoredScopeIds, 1);
      }
      setTrainingSession((prev) =>
        prev && prev.side === activeSide
          ? {
              ...prev,
              correctCount: prev.correctCount + 1,
            }
          : prev,
      );

      let nextTreeForTraining = currentTree;
      let nextNodeIdForTraining = existingChildId;
      if (!nextNodeIdForTraining) {
        const nodeId = createNodeId(currentTree);
        const newNode: MoveNode = {
          id: nodeId,
          parentId: currentNode.id,
          fen: chess.fen(),
          moveSan: move.san,
          moveUci: uci,
          children: [],
        };
        nextTreeForTraining = {
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
        nextNodeIdForTraining = nodeId;
        setTrees((prev) => ({
          ...prev,
          [activeSide]: nextTreeForTraining,
        }));
      }

      clearTrainingHint();
      if (nextNodeIdForTraining) {
        advanceTrainingPosition(activeSide, trainingSession.rootNodeId, nextNodeIdForTraining, nextTreeForTraining);
      }
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

  const playSuggestedMove = (uci: string) => {
    if (isTrainingActive || isSuddenDeathActive || suddenDeathGameOver) return;
    const keyPair = parseUciMove(uci);
    if (!keyPair) return;
    const promotionChar = (uci[4] ?? 'q').toLowerCase();
    const promotion: 'q' | 'r' | 'b' | 'n' = ['q', 'r', 'b', 'n'].includes(promotionChar)
      ? (promotionChar as 'q' | 'r' | 'b' | 'n')
      : 'q';
    makeMove(keyPair[0], keyPair[1], promotion);
  };

  const playPlayerMove = (uci: string) => {
    if (trainingSession || suddenDeathGameOver || isExampleReplayActive || isTreeEvalRunning || isReadOnlyRepertoire) return;
    const chess = fenToChess(selectedBoardFen);
    try {
      const move = chess.move(uci);
      setPlayerSearchNote('');
      const preview = analysisScratchPosition?.playerMoves;
      setAnalysisScratchPosition({
        fen: chess.fen(), lastMove: [move.from as Key, move.to as Key],
        playerMoves: !analysisScratchPosition || preview ? [...(preview ?? []), uciFromMove(move)] : undefined,
      });
    } catch {
      // An explorer row can become stale while the board is changing.
    }
  };

  const backPlayerPreview = () => {
    const moves = analysisScratchPosition?.playerMoves?.slice(0, -1);
    if (!moves?.length) {
      setAnalysisScratchPosition(null);
      return;
    }
    const chess = fenToChess(browseMistakePosition?.node.fen ?? browseOpponentPosition?.fen ?? selectedNode.fen);
    for (const uci of moves) chess.move(uci);
    setAnalysisScratchPosition({ fen: chess.fen(), lastMove: parseUciMove(moves.at(-1) ?? null) ?? null, playerMoves: moves });
  };

  const savePlayerLine = () => {
    const moves = analysisScratchPosition?.playerMoves;
    if (!moves?.length || isBrowseMode || trainingSession || isTreeEvalRunning) return;
    const chess = fenToChess(selectedNode.fen);
    const next = { ...tree, nodes: { ...tree.nodes } };
    let nodeId = selectedNode.id;
    for (const uci of moves) nodeId = ensureChildNode(next, nodeId, chess.move(uci), chess);
    setUndoStackBySide(prev => ({
      ...prev, [activeSide]: [...prev[activeSide], { tree, selectedNodeId: selectedNode.id }].slice(-200),
    }));
    setTrees(prev => ({ ...prev, [activeSide]: next }));
    setSelectedNodeBySide(prev => ({ ...prev, [activeSide]: nodeId }));
    setAnalysisScratchPosition(null);
  };

  const previewEnginePvMove = (rootFen: string, pv: string, moveIndex: number) => {
    const move = buildEnginePvMoves(rootFen, pv)[moveIndex];
    if (!move) return;
    setAnalysisScratchPosition({ fen: move.fen, lastMove: move.lastMove });
  };

  const setEngineRunningEnabled = (enabled: boolean) => {
    if (analysisGameProgress || isTreeEvalRunning || playerAssessmentJobRef.current) return;
    engineRunningRef.current = enabled;
    if (enabled) {
      setEngineRunning(true);
      return;
    }
    stockfishRef.current?.postMessage('stop');
    setEngineStatus('stopped');
    setEngineRunning(false);
  };

  const selectEngine = (clicked: EngineChoice) => {
    if (analysisGameProgress || isTreeEvalRunning || playerAssessmentJobRef.current) return;
    let engine = clicked;
    let mixed = false;
    if (bothEngines) {
      engine = clicked === 'stockfish' ? 'maia' : 'stockfish';
    } else if (clicked !== selectedEngine) {
      engine = 'maia';
      mixed = true;
    }
    if (engine === selectedEngine && mixed === bothEngines) return;
    setBothEngines(mixed);
    if (engine === selectedEngine) return;
    selectedEngineRef.current = engine;
    maiaAnalysisRequestRef.current += 1;
    pendingAnalysisRef.current = null;
    stockfishRef.current?.postMessage('stop');
    lineCacheRef.current = new Map();
    setEngineLines([]);
    setMaiaResultKey('');
    setMaiaError('');
    setMaiaLoadingStatus(null);
    setEngineStatus(engineRunning ? 'analyzing' : 'stopped');
    setSelectedEngine(engine);
  };

  const runExplorerSearch = async (run: (controller: AbortController) => Promise<void>) => {
    if (findMissingControllerRef.current || playerAssessmentJobRef.current) return;
    const controller = new AbortController();
    findMissingControllerRef.current = controller;
    setIsFindMissingSearchRunning(true);
    setPlayerSearchNote('');
    try {
      await run(controller);
    } catch (error) {
      if (!controller.signal.aborted) setPlayerSearchNote(getErrorMessage(error, 'Search failed.'));
    } finally {
      findMissingControllerRef.current = null;
      setIsFindMissingSearchRunning(false);
    }
  };

  const inspectPlayerReply = async (fen: string, query: ReturnType<typeof playerSearchQuery>, controller: AbortController) => {
    const response = await query(fen);
    const moves = playerExplorerMoves(fen, response.moves).filter(move => explorerGameCount(move) > 0);
    if (!moves.length) return false;
    const counts = new Map(moves.map(move => [move.uci, explorerGameCount(move)]));
    for (const uci of playerRepertoire?.movesByFen.get(bookPositionFenKey(fen)) ?? []) {
      if (!counts.has(uci)) counts.set(uci, 0);
    }
    const assessment = await withPlayerEngine(controller, () => assessPlayerPosition(fen, counts, controller.signal, true));
    return moves.some(move => (assessment.moves[move.uci]?.confirmedLoss ?? 0) >= PLAYER_MISTAKE_LOSS);
  };

  const checkPlayerReplies = async () => {
    if (!explorerData || !stockfishLoaded || isExampleReplayActive || isTreeEvalRunning || trainingSession || analysisGameProgress) return;
    await runExplorerSearch(async controller => {
      const query = playerSearchQuery(controller.signal);
      let found = 0;
      for (const move of playerExplorerMoves(selectedBoardFen, explorerData.moves)) {
        controller.signal.throwIfAborted();
        const reply = explorerReplyFen(selectedBoardFen, move.uci);
        if (reply && await inspectPlayerReply(reply, query, controller)) found++;
      }
      if (!found) setPlayerSearchNote('No confirmed mistakes in the replies checked.');
    });
  };

  const reviewNodesFromBoard = (turn: Side): RepertoireReviewNode[] => {
    const preparedByFen = new Map(repertoireReviewNodes.map(({ node, prepared }) => [bookPositionFenKey(node.fen), prepared]));
    const ordered = (isBrowseMode ? repertoireReviewNodes.map(({ node }) => node) : repertoireBranchNodes(tree, tree.rootId))
      .map(node => ({ node, key: bookPositionFenKey(node.fen) }));
    const baseNode = browseMistakePosition?.node ?? browseOpponentPosition ?? selectedNode;
    const baseKey = bookPositionFenKey(baseNode.fen);
    const baseIndex = ordered.findIndex(({ node, key }) => isBrowseMode ? key === baseKey : node.id === baseNode.id);
    const boardIndex = playerPositionKey === baseKey ? baseIndex : ordered.findIndex(({ key }) => key === playerPositionKey);
    const start = Math.max(0, boardIndex >= 0 ? boardIndex : baseIndex);

    // Keep the whole scope, but visit it from the board position once per review.
    const result: RepertoireReviewNode[] = [];
    for (const { node, key } of [...ordered.slice(start), ...ordered.slice(0, start)]) {
      const prepared = preparedByFen.get(key);
      if (!prepared || toTurnColor(node.fen) !== turn) continue;
      result.push({ node, prepared });
      preparedByFen.delete(key);
    }
    return result;
  };

  const jumpToNextMissingLichessMove = async () => {
    const player = lichessSource === 'player';
    const minFrequency = player ? playerNextMissingMoveThreshold : nextMissingMoveThreshold;
    if (!hasOpponentReviewNodes || isTrainingActive || isSuddenDeathActive || isExampleReplayActive || isTreeEvalRunning ||
      (player && !playerHandle.trim())) return;
    if (opponentReview && isFindMissingSearchRunning) {
      setOpponentReview(prev => prev && (prev.index + 1 < prev.findings.length
        ? { ...prev, index: prev.index + 1, waitingForNext: false }
        : { ...prev, waitingForNext: true }));
      return;
    }
    if (opponentReview && opponentReview.index + 1 < opponentReview.findings.length) {
      setOpponentReview({ ...opponentReview, index: opponentReview.index + 1 });
      return;
    }
    if (opponentReview?.exhausted || findMissingControllerRef.current || playerAssessmentJobRef.current) return;
    if (mistakeReview) closeMistakeReview();
    setPortraitTab('lichess');
    const review: OpponentReview = opponentReview ?? {
      nodes: reviewNodesFromBoard(activeSide === 'white' ? 'black' : 'white'),
      findings: [], index: -1, nextNode: 0, waitingForNext: true, exhausted: false,
    };
    setOpponentReview({ ...review, waitingForNext: true });
    await runExplorerSearch(async controller => {
      if (player) setPlayerSearchNote('Preparing your game history…');
      const personal = player ? await preparePersonalReviewQuery(controller.signal, true) : null;
      setOpponentReview(prev => prev && ({ ...prev, fromHistory: personal?.fromHistory }));
      for (let i = review.nextNode; i < review.nodes.length; i++) {
        const { node, prepared } = review.nodes[i];
        controller.signal.throwIfAborted();
        if (!prepared.size && (!player || !stockfishLoaded)) {
          setOpponentReview(prev => prev && ({ ...prev, nextNode: i + 1 }));
          continue;
        }
        setPlayerSearchNote(`Checking opponent position ${i + 1} / ${review.nodes.length}…`);
        const data = personal ? await personal.query(node.fen) : await fetchLichessNodeData(node.fen, controller.signal);
        controller.signal.throwIfAborted();
        if (!data) throw new Error('Could not check this position. Try again.');
        const total = explorerGameCount(data);
        const moves = player ? playerExplorerMoves(node.fen, data.moves) : data.moves;
        const missing = new Set<string>();
        for (const move of moves) {
          const count = explorerGameCount(move);
          if (prepared.has(move.uci) || count === 0) continue;
          if (minFrequency > 0 && (!total || count / total < minFrequency / 100)) continue;
          if (personal && !prepared.size) {
            const reply = explorerReplyFen(node.fen, move.uci);
            if (!reply || !await inspectPlayerReply(reply, personal.query, controller)) continue;
          }
          missing.add(move.uci);
        }
        controller.signal.throwIfAborted();
        setOpponentReview(prev => {
          if (!prev) return prev;
          if (!missing.size) return { ...prev, nextNode: i + 1 };
          const finding = { node, moves: missing, prepared, data };
          return {
            ...prev,
            findings: [...prev.findings, finding],
            index: prev.waitingForNext ? prev.index + 1 : prev.index,
            nextNode: i + 1,
            waitingForNext: false,
          };
        });
      }
      controller.signal.throwIfAborted();
      setOpponentReview(prev => prev && ({ ...prev, waitingForNext: false, exhausted: true }));
      setPlayerSearchNote('');
    });
  };

  const closeMistakeReview = () => {
    if (!mistakeReview) return;
    if (isFindingCommonMistakes) findMissingControllerRef.current?.abort();
    setAnalysisScratchPosition(null);
    setMistakeReview(null);
    setPlayerSearchNote('');
    setPortraitTab('moves');
  };

  const closeOpponentFinding = () => {
    if (opponentReview) findMissingControllerRef.current?.abort();
    setOpponentReview(null);
    setAnalysisScratchPosition(null);
    setPlayerSearchNote('');
    setPortraitTab('moves');
  };

  const showMistakePosition = (position: MistakeReviewPosition) => {
    setAnalysisScratchPosition(null);
    if (!isBrowseMode && position.node.id !== selectedNode.id) {
      findMissingSearchAutoNavigationRef.current = true;
      navigateToNode(activeSide, position.node.id);
    }
  };

  const findCommonMistakes = async (direction: -1 | 1 = 1) => {
    if (!playerHandle.trim() || !stockfishLoaded || !hasMistakeReviewNodes || !hasHydratedAppState ||
      trainingSession || isTreeEvalRunning || analysisGameProgress || isExampleReplayActive ||
      findMissingControllerRef.current || playerAssessmentJobRef.current) return;
    setPortraitTab('lichess');
    const review: MistakeReview = mistakeReview ?? {
      nodes: reviewNodesFromBoard(activeSide),
      positions: [], index: -1, nextNode: 0, exhausted: false,
    };
    const target = review.index + direction;
    if (review.positions[target]) {
      setPlayerSearchNote('');
      setMistakeReview({ ...review, index: target });
      showMistakePosition(review.positions[target]);
      return;
    }
    if (direction === -1 || review.exhausted) return;
    setOpponentReview(null);
    setAnalysisScratchPosition(null);
    setMistakeReview(review);
    setIsFindingCommonMistakes(true);
    try {
      await runExplorerSearch(async controller => {
        const { signal } = controller;
        setPlayerSearchNote('Preparing your game history…');
        const { query, fromHistory } = await preparePersonalReviewQuery(signal);
        const now = new Date();
        const sinceTimestamp = playerGameHistoryStart(now.getTime(), mistakeHistoryMonths);
        const sinceMonth = new Date(sinceTimestamp).toISOString().slice(0, 7);
        const dates = { since: sinceMonth, sinceTimestamp };
        const recentSince = monthKey(now.getUTCFullYear() * 12 + now.getUTCMonth() - 2);
        for (let i = review.nextNode; i < review.nodes.length; i++) {
          signal.throwIfAborted();
          const { node, prepared } = review.nodes[i];
          setPlayerSearchNote('Checking position ' + (i + 1) + ' / ' + review.nodes.length + '…');
          const data = await query(node.fen, dates);
          const all = new Map(playerExplorerMoves(node.fen, data.moves).map(move => [move.uci, move]));
          const knownMoves = mistakePreparedByFen.get(bookPositionFenKey(node.fen)) ?? prepared;
          const deviations = [...all.values()].filter(move => !knownMoves.has(move.uci) && explorerGameCount(move) > 0);
          if (deviations.length) {
            const counts = new Map(deviations.map(move => [move.uci, explorerGameCount(move)]));
            for (const uci of prepared) counts.set(uci, all.has(uci) ? explorerGameCount(all.get(uci)!) : 0);
            const assessment = await withPlayerEngine(controller, () => assessPlayerPosition(node.fen, counts, signal, true));
            const mistakes = deviations.filter(move => (assessment.moves[move.uci]?.confirmedLoss ?? 0) >= PLAYER_MISTAKE_LOSS);
            if (mistakes.length) {
              const recentData = recentSince <= sinceMonth ? data : await query(node.fen, { ...dates, since: recentSince });
              const recent = new Map(playerExplorerMoves(node.fen, recentData.moves).map(move => [move.uci, explorerGameCount(move)]));
              const latestByRawMove = new Map<string, string>();
              for (const game of data.recentGames ?? []) {
                const month = playerGameMonth(game);
                if (game.uci && month && month > (latestByRawMove.get(game.uci) ?? '')) latestByRawMove.set(game.uci, month);
              }
              const rawUciBySan = new Map(data.moves.map(move => [move.san, move.uci]));
              const makeRow = (uci: string, inRepertoire: boolean): MistakeReviewMove => {
                const move = all.get(uci);
                const total = move ? explorerGameCount(move) : 0;
                const recentCount = Math.min(total, recent.get(uci) ?? 0);
                const evaluation = assessment.moves[uci];
                return {
                  uci, inRepertoire, score: evaluation?.score, provisional: evaluation?.confirmedLoss === null,
                  results: {
                    wins: (activeSide === 'white' ? move?.white : move?.black) ?? 0,
                    draws: move?.draws ?? 0,
                    losses: (activeSide === 'white' ? move?.black : move?.white) ?? 0,
                  },
                  recent: recentCount, earlier: total - recentCount,
                  lastPlayedAt: move?.lastPlayedAt,
                  lastMonth: playerGameMonth(move?.game) ?? (move ? latestByRawMove.get(rawUciBySan.get(move.san) ?? uci) : undefined),
                };
              };
              const recentGames = Math.min(explorerGameCount(data), explorerGameCount(recentData));
              const position: MistakeReviewPosition = {
                node, recentSince, sinceMonth, recentGames, earlierGames: explorerGameCount(data) - recentGames, fromHistory,
                moves: [
                  ...[...prepared].map(uci => makeRow(uci, true)),
                  ...mistakes.map(move => makeRow(move.uci, false))
                    .sort((a, b) => playerMistakePriority(b) - playerMistakePriority(a)),
                ],
              };
              signal.throwIfAborted();
              setMistakeReview({ ...review, positions: [...review.positions, position], index: target, nextNode: i + 1,
                exhausted: i + 1 === review.nodes.length });
              setPlayerSearchNote('');
              showMistakePosition(position);
              return;
            }
          }
          signal.throwIfAborted();
          setMistakeReview(prev => prev && ({ ...prev, nextNode: i + 1 }));
        }
        setMistakeReview(prev => prev && ({ ...prev, exhausted: true }));
        setPlayerSearchNote(review.positions.length ? 'No further mistakes.' : 'No confirmed mistakes outside the repertoire.');
      });
    } finally {
      setIsFindingCommonMistakes(false);
    }
  };

  const savePgn = async (pgn: string, filename: string) => {
    await saveTextFileWithPickers(
      pgn,
      filename,
      'application/x-chess-pgn',
      'PGN file',
      ['.pgn', '.txt'],
    );
  };

  const exportCurrentRepertoirePgn = async () => {
    if (isBackupIoRunning) return;
    setIsBackupIoRunning(true);
    const pgn = exportTreeToPgn(tree, activeSide, activeRepertoireName);
    const safeName = normalizeRepertoireName(activeRepertoireName).replace(/[^\w-]+/g, '_');
    const filename = `${activeSide}-${safeName || 'repertoire'}.pgn`;
    try {
      await savePgn(pgn, filename);
      setStatus(`Exported PGN (${filename})`);
      setIsOptionsOpen(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('PGN export cancelled');
      } else {
        setStatus(`PGN export failed: ${errorMessage}`);
        window.alert(`PGN export failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const saveCurrentGamePgn = async () => {
    if (isBackupIoRunning || mainLinePath.length < 2) return;
    setIsBackupIoRunning(true);
    try {
      await savePgn(exportGameToPgn(tree, boardOrientation, playerHandle), 'game.pgn');
      setStatus('Saved game PGN');
      setIsOptionsOpen(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('PGN save cancelled');
      } else {
        setStatus(`PGN save failed: ${errorMessage}`);
        window.alert(`PGN save failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const exportWholeDatabasePgn = async () => {
    if (isBackupIoRunning) return;
    setIsBackupIoRunning(true);
    const games = (['white', 'black'] as Side[]).flatMap((side) =>
      repertoiresBySide[side]
        .filter((entry) => repertoireHasMoves(entry.tree))
        .map((entry) => exportTreeToPgn(entry.tree, side, entry.name)),
    );
    if (games.length === 0) {
      setIsBackupIoRunning(false);
      return;
    }
    const filename = 'all-repertoires.pgn';
    try {
      await savePgn(games.join('\n\n'), filename);
      setStatus(`Exported PGN (${filename})`);
      setIsOptionsOpen(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('PGN export cancelled');
      } else {
        setStatus(`PGN export failed: ${errorMessage}`);
        window.alert(`PGN export failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const buildBackupPayload = (): BackupPayload => {
    const settingsPayload: PersistedSettingsState = {
      version: 1,
      themeMode,
      selectedEngine,
      bothEngines,
      maiaStrengthElo,
      analysisBenchmarkElo,
      suddenDeathEngine,
      suddenDeathMaiaElo,
      repertoireSide,
      isTempBoardFlipped,
      lichessSource,
      playerHandle,
      playerSpeeds,
      lichessApiToken,
      dateRange,
      lichessArrowThreshold,
      engineDepth,
      engineMultiPv,
      selectedSpeeds,
      selectedRatings,
      selectedModes,
      showLichessOnTreeMoves,
      lichessArrowsOpponentOnly,
      showMistakeArrows,
      mistakeHistoryMonths,
      showTreeArrows,
      showLichessArrows,
      showStockfishArrows,
      showMaiaArrows,
      combineCompactEngineArrows,
      stockfishEvalSeconds,
      trainingStatsQueueLength,
      trainAlternativeMoves,
      suddenDeathThreshold,
      suddenDeathMinMoves,
      suddenDeathStockfishElo,
      suddenDeathMaxThinkTimeSec,
      nextMissingMoveThreshold,
      playerNextMissingMoveThreshold,
      desktopLichessShare,
    };
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      appState: {
        version: 2,
        repertoiresBySide,
        activeRepertoireIdBySide,
        browseAnnotations,
      },
      settings: settingsPayload,
      trainingStats: trainingStatsBySide,
      trainingLeafLastShown: trainingLeafLastShownBySide,
    };
  };

  const saveTextFileWithPickers = async (
    content: string,
    filename: string,
    mimeType: string,
    description: string,
    extensions: string[],
  ) => {
    type PickerWindow = Window & {
      showDirectoryPicker?: () => Promise<{
        getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
          createWritable: () => Promise<{ write: (data: string | Blob) => Promise<void>; close: () => Promise<void> }>;
        }>;
      }>;
      showSaveFilePicker?: (options?: {
        suggestedName?: string;
        types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      }) => Promise<{
        createWritable: () => Promise<{ write: (data: string | Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    };
    const pickerWindow = window as PickerWindow;
    if (pickerWindow.showDirectoryPicker) {
      const dir = await pickerWindow.showDirectoryPicker();
      const fileHandle = await dir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    }
    if (pickerWindow.showSaveFilePicker) {
      const fileHandle = await pickerWindow.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description, accept: { [mimeType]: extensions } }],
      });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    }
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const openTextFileWithPicker = async (description: string, mimeType: string, extensions: string[]) => {
    type PickerWindow = Window & {
      showOpenFilePicker?: (options?: {
        multiple?: boolean;
        types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      }) => Promise<Array<{ getFile: () => Promise<File> }>>;
    };
    const pickerWindow = window as PickerWindow;
    if (!pickerWindow.showOpenFilePicker) return null;
    const [handle] = await pickerWindow.showOpenFilePicker({
      multiple: false,
      types: [{ description, accept: { [mimeType]: extensions } }],
    });
    if (!handle) return null;
    return handle.getFile();
  };

  const restoreFromBackupFile = async (file: File) => {
    const parsed = normalizeBackupPayload(JSON.parse(await file.text()));
    if (!parsed) throw new Error('Backup file format is invalid.');

    const timestamp =
      readBackupTimestampFromFilename(file.name) ??
      (Number.isNaN(Date.parse(parsed.exportedAt)) ? parsed.exportedAt : new Date(parsed.exportedAt).toLocaleString());
    const confirmed = window.confirm(
      `Replace local DB and training stats with this backup?\nTime: ${timestamp}\nFile: ${file.name}\n\nThis will overwrite local data.`,
    );
    if (!confirmed) {
      setStatus('Backup restore cancelled');
      return;
    }

    applyPersistedDatabaseState(parsed.appState);
    setTrainingStatsBySide(parsed.trainingStats);
    setTrainingLeafLastShownBySide(parsed.trainingLeafLastShown);
    if (parsed.settings) applyPersistedSettingsState(parsed.settings);

    const writes: Promise<void>[] = [
      idbSet(APP_STATE_KEY, parsed.appState),
      idbSet(APP_TRAINING_STATS_KEY, parsed.trainingStats),
      idbSet(APP_TRAINING_LEAF_LAST_SHOWN_KEY, parsed.trainingLeafLastShown),
    ];
    if (parsed.settings) writes.push(idbSet(APP_SETTINGS_KEY, parsed.settings));
    await Promise.all(writes);

    setStatus(`Backup restored (${file.name})`);
    window.alert(`Backup restored successfully.\n\nFile: ${file.name}`);
    setIsOptionsOpen(false);
  };

  const saveBackupToFile = async () => {
    if (isBackupIoRunning) return;
    setIsBackupIoRunning(true);
    setStatus('Saving backup...');
    try {
      const payload = JSON.stringify(buildBackupPayload());
      const filename = createBackupFilename();
      await saveTextFileWithPickers(
        payload,
        filename,
        BACKUP_FILE_MIME_TYPE,
        'Opening prep backup',
        ['.json'],
      );

      setStatus(`Backup saved (${filename})`);
      window.alert(`Backup saved successfully.\n\nFile: ${filename}`);
      setIsOptionsOpen(false);
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('Backup save cancelled');
      } else {
        setStatus(`Backup save failed: ${errorMessage}`);
        window.alert(`Backup save failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const restoreBackupFromFilePicker = async () => {
    if (isBackupIoRunning) return;
    setIsBackupIoRunning(true);
    setStatus('Selecting backup...');
    try {
      const file = await openTextFileWithPicker('Opening prep backup', BACKUP_FILE_MIME_TYPE, ['.json']);
      if (file) {
        await restoreFromBackupFile(file);
      } else {
        backupImportInputRef.current?.click();
        setStatus('Choose a backup file to restore');
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('Backup restore cancelled');
      } else {
        setStatus(`Backup restore failed: ${errorMessage}`);
        window.alert(`Backup restore failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const clearWholeDatabase = () => {
    const confirmed = window.confirm('Delete all repertoires from local DB? This cannot be undone.');
    if (!confirmed) return;

    const whiteTree = createEmptyTree('white');
    const blackTree = createEmptyTree('black');

    setRepertoiresBySide({ white: [], black: [] });
    setActiveRepertoireIdBySide({ white: null, black: null });
    setTrees({ white: whiteTree, black: blackTree });
    setSelectedNodeBySide({ white: whiteTree.rootId, black: blackTree.rootId });
    setUndoStackBySide({ white: [], black: [] });
    setTrainingSession(null);
    setIsOptionsOpen(false);
  };

  const importPgnFile = async (file: File, mode: 'current' | 'db') => {
    const pgn = await file.text();
    if (mode === 'db') {
      const chunks = splitPgnGames(pgn);
      if (chunks.length === 0) {
        return;
      }

      const importedBySide: Record<Side, RepertoireEntry[]> = { white: [], black: [] };

      chunks.forEach((chunk, index) => {
        const headers = parsePgnHeaders(chunk);
        const whiteHeader = (headers.White ?? '').toLowerCase();
        const blackHeader = (headers.Black ?? '').toLowerCase();
        const side: Side =
          whiteHeader.includes('repertoire') ? 'white' : blackHeader.includes('repertoire') ? 'black' : activeSide;

        const eventName = headers.Event ?? '';
        const baseName = eventName.startsWith('Opening Prep Trainer - ')
          ? eventName.slice('Opening Prep Trainer - '.length)
          : `Imported ${side} repertoire ${index + 1}`;
        const treeForSide = parsePgnToTree(side, chunk, createEmptyTree(side));
        importedBySide[side].push({
          id: createRepertoireId(side),
          name: normalizeRepertoireName(baseName),
          enabled: true,
          tree: treeForSide,
          selectedNodeId: treeForSide.rootId,
        });
      });

      if (importedBySide.white.length === 0 && importedBySide.black.length === 0) {
        return;
      }

      setRepertoiresBySide((prev) => {
        const mergeSide = (side: Side): RepertoireEntry[] => {
          const nextList = [...prev[side]];
          const byName = new Map<string, number>();
          nextList.forEach((entry, idx) => {
            byName.set(normalizeRepertoireName(entry.name).toLowerCase(), idx);
          });

          for (const imported of importedBySide[side]) {
            const key = normalizeRepertoireName(imported.name).toLowerCase();
            const existingIdx = byName.get(key);
            if (existingIdx === undefined) {
              nextList.push(imported);
              byName.set(key, nextList.length - 1);
              continue;
            }
            const existing = nextList[existingIdx];
            nextList[existingIdx] = {
              ...existing,
              name: imported.name,
              tree: imported.tree,
              selectedNodeId: imported.selectedNodeId,
            };
          }

          return nextList;
        };

        return {
          white: mergeSide('white'),
          black: mergeSide('black'),
        };
      });
      return;
    }

    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const nextTree = parsePgnToTree(activeSide, pgn, currentTree);
    setUndoStackBySide((prev) => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree: currentTree, selectedNodeId: currentSelectedId }].slice(-200),
    }));
    setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
    setSelectedNodeBySide((prev) => ({
      ...prev,
      [activeSide]: nextTree.nodes[currentSelectedId] ? currentSelectedId : nextTree.rootId,
    }));
  };

  const loadAnalysisGamePgn = async (file: File) => {
    const pgn = await file.text();
    const games = splitPgnGames(pgn);
    const firstGame = games[0];
    if (!firstGame) throw new Error('The selected file does not contain a PGN game.');

    const nextTree = parsePgnToTree(activeSide, firstGame, createEmptyTree(activeSide));
    if (Object.keys(nextTree.nodes).length <= 1) throw new Error('No valid moves were found in the PGN game.');
    const pgnHeaders = parsePgnHeaders(firstGame);
    const rawRating = (value?: string) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : undefined;
    };
    const time = pgnHeaders.TimeControl?.match(/^(\d+)(?:\+(\d+))?$/);
    const seconds = time ? +time[1] + 40 * +(time[2] ?? 0) : null;
    const context: AnalysisContext = {
      whiteRating: rawRating(pgnHeaders.WhiteElo), blackRating: rawRating(pgnHeaders.BlackElo),
      ratingSystem: /lichess/i.test(pgnHeaders.Site ?? '') ? 'lichess' : /chess\.com/i.test(pgnHeaders.Site ?? '') ? 'chesscom' : undefined,
      timeControl: pgnHeaders.TimeControl,
      ratingPool: seconds === null ? 'unknown' : seconds < 180 ? 'bullet' : seconds < 480 ? 'blitz' : seconds < 1500 ? 'rapid' : 'classical',
    };
    setAnalysisContext(context); setAnalysisContextSource('pgn');
    localStorage.setItem('analysis-context', JSON.stringify(context));

    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    setUndoStackBySide((prev) => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree: currentTree, selectedNodeId: currentSelectedId }].slice(-200),
    }));
    setActiveRepertoireIdBySide((prev) => ({ ...prev, [activeSide]: null }));
    setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: nextTree.rootId }));
    setAnalysisScratchPosition(null);
    setGameAnalysisReport(null);
    void idbSet(APP_GAME_ANALYSIS_REPORT_KEY, null).catch(() => setStatus('Game analysis save failed'));
    setShowAnalysisReport(false);
    setEngineRunning(false);
    setPortraitTab('moves');
    setStatus(games.length > 1
      ? `Loaded first game from ${file.name} (${games.length} games in file)`
      : `Loaded game from ${file.name}`);
  };

  const openImportDialog = async (mode: 'current' | 'db' = 'current') => {
    if (isBackupIoRunning) return;
    setImportMode(mode);
    setIsBackupIoRunning(true);
    try {
      const file = await openTextFileWithPicker('PGN file', 'application/x-chess-pgn', ['.pgn', '.txt']);
      if (file) {
        await importPgnFile(file, mode);
        setStatus(`Imported ${mode === 'db' ? 'whole DB' : 'current repertoire'} from ${file.name}`);
        setIsOptionsOpen(false);
      } else {
        importInputRef.current?.click();
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      if (errorMessage.toLowerCase().includes('abort')) {
        setStatus('PGN import cancelled');
      } else {
        setStatus(`PGN import failed: ${errorMessage}`);
        window.alert(`PGN import failed.\n\n${errorMessage}`);
      }
    } finally {
      setIsBackupIoRunning(false);
    }
  };

  const createNewRepertoire = (side: Side = activeSide) => {
    const name = normalizeRepertoireName(newRepertoireName);
    const next = createEmptyRepertoire(side, name);
    setRepertoiresBySide((prev) => ({
      ...prev,
      [side]: [...prev[side], next],
    }));
    setActiveRepertoireIdBySide((prev) => ({
      ...prev,
      [side]: next.id,
    }));
    setRepertoireModeBySide((prev) => ({ ...prev, [side]: 'edit' }));
    setTrees((prev) => ({
      ...prev,
      [side]: next.tree,
    }));
    setSelectedNodeBySide((prev) => ({
      ...prev,
      [side]: next.selectedNodeId,
    }));
    setUndoStackBySide((prev) => ({ ...prev, [side]: [] }));
    setTrainingSession((prev) => (prev?.side === side ? null : prev));
    setNewRepertoireName('');
    setIsNewRepertoireOpen(false);
    setIsOptionsOpen(false);
    setStatus(`Created repertoire "${next.name}" (${side})`);
  };

  const loadRepertoire = (repertoireId: string, side: Side = activeSide, preservePosition = false,
    mode: RepertoireMode = 'review') => {
    const entry = enabledRepertoiresBySide[side].find((item) => item.id === repertoireId);
    if (!entry) return;
    if (mode === 'review' && activeRepertoireIdBySide[side] === repertoireId &&
      repertoireModeBySide[side] === 'review') {
      // Database review keeps only the line to the current position.
      const currentTree = trees[side];
      const currentNodeId = selectedNodeBySide[side] ?? currentTree.rootId;
      setTrees((prev) => ({ ...prev, [side]: treeThroughNode(currentTree, currentNodeId) }));
      setActiveRepertoireIdBySide((prev) => ({ ...prev, [side]: null }));
      setUndoStackBySide((prev) => ({ ...prev, [side]: [] }));
      setTrainingSession((prev) => (prev?.side === side ? null : prev));
      setAnalysisScratchPosition(null);
      setShowAnalysisReport(false);
      setIsLoadRepertoireOpen(false);
      setIsOptionsOpen(false);
      return;
    }
    const currentFenKey = positionFenKey(selectedNode.fen);
    const preservedNodeId =
      (preservePosition || activeRepertoireIdBySide[side] === repertoireId)
        ? Object.values(entry.tree.nodes).find((node) => positionFenKey(node.fen) === currentFenKey)?.id ?? null
        : null;
    const nextSelectedId = preservedNodeId ?? (entry.tree.nodes[entry.selectedNodeId] ? entry.selectedNodeId : entry.tree.rootId);
    setRepertoireSide(side);
    setIsTempBoardFlipped(false);
    setActiveRepertoireIdBySide((prev) => ({
      ...prev,
      [side]: entry.id,
    }));
    setRepertoireModeBySide((prev) => ({ ...prev, [side]: mode }));
    setTrees((prev) => ({
      ...prev,
      [side]: entry.tree,
    }));
    setSelectedNodeBySide((prev) => ({
      ...prev,
      [side]: nextSelectedId,
    }));
    setUndoStackBySide((prev) => ({ ...prev, [side]: [] }));
    setTrainingSession((prev) => (prev?.side === side ? null : prev));
    setIsLoadRepertoireOpen(false);
    setIsOptionsOpen(false);
  };

  const toggleRepertoireEnabled = (entry: RepertoireEntry, side: Side) => {
    const isLoaded = activeRepertoireIdBySide[side] === entry.id;
    if (trainingSession?.side === side && (isLoaded || !activeRepertoireIdBySide[side])) stopTraining();
    if (entry.enabled && isLoaded) {
      const emptyTree = createEmptyTree(side);
      setActiveRepertoireIdBySide((prev) => ({ ...prev, [side]: null }));
      setTrees((prev) => ({ ...prev, [side]: emptyTree }));
      setSelectedNodeBySide((prev) => ({ ...prev, [side]: emptyTree.rootId }));
      setUndoStackBySide((prev) => ({ ...prev, [side]: [] }));
      if (side === activeSide) {
        setAnalysisScratchPosition(null);
        setShowAnalysisReport(false);
        setTreeOptionDeletePopup(null);
      }
    }
    setRepertoiresBySide((prev) => ({
      ...prev,
      [side]: prev[side].map((item) => item.id === entry.id ? { ...item, enabled: !item.enabled } : item),
    }));
  };

  const startRenamingRepertoire = (repertoireId: string, side: Side = activeSide) => {
    const entry = repertoiresBySide[side].find((item) => item.id === repertoireId);
    if (!entry) return;
    setRenamingRepertoireId(repertoireId);
    setRenameDraft(entry.name);
  };

  const cancelRenamingRepertoire = () => {
    setRenamingRepertoireId(null);
    setRenameDraft('');
  };

  const commitRenameRepertoire = (repertoireId: string, side: Side = activeSide) => {
    const nextName = normalizeRepertoireName(renameDraft);
    setRepertoiresBySide((prev) => ({
      ...prev,
      [side]: prev[side].map((entry) =>
        entry.id === repertoireId
          ? {
              ...entry,
              name: nextName,
            }
          : entry,
      ),
    }));
    setRenamingRepertoireId(null);
    setRenameDraft('');
    setStatus(`Renamed repertoire to "${nextName}"`);
  };

  const deleteRepertoire = (repertoireId: string, side: Side = activeSide) => {
    const entry = repertoiresBySide[side].find((item) => item.id === repertoireId);
    if (!entry) return;

    const confirmed = window.confirm(`Delete repertoire "${entry.name}"? This cannot be undone.`);
    if (!confirmed) return;

    setRepertoiresBySide((prev) => ({
      ...prev,
      [side]: prev[side].filter((item) => item.id !== repertoireId),
    }));

    if (repertoiresBySide[side].length === 1 || activeRepertoireIdBySide[side] === repertoireId) {
      const emptyTree = createEmptyTree(side);
      setActiveRepertoireIdBySide((prev) => ({
        ...prev,
        [side]: null,
      }));
      setTrees((prev) => ({
        ...prev,
        [side]: emptyTree,
      }));
      setSelectedNodeBySide((prev) => ({
        ...prev,
        [side]: emptyTree.rootId,
      }));
      setUndoStackBySide((prev) => ({ ...prev, [side]: [] }));
      setTrainingSession((prev) => (prev?.side === side ? null : prev));
    }

    if (renamingRepertoireId === repertoireId) {
      cancelRenamingRepertoire();
    }

    setStatus(`Deleted repertoire "${entry.name}"`);
  };

  const openInLichessAnalysis = () => {
    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
    const fenPath = fen.replace(/ /g, '_');
    const encodedFenPath = encodeURIComponent(fenPath).replace(/%2F/g, '/');
    const url = `https://lichess.org/analysis/${encodedFenPath}?color=${boardOrientation}`;
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (isAndroid) {
      const fallbackUrl = encodeURIComponent(url);
      const intentUrl = `intent://lichess.org/analysis/${encodedFenPath}?color=${boardOrientation}#Intent;scheme=https;package=org.lichess.mobileV2;S.browser_fallback_url=${fallbackUrl};end`;
      const opened = window.open(intentUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        window.location.href = intentUrl;
      }
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openProjectGithub = () => {
    window.open(PROJECT_GITHUB_URL, '_blank', 'noopener,noreferrer');
  };

  const shareFen = async () => {
    const fen = selectedNode.fen === START_FEN ? new Chess().fen() : selectedNode.fen;
    const payload = {
      title: 'Chess position (FEN)',
      text: fen,
    };

    try {
      if (navigator.share) {
        await navigator.share(payload);
        return;
      }
    } catch {
      // Ignore share cancel/errors and continue to clipboard fallback.
    }

    try {
      await navigator.clipboard.writeText(fen);
      setStatus('FEN copied');
    } catch {
      // Ignore clipboard failures to keep UI silent on mobile share fallback.
    }
  };

  const importPgn: ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (importMode === 'review') {
        await loadAnalysisGamePgn(file);
      } else {
        await importPgnFile(file, importMode);
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      setStatus(`PGN load failed: ${errorMessage}`);
      window.alert(`PGN load failed.\n\n${errorMessage}`);
    } finally {
      event.target.value = '';
      setImportMode('current');
    }
  };

  const importBackupFile: ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setIsBackupIoRunning(true);
      await restoreFromBackupFile(file);
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Unknown error');
      setStatus(`Backup restore failed: ${errorMessage}`);
      window.alert(`Backup restore failed.\n\n${errorMessage}`);
    } finally {
      event.target.value = '';
      setIsBackupIoRunning(false);
    }
  };

  const isSuddenDeathActive = Boolean(
    trainingSession && trainingSession.side === activeSide && trainingSession.suddenDeathMode,
  );
  const isTrainingActive = Boolean(
    trainingSession && trainingSession.side === activeSide && !trainingSession.suddenDeathMode,
  );
  const boardLastMove = suddenDeathReviewPosition
    ? suddenDeathReviewPosition.move?.squares
    : hasExampleReplayBoardOverride
    ? (exampleReplay as ExampleReplayState).lastMoves[(exampleReplay as ExampleReplayState).currentIndex] ?? undefined
    : hasSuddenDeathBoardOverride
      ? suddenDeathLastMove ?? undefined
      : analysisScratchFen
        ? analysisScratchPosition?.lastMove ?? undefined
        : browseMistakePosition || browseOpponentPosition
          ? parseUciMove((browseMistakePosition?.node ?? browseOpponentPosition)?.moveUci ?? null) ?? undefined
          : lastMove;
  useEffect(() => {
    if (isTrainingActive) return;
    setIsTrainingStatsMenuOpen(false);
  }, [isTrainingActive]);
  const hasExportableDbGames = useMemo(
    () =>
      (['white', 'black'] as Side[]).some((side) =>
        repertoiresBySide[side].some((entry) => repertoireHasMoves(entry.tree)),
      ),
    [repertoiresBySide],
  );
  const showHintButton = Boolean(isTrainingActive && trainingSession?.hintRequested);
  const isTrainingLineEnd = isTrainingActive && (isBrowseMode
    ? browseMoveOptions.length === 0
    : trainingMoveIds(tree, selectedNode, toTurnColor(selectedNode.fen) === activeSide, trainAlternativeMoves).length === 0);
  const isMobileClient = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  useEffect(() => {
    if (!lichessData?.opening || !lichessDataFen) return;
    const opening = lichessData.opening;
    const fenKey = lichessDataFen;
    setOpeningByFen((prev) => {
      const existing = prev[fenKey];
      if (existing && existing.eco === opening.eco && existing.name === opening.name) {
        return prev;
      }
      return {
        ...prev,
        [fenKey]: { eco: opening.eco, name: opening.name },
      };
    });
  }, [lichessData?.opening, lichessDataFen]);

  const resolvedOpening = useMemo(() => {
    if (selectedNode.fen === START_FEN) return null;
    if (lichessData?.opening && lichessDataFen === selectedNode.fen) return lichessData.opening;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const candidate = openingByFen[path[i].fen];
      if (candidate) return candidate;
    }
    return null;
  }, [lichessData?.opening, lichessDataFen, openingByFen, path, selectedNode.fen]);

  const trainingHintArrow = useMemo<DrawShape[]>(() => {
    if (!isTrainingActive || !trainingSession?.hintVisible || !trainingSession.hintMoveUci) return [];
    const keyPair = parseUciMove(trainingSession.hintMoveUci);
    if (!keyPair) return [];
    const [orig, dest] = keyPair;
    return [{ orig, dest, brush: 'green' }];
  }, [isTrainingActive, trainingSession]);
  const canGoBack = suddenDeathGameOver ? suddenDeathGameOver.index > 0
    : Boolean(analysisScratchPosition?.enginePreview || analysisScratchPosition?.playerMoves?.length || selectedNode.parentId);
  const backTitle = suddenDeathGameOver || analysisScratchPosition?.enginePreview ? 'Back (long press: original position)' : null;
  const isEngineEnabled = engineRunning;
  const canToggleMaiaArrows = maiaLoaded && engineRunning;
  const canToggleStockfishArrows = stockfishLoaded && engineRunning;
  const visibleEngineStatus =
    engineStatus === 'done' || engineStatus === 'stopped' || engineStatus === 'analyzing' ? '' : engineStatus;
  const currentEngineEvalRaw = engineRunning
    ? showMixedEngines
      ? comparison?.stockfishMoves[0]?.scoreText ?? null
      : selectedEngine === 'stockfish' && enginePvFen === maiaPositionFen
        ? engineLines[0]?.scoreText ?? null
        : null
    : null;
  const currentEngineEval = currentEngineEvalRaw ? normalizeEvalSignText(currentEngineEvalRaw) : null;
  const visibleEngineEval = currentEngineEval ? `(${currentEngineEval})` : '';
  const visibleLichessStatus = (() => {
    if (lichessData && lichessStatus === 'error') return '';
    if (lichessStatus === 'limited') return '';
    if (lichessStatus === 'done' || lichessStatus === 'idle') return '';
    return lichessStatus;
  })();
  const shouldShowLichessAddTokenButton = lichessApiToken.trim().length === 0 || lichessAuthRequired;
  const closeLichessTokenEditor = () => {
    if (lichessApiToken.trim().length > 0) {
      setLichessAuthRequired(false);
      if (lichessApiIssueNote.includes('401')) {
        setLichessApiIssueNote('');
      }
    }
    setIsLichessTokenEditorOpen(false);
  };
  const openingFullTitle = resolvedOpening ? `${resolvedOpening.eco} ${resolvedOpening.name}` : '';
  const openingTitleContent = useMemo(() => {
    if (!resolvedOpening) return '';
    const { eco, name } = resolvedOpening;
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
  }, [resolvedOpening]);
  const filteredLichessMoves = useMemo(() => {
    if (opponentFindingOnBoard) return opponentFindingOnBoard.data.moves.filter(move => opponentFindingOnBoard.moves.has(move.uci));
    if (!explorerData?.moves || lichessTotal <= 0) return [];
    const thresholdShare = lichessArrowThreshold / 100;
    return explorerData.moves.filter((move) => {
      const total = move.white + move.draws + move.black;
      return total / lichessTotal >= thresholdShare;
    });
  }, [explorerData, lichessTotal, lichessArrowThreshold, opponentFindingOnBoard]);
  const playerRows: PlayerMoveRow[] = [];
  const playerMoveCounts = new Map<string, number>();
  const playerBestMove = playerToMove ? playerAssessment?.best.bestMove : null;
  const showPlayerMoveCheck = playerToMove && !mistakeReview && !opponentReviewOpen && !isFindMissingSearchRunning;
  let playerBestSan: string | undefined;
  if (isPlayerExplorer) {
    const seen = new Map(playerExplorerPositionMoves.map(move => [move.uci, move]));
    const chess = fenToChess(selectedBoardFen);
    const legal = new Map(chess.moves({ verbose: true }).map(move => [uciFromMove(move), move.san]));
    if (playerBestMove) playerBestSan = legal.get(playerBestMove);
    const displayed = new Set([...(playerToMove ? playerRepertoireMoves ?? [] : []), ...seen.keys()]);
    for (const uci of displayed) {
      const san = legal.get(uci);
      if (!san) continue;
      const move = seen.get(uci);
      const results = move && {
        wins: activeSide === 'white' ? move.white : move.black,
        draws: move.draws,
        losses: activeSide === 'white' ? move.black : move.white,
      };
      if (playerToMove) playerMoveCounts.set(uci, move ? move.white + move.draws + move.black : 0);
      const inRepertoire = playerRepertoireMoves?.has(uci);
      const evaluation = playerToMove ? playerAssessment?.moves[uci] : undefined;
      const best = uci === playerBestMove;
      const mistake = !best && (evaluation?.confirmedLoss ?? 0) >= PLAYER_MISTAKE_LOSS;
      let note = isBrowseMode ? undefined : inRepertoire ? 'In repertoire' : 'Outside repertoire';
      if (!playerToMove && !isBrowseMode) {
        const reply = explorerReplyFen(selectedBoardFen, uci);
        if (!reply) continue;
        if (playerAfterLine) {
          note = 'Mistake in your replies';
        } else if (!playerRepertoire?.movesByFen.get(bookPositionFenKey(reply))?.size) {
          note = inRepertoire ? 'In repertoire · no reply' : 'No saved reply';
        }
      }
      if (mistake) note = inRepertoire ? 'Weak repertoire move' : note ? 'Mistake outside repertoire' : 'Mistake';
      playerRows.push({
        uci, san: toFigurineSan(san), note, best,
        score: best ? playerAssessment?.best.scoreText : evaluation?.score,
        provisional: !best && evaluation?.confirmedLoss === null, results,
      });
    }
    playerRows.sort((a, b) => (b.results ? b.results.wins + b.results.draws + b.results.losses : 0) -
      (a.results ? a.results.wins + a.results.draws + a.results.losses : 0));
  }
  const lichessTopGames = explorerData?.topGames ?? [];
  const lichessRecentGames = (explorerData?.recentGames ?? []).map(game => {
    if (!isPlayerExplorer) return game;
    const details = networkExplorerData?.recentGames?.find(entry => entry.id === game.id);
    const createdAt = game.createdAt ?? savedPlayerHistory?.games.find(entry => entry.id === game.id)?.createdAt;
    return { ...details, ...game, createdAt };
  });
  const hasLichessExampleGames = lichessTopGames.length > 0 || lichessRecentGames.length > 0;
  const isExampleReplayActive = Boolean(exampleReplay && exampleReplay.side === activeSide);

  const setExampleReplayPlaying = (playing: boolean) => {
    setExampleReplay((prev) => (prev ? { ...prev, playing } : prev));
  };

  const stepExampleReplay = (delta: -1 | 1) => {
    setExampleReplay((prev) => {
      if (!prev || prev.side !== activeSide) return prev;
      const maxIndex = prev.fens.length - 1;
      const nextIndex = Math.max(0, Math.min(maxIndex, prev.currentIndex + delta));
      return {
        ...prev,
        currentIndex: nextIndex,
        playing: false,
      };
    });
  };

  const quitExampleReplay = () => {
    setExampleReplay(null);
    setExampleReplayError('');
    setExampleReplayLoadingId(null);
  };

  useEffect(() => {
    if (!exampleReplay || exampleReplay.side !== activeSide || !exampleReplay.playing) return;
    if (exampleReplay.currentIndex >= exampleReplay.fens.length - 1) {
      setExampleReplayPlaying(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setExampleReplay((prev) => {
        if (!prev || prev.side !== activeSide || !prev.playing) return prev;
        const maxIndex = prev.fens.length - 1;
        const nextIndex = Math.min(maxIndex, prev.currentIndex + 1);
        return {
          ...prev,
          currentIndex: nextIndex,
          playing: nextIndex < maxIndex,
        };
      });
    }, 850);
    return () => window.clearTimeout(timeoutId);
  }, [exampleReplay, activeSide]);

  const loadExampleReplayGame = async (game: LichessExampleGame) => {
    if (suddenDeathGameOver || isSuddenDeathActive) return;
    const gameId = typeof game.id === 'string' ? game.id.trim() : '';
    if (!gameId) return;
    setExampleReplayLoadingId(gameId);
    setExampleReplayError('');
    try {
      const localGame = savedPlayerHistory?.games.find(entry => entry.id === gameId);
      let gameStartFen = START_POS_FEN;
      let fullGame = fenToChess(gameStartFen);
      if (localGame) {
        for (const san of localGame.moves.split(' ')) fullGame.move(san);
      } else {
        const response = await fetch(`https://lichess.org/game/export/${gameId}?moves=true&tags=true&clocks=false&evals=false`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const pgn = await response.text();
        gameStartFen = pgn.match(/\[FEN\s+"([^"]+)"\]/i)?.[1] ?? START_POS_FEN;
        fullGame = fenToChess(gameStartFen);
        try {
          fullGame.loadPgn(pgn);
        } catch {
          throw new Error('Invalid PGN');
        }
      }
      const verboseMoves = fullGame.history({ verbose: true }) as Move[];
      const targetFen = fullBoardFen(explorerFen);
      const targetKey = positionFenKey(targetFen);
      const scanChess = fenToChess(gameStartFen);
      const replayMovesUci: string[] = [];
      let foundTarget = false;

      for (const move of verboseMoves) {
        if (positionFenKey(scanChess.fen()) === targetKey) foundTarget = true;
        if (foundTarget) replayMovesUci.push(uciFromMove(move));
        scanChess.move({
          from: move.from,
          to: move.to,
          promotion: move.promotion as 'q' | 'r' | 'b' | 'n' | undefined,
        });
      }
      if (!foundTarget && positionFenKey(scanChess.fen()) === targetKey) foundTarget = true;
      if (!foundTarget) throw new Error('This game does not contain the current position.');

      const replayChess = fenToChess(targetFen);
      const fens = [targetFen];
      const lastMoves: Array<[Key, Key] | null> = [null];
      for (const uci of replayMovesUci) {
        const input = uciToMoveInput(uci);
        if (!input) break;
        const applied = replayChess.move(input);
        if (!applied) break;
        fens.push(replayChess.fen());
        lastMoves.push(parseUciMove(uci) ?? null);
      }
      if (fens.length <= 1) throw new Error('No continuation available from current position.');

      const playerText = game.white || game.black
        ? `${formatLichessExamplePlayer(game.white)} vs ${formatLichessExamplePlayer(game.black)}`
        : formatLichessExampleLine(game);
      setExampleReplay({
        side: activeSide,
        gameId,
        label: playerText,
        fens,
        lastMoves,
        currentIndex: 0,
        playing: true,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Failed to load game');
      setExampleReplayError(errorMessage);
    } finally {
      setExampleReplayLoadingId(null);
    }
  };
  const canRunFindMissingSearch =
    hasOpponentReviewNodes && (!isPlayerExplorer || Boolean(playerHandle.trim())) &&
    !isFindMissingSearchRunning && !isSuddenDeathActive && !isTreeEvalRunning && !playerAssessmentRunning;
  const hasNextOpponentFinding = Boolean(opponentReview && opponentReview.index + 1 < opponentReview.findings.length);
  const canFindCommonMistakes = Boolean(playerHandle.trim() && hasMistakeReviewNodes) && stockfishLoaded &&
    !isFindMissingSearchRunning && !playerAssessmentRunning && !isTreeEvalRunning &&
    hasHydratedAppState && !trainingSession && !isExampleReplayActive && !analysisGameProgress;
  const mistakeRows: PlayerMoveRow[] = reviewPosition?.moves.map(move => {
    const total = move.recent + move.earlier;
    const totalGames = reviewPosition.recentGames + reviewPosition.earlierGames;
    const lastPlayed = move.lastPlayedAt
      ? `Last played ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(move.lastPlayedAt)}`
      : move.lastMonth ? `Last played ${formatPlayerMonth(move.lastMonth)}`
      : !total ? 'Never played' : mistakeDateLookupFailed ? 'Last played: unavailable' : 'Finding last played…';
    const frequencyIn = (count: number, games: number) => games ? `${count}/${games}` : '—';
    return {
      uci: move.uci, san: uciToFigurineSan(reviewPosition.node.fen, move.uci),
      score: move.score, provisional: move.provisional, results: move.results,
      kind: move.inRepertoire ? 'repertoire' : 'mistake',
      note: move.inRepertoire ? 'Repertoire' : playerMistakePattern(move, reviewPosition.recentGames),
      frequency: `${formatGamesCount(total)} · ${formatPercent(total, totalGames)}`,
      detail: `${lastPlayed} · Recent ${frequencyIn(move.recent, reviewPosition.recentGames)} · Earlier ${frequencyIn(move.earlier, reviewPosition.earlierGames)}`,
    };
  }) ?? [];
  const displayedMovePath = isBrowseMode && !isTrainingActive ? mainLinePath : path;
  const selectedMoveIndex = displayedMovePath.findIndex((node) => node.id === selectedNode.id);
  const canGoForward = isBrowseMode && !isTrainingActive && !isSuddenDeathActive &&
    selectedMoveIndex >= 0 && selectedMoveIndex < displayedMovePath.length - 1;
  useLayoutEffect(() => {
    const group = movesArrowGroupRef.current;
    const row = group?.parentElement;
    const topGroup = topArrowGroupRef.current;
    if (!showMixedEngines || !group || !row || !topGroup) {
      setMovesArrowGroupNeedsCompact(false);
      return;
    }

    const preceding = [...row.children].filter(child => child !== group);
    const update = () => {
      if (topGroup.getClientRects().length > 0) {
        setMovesArrowGroupNeedsCompact(false);
        return;
      }
      const firstArrow = group.firstElementChild;
      if (!firstArrow || !group.getClientRects().length) return;

      const rowStyle = getComputedStyle(row);
      const rowRight = row.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderRightWidth);
      const lastControl = preceding.filter(child => child.getClientRects().length > 0).at(-1);
      const available = lastControl
        ? rowRight - lastControl.getBoundingClientRect().right - parseFloat(rowStyle.columnGap)
        : row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
      // Measure the full group even while the two engine buttons are replaced by one.
      const fullWidth = 4 * firstArrow.getBoundingClientRect().width + 3 * parseFloat(getComputedStyle(group).columnGap);
      setMovesArrowGroupNeedsCompact(available < fullWidth);
    };
    const observer = new ResizeObserver(update);
    [row, topGroup, ...preceding].forEach(element => observer.observe(element));
    update();
    return () => observer.disconnect();
  }, [showMixedEngines, canGoForward, portraitTab, isTrainingActive, isExampleReplayActive]);
  useLayoutEffect(() => {
    const row = moveToolbarRef.current;
    const forward = portraitForwardRef.current;
    if (!row || !forward || !window.matchMedia('(orientation: portrait)').matches) {
      setHidePortraitForward(false);
      return;
    }
    const update = () => {
      const style = getComputedStyle(row);
      const available = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const children = [...row.children].filter(child => child === forward ||
        (child.getClientRects().length > 0 && getComputedStyle(child).display !== 'none'));
      const width = children.reduce((total, child) => {
        const childStyle = getComputedStyle(child);
        return total + child.getBoundingClientRect().width +
          (child.classList.contains('arrow-toggle-group') ? 0 : (parseFloat(childStyle.marginLeft) || 0)) +
          (parseFloat(childStyle.marginRight) || 0);
      }, 0) + Math.max(0, children.length - 1) * parseFloat(style.columnGap);
      setHidePortraitForward(width > available + 1);
    };
    const observer = new ResizeObserver(update);
    [row, ...row.children].forEach(element => observer.observe(element));
    update();
    return () => observer.disconnect();
  }, [canGoForward, portraitTab, isTrainingActive, isExampleReplayActive, showMixedEngines]);
  const displayedBookMoves = useMemo(
    () => findBookMovesForGame(displayedMovePath, bookRepertoireIndex),
    [displayedMovePath, bookRepertoireIndex],
  );
  const getMoveStatus = useCallback((node: MoveNode) => {
    const parent = node.parentId ? tree.nodes[node.parentId] : undefined;
    if (isBrowseMode || !node.moveUci || !parent || !parent.children.includes(node.id) || toTurnColor(parent.fen) !== activeSide) return undefined;
    return repertoireMoveStatus(tree, parent, node);
  }, [tree, isBrowseMode, activeSide]);
  const inlineMoves = useMemo(
    () =>
      displayedMovePath.slice(1).map((node, index) => {
        const result = gameAnalysisReportMatchesLine ? gameAnalysisReport?.results.find((entry) => entry.nodeId === node.id) : undefined;
        const bookMove = displayedBookMoves.get(node.id);
        const annotation = result?.status === 'book'
          ? ''
          : result?.status === 'uncertain'
          ? ''
          : result?.status !== 'complete'
            ? ''
            : result.greatFind ? '!' : result.category === 'inaccuracy'
              ? '?!'
                : result.category === 'mistake'
                  ? '?'
                  : result.category === 'blunder'
                    ? '??'
                    : '';
        const categoryClass = result?.status === 'book' || (!result && bookMove)
          ? 'book'
          : result?.status === 'complete'
            ? (result.greatFind ? 'excellent' : result.category === 'excellent' ? 'good' : result.category)
            : result?.status === 'uncertain'
              ? 'provisional'
              : '';
        const annotationTitle = result?.status === 'book'
          ? undefined
          : result
            ? `${result.status === 'uncertain' ? 'Classification uncertain' : result.category}${result.lossPoints === null ? '' : ` — ${result.lossPoints.toFixed(1)} evaluation-impact points lost`}`
            : undefined;
        return {
        id: node.id,
        san: toFigurineSan(node.moveSan ?? ''),
        prefix: fenToChess(displayedMovePath[index].fen).turn() === 'w' || index === 0
          ? formatMovePrefix(fenToChess(displayedMovePath[index].fen)) : '',
        hasAlternatives: (node.children?.length ?? 0) > 1,
        moveStatus: getMoveStatus(node),
        comment: node.comment,
        missedInGames: repertoireDeviations?.has(bookPositionFenKey(displayedMovePath[index].fen)) ?? false,
        annotation,
        annotationTitle,
        categoryClass,
        maiaBaselineTag: result?.maiaBaselineTag ?? null,
        selected: selectedNode.id === node.id,
      };
      }),
    [displayedMovePath, displayedBookMoves, gameAnalysisReportMatchesLine, gameAnalysisReport, selectedNode.id, repertoireDeviations, getMoveStatus],
  );
  useLayoutEffect(() => {
    if (!isBrowseMode || isTrainingActive || analysisGameProgress) return;
    const container = moveNotationRef.current;
    if (!container) return;

    const revealSelectedMove = () => {
      if (container.clientHeight === 0) return;
      const selected = selectedMoveButtonRef.current;
      if (!selected) {
        if (selectedNode.id === tree.rootId) container.scrollTop = 0;
        return;
      }

      const selectedRect = selected.getBoundingClientRect();
      const moveRects = Array.from(container.querySelectorAll<HTMLButtonElement>('.move-inline-item'),
        (button) => button.getBoundingClientRect());
      // Flex rows can contain several moves; keep one complete row on each side.
      const previousRow = moveRects.filter((rect) => rect.top < selectedRect.top - 1).at(-1);
      const nextRow = moveRects.find((rect) => rect.top > selectedRect.top + 1);
      const contextTop = (previousRow?.top ?? selectedRect.top) - 4;
      const contextBottom = (nextRow?.bottom ?? selectedRect.bottom) + 4;
      const viewportTop = container.getBoundingClientRect().top + container.clientTop;
      const viewportBottom = viewportTop + container.clientHeight;

      if (contextBottom - contextTop > container.clientHeight) {
        // A short list viewport may only fit the selected row and partial context.
        container.scrollTop += (selectedRect.top + selectedRect.bottom - viewportTop - viewportBottom) / 2;
      } else if (contextTop < viewportTop) {
        container.scrollTop += contextTop - viewportTop;
      } else if (contextBottom > viewportBottom) {
        container.scrollTop += contextBottom - viewportBottom;
      }
    };

    revealSelectedMove();
    const observer = new ResizeObserver(revealSelectedMove);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [isBrowseMode, isTrainingActive, analysisGameProgress, inlineMoves, selectedNode.id, tree.rootId]);

  const selectedReportResult = isBrowseMode && gameAnalysisReportMatchesLine
    ? gameAnalysisReport?.results.find((result) => result.nodeId === selectedNode.id) ?? null
    : null;
  const selectedAnalysisResult = selectedReportResult?.status === 'book' ? null : selectedReportResult;
  const selectedReportParent = selectedReportResult?.nodeId
    ? tree.nodes[selectedReportResult.nodeId]?.parentId
      ? tree.nodes[tree.nodes[selectedReportResult.nodeId].parentId as string]
      : null
    : null;
  const selectedAnalysisParent = selectedAnalysisResult ? selectedReportParent : null;
  const selectedAnalysisBestMove = selectedAnalysisResult?.bestMoveUci && selectedAnalysisParent
    ? uciToFigurineSan(selectedAnalysisParent.fen, selectedAnalysisResult.bestMoveUci)
    : null;

  const optionRows = useMemo(() => {
    if (isBrowseMode) {
      return browseMoveOptions.map((option) => ({
        node: {
          id: `browse-option-${option.moveUci}`,
          parentId: selectedNode.id,
          fen: selectedNode.fen,
          moveSan: option.moveSan,
          moveUci: option.moveUci,
          children: [],
        } as MoveNode,
        leaves: option.repertoireNames.length,
        moveStatus: undefined,
      }));
    }

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

    return childNodes.map(node => ({ node, leaves: countLeaves(node.id), moveStatus: getMoveStatus(node) }));
  }, [
    isBrowseMode,
    browseMoveOptions,
    selectedNode.id,
    selectedNode.fen,
    childNodes,
    tree.nodes,
    getMoveStatus,
  ]);

  const clearTreeOptionLongPress = () => {
    if (treeOptionLongPressTimeoutRef.current !== null) {
      window.clearTimeout(treeOptionLongPressTimeoutRef.current);
      treeOptionLongPressTimeoutRef.current = null;
    }
  };

  const getDeletePopupPosition = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const rawX = rect.left + rect.width / 2;
    const rawY = rect.bottom + 8;
    const horizontalPadding = Math.min(110, window.innerWidth / 2);
    const x = Math.max(horizontalPadding, Math.min(rawX, window.innerWidth - horizontalPadding));
    const y = Math.max(8, Math.min(rawY, window.innerHeight - 210));
    return { x, y };
  };

  const handleTreeOptionPointerDown = (node: MoveNode, event: PointerEvent<HTMLButtonElement>) => {
    if (!isBrowseMode && !tree.nodes[node.id]) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearTreeOptionLongPress();
    treeOptionLongPressHandledNodeRef.current = null;
    const { x, y } = getDeletePopupPosition(event.currentTarget);
    treeOptionLongPressTimeoutRef.current = globalThis.setTimeout(() => {
      treeOptionLongPressHandledNodeRef.current = node.id;
      setTreeOptionDeletePopup(
        isBrowseMode && node.moveUci
          ? { nodeId: node.id, moveUci: node.moveUci, fenKey: positionFenKey(selectedNode.fen), x, y, openedAt: Date.now() }
          : { nodeId: node.id, x, y, openedAt: Date.now() },
      );
    }, 320);
  };

  const handleTreeOptionMouseDown = (node: MoveNode, event: MouseEvent<HTMLButtonElement>) => {
    if (!isBrowseMode && !tree.nodes[node.id]) return;
    if ('PointerEvent' in window) return;
    if (event.button !== 0) return;
    clearTreeOptionLongPress();
    treeOptionLongPressHandledNodeRef.current = null;
    const { x, y } = getDeletePopupPosition(event.currentTarget);
    treeOptionLongPressTimeoutRef.current = globalThis.setTimeout(() => {
      treeOptionLongPressHandledNodeRef.current = node.id;
      setTreeOptionDeletePopup(
        isBrowseMode && node.moveUci
          ? { nodeId: node.id, moveUci: node.moveUci, fenKey: positionFenKey(selectedNode.fen), x, y, openedAt: Date.now() }
          : { nodeId: node.id, x, y, openedAt: Date.now() },
      );
    }, 320);
  };

  const handleTreeOptionTouchStart = (node: MoveNode, event: TouchEvent<HTMLButtonElement>) => {
    if (!isBrowseMode && !tree.nodes[node.id]) return;
    if ('PointerEvent' in window) return;
    clearTreeOptionLongPress();
    treeOptionLongPressHandledNodeRef.current = null;
    const { x, y } = getDeletePopupPosition(event.currentTarget);
    treeOptionLongPressTimeoutRef.current = globalThis.setTimeout(() => {
      treeOptionLongPressHandledNodeRef.current = node.id;
      setTreeOptionDeletePopup(
        isBrowseMode && node.moveUci
          ? { nodeId: node.id, moveUci: node.moveUci, fenKey: positionFenKey(selectedNode.fen), x, y, openedAt: Date.now() }
          : { nodeId: node.id, x, y, openedAt: Date.now() },
      );
    }, 320);
  };

  const openTreeOptionDeleteFromContextMenu = (node: MoveNode, element: HTMLButtonElement) => {
    if (!isBrowseMode && !tree.nodes[node.id]) return;
    const { x, y } = getDeletePopupPosition(element);
    treeOptionLongPressHandledNodeRef.current = node.id;
    setTreeOptionDeletePopup(
      isBrowseMode && node.moveUci
        ? { nodeId: node.id, moveUci: node.moveUci, fenKey: positionFenKey(selectedNode.fen), x, y, openedAt: Date.now() }
        : { nodeId: node.id, x, y, openedAt: Date.now() },
    );
  };

  const handleTreeOptionPointerEnd = () => {
    clearTreeOptionLongPress();
  };

  const handleTreeOptionClick = (node: MoveNode, event: MouseEvent<HTMLButtonElement>) => {
    if (treeOptionLongPressHandledNodeRef.current === node.id) {
      event.preventDefault();
      treeOptionLongPressHandledNodeRef.current = null;
      return;
    }
    if (isBrowseMode) {
      if (node.moveUci) playSuggestedMove(node.moveUci);
      return;
    }
    if (!tree.nodes[node.id]) {
      if (node.moveUci) playSuggestedMove(node.moveUci);
      return;
    }
    navigateToNode(activeSide, node.id);
  };

  const clearInlineMoveLongPress = () => {
    if (inlineMoveLongPressTimeoutRef.current !== null) {
      window.clearTimeout(inlineMoveLongPressTimeoutRef.current);
      inlineMoveLongPressTimeoutRef.current = null;
    }
  };

  const handleInlineMovePointerDown = (nodeId: string, event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearInlineMoveLongPress();
    inlineMoveLongPressHandledNodeRef.current = null;
    const { x, y } = getDeletePopupPosition(event.currentTarget);
    inlineMoveLongPressTimeoutRef.current = globalThis.setTimeout(() => {
      inlineMoveLongPressHandledNodeRef.current = nodeId;
      setTreeOptionDeletePopup({ nodeId, x, y, openedAt: Date.now() });
    }, 320);
  };

  const handleInlineMovePointerEnd = () => {
    clearInlineMoveLongPress();
  };

  const openInlineMoveContextMenu = (nodeId: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    clearInlineMoveLongPress();
    const { x, y } = getDeletePopupPosition(event.currentTarget);
    setTreeOptionDeletePopup({ nodeId, x, y, openedAt: Date.now() });
  };

  const handleInlineMoveClick = (moveId: string, event: MouseEvent<HTMLButtonElement>) => {
    if (inlineMoveLongPressHandledNodeRef.current === moveId) {
      event.preventDefault();
      inlineMoveLongPressHandledNodeRef.current = null;
      return;
    }
    navigateToNode(activeSide, moveId);
  };

  const deleteTreeOptionBranch = () => {
    if (isReadOnlyRepertoire) {
      setTreeOptionDeletePopup(null);
      return;
    }
    const popup = treeOptionDeletePopup;
    if (!popup) return;
    const nodeId = popup.nodeId;
    if (isTrainingActive) return;
    if (popup.moveUci && popup.fenKey) {
      const moveUci = popup.moveUci;
      const targetFenKey = popup.fenKey;
      if (!moveUci) {
        setTreeOptionDeletePopup(null);
        return;
      }
      setRepertoiresBySide((prev) => {
        const nextSideList = prev[activeSide].map((entry) => {
          if (!entry.enabled) return entry;
          let nextTree = entry.tree;
          let changed = false;
          while (true) {
            let branchRootId: string | null = null;
            for (const node of Object.values(nextTree.nodes)) {
              if (positionFenKey(node.fen) !== targetFenKey) continue;
              const childId = node.children.find((id) => nextTree.nodes[id]?.moveUci === moveUci);
              if (childId) {
                branchRootId = childId;
                break;
              }
            }
            if (!branchRootId) break;
            nextTree = removeBranch(nextTree, branchRootId);
            changed = true;
          }
          if (!changed) return entry;
          return {
            ...entry,
            tree: nextTree,
            selectedNodeId: nextTree.nodes[entry.selectedNodeId] ? entry.selectedNodeId : nextTree.rootId,
          };
        });
        return {
          ...prev,
          [activeSide]: nextSideList,
        };
      });
      setTreeOptionDeletePopup(null);
      return;
    }
    if (!nodeId) {
      setTreeOptionDeletePopup(null);
      return;
    }
    const currentTree = trees[activeSide];
    const branchRoot = currentTree.nodes[nodeId];
    if (!branchRoot) return;
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const fallbackId = branchRoot.parentId ?? currentTree.rootId;
    const nextTree = removeBranch(currentTree, nodeId);
    const nextSelectedId = nextTree.nodes[currentSelectedId]
      ? currentSelectedId
      : nextTree.nodes[fallbackId]
        ? fallbackId
        : nextTree.rootId;

    setUndoStackBySide((prev) => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree: currentTree, selectedNodeId: currentSelectedId }].slice(-200),
    }));
    setTrees((prev) => ({ ...prev, [activeSide]: nextTree }));
    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: nextSelectedId }));
    setTreeOptionDeletePopup(null);
  };

  const updateMoveTree = (nextTree: MoveTree) => {
    if (nextTree === tree || trainingSession || isTreeEvalRunning || isReadOnlyRepertoire) return;
    setUndoStackBySide(prev => ({
      ...prev,
      [activeSide]: [...prev[activeSide], { tree, selectedNodeId: selectedNode.id }].slice(-200),
    }));
    setTrees(prev => ({ ...prev, [activeSide]: nextTree }));
  };

  const menuNode = treeOptionDeletePopup?.nodeId && !treeOptionDeletePopup.moveUci
    ? tree.nodes[treeOptionDeletePopup.nodeId] : undefined;
  const menuMoveStatus = menuNode ? getMoveStatus(menuNode) : undefined;
  const changeMoveStatus = (status: RepertoireMoveStatus) => {
    if (menuNode && menuMoveStatus) updateMoveTree(setRepertoireMoveStatus(tree, menuNode.id, status));
    setTreeOptionDeletePopup(null);
  };
  const saveMoveComment = () => {
    if (!moveCommentEditor) return;
    if (!isEditingRepertoire) {
      setMoveCommentEditor(null);
      return;
    }
    const node = tree.nodes[moveCommentEditor.nodeId];
    const comment = moveCommentEditor.draft.trim() || undefined;
    if (node && node.comment !== comment) updateMoveTree({ ...tree, nodes: { ...tree.nodes, [node.id]: { ...node, comment } } });
    setMoveCommentEditor(null);
  };

  const trainingTotalLines = useMemo(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return 0;
    const sideTree = trees[trainingSession.side];
    const root = sideTree.nodes[trainingSession.rootNodeId];
    if (!root) return 0;

    const countLeavesInTree = (treeToCount: MoveTree, nodeId: string, memo: Map<string, number>): number => {
      const cached = memo.get(nodeId);
      if (cached !== undefined) return cached;
      const node = treeToCount.nodes[nodeId];
      if (!node) return 0;
      const children = trainingMoveIds(treeToCount, node, toTurnColor(node.fen) === trainingSession.side, trainAlternativeMoves);
      const value =
        children.length === 0
          ? 1
          : children.reduce((acc, childId) => acc + countLeavesInTree(treeToCount, childId, memo), 0);
      memo.set(nodeId, value);
      return value;
    };

    if (!isBrowseMode) {
      return countLeavesInTree(sideTree, root.id, new Map<string, number>());
    }

    const rootFenKey = positionFenKey(root.fen);
    return enabledRepertoiresBySide[trainingSession.side]
      .filter((repertoire) => repertoireHasMoves(repertoire.tree))
      .reduce((repoSum, repertoire) => {
        const memo = new Map<string, number>();
        const matchingNodes = Object.values(repertoire.tree.nodes).filter(
          (node) => positionFenKey(node.fen) === rootFenKey,
        );
        if (matchingNodes.length === 0) return repoSum;
        const leavesFromRepo = matchingNodes.reduce(
          (acc, node) => acc + countLeavesInTree(repertoire.tree, node.id, memo),
          0,
        );
        return repoSum + leavesFromRepo;
      }, 0);
  }, [trainingSession, activeSide, trees, isBrowseMode, enabledRepertoiresBySide, trainAlternativeMoves]);

  const trainingAnsweredLines = useMemo(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return 0;
    return new Set(trainingSession.completedLeafNodeIds).size;
  }, [trainingSession, activeSide]);
  const hasTrainingContent = useMemo(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return false;
    return hasSideTrainingContent(trainingSession.side);
  }, [trainingSession, activeSide, hasSideTrainingContent]);
  const showTrainingContinue = isTrainingActive &&
    isTrainingLineEnd &&
    hasTrainingContent &&
    trainingAnsweredLines < trainingTotalLines &&
    !trainingSession?.flashcardMode &&
    !trainingSession?.suddenDeathMode;
  const trainingCorrectCount = trainingSession?.side === activeSide ? trainingSession.correctCount : 0;
  const trainingErrorCount = trainingSession?.side === activeSide ? trainingSession.errorCount : 0;
  const trainingAttemptCount = trainingCorrectCount + trainingErrorCount;
  const trainingSessionSuccessPct = trainingAttemptCount > 0 ? Math.round((trainingCorrectCount / trainingAttemptCount) * 100) : 0;
  const trainingProgressPct = trainingTotalLines > 0 ? Math.round((trainingAnsweredLines / trainingTotalLines) * 100) : 0;
  const trainingPositionSuccessPct = useMemo(() => {
    if (!isTrainingActive) return 0;
    const sideStats = trainingStatsBySide[activeSide] ?? {};
    const fenKey = positionFenKey(selectedNode.fen);
    const scopeId = isBrowseMode || !activeRepertoireId ? TRAINING_SCOPE_WHOLE_DB : `repo:${activeRepertoireId}`;
    const recentAnswers = sideStats[scopeId]?.[fenKey]?.recentAnswers ?? [];
    if (recentAnswers.length === 0) return 0;
    const correct = recentAnswers.reduce((acc, value) => acc + (value ? 1 : 0), 0);
    return Math.round((correct / recentAnswers.length) * 100);
  }, [isTrainingActive, trainingStatsBySide, activeSide, selectedNode.fen, isBrowseMode, activeRepertoireId]);
  const trainingRepoOverallSuccessPct = useMemo(() => {
    if (!isTrainingActive || !activeRepertoireId || !activeRepertoire) return null;
    const sideStats = trainingStatsBySide[activeSide] ?? {};
    const scopeId = `repo:${activeRepertoireId}`;
    const scopeStats = sideStats[scopeId] ?? {};
    const nodes = Object.values(activeRepertoire.tree.nodes);
    if (nodes.length === 0) return 0;
    const avgRate =
      nodes.reduce((acc, node) => {
        const recentAnswers = scopeStats[positionFenKey(node.fen)]?.recentAnswers ?? [];
        if (recentAnswers.length === 0) return acc;
        const correct = recentAnswers.reduce((sum, value) => sum + (value ? 1 : 0), 0);
        return acc + correct / recentAnswers.length;
      }, 0) / nodes.length;
    return Math.round(avgRate * 100);
  }, [isTrainingActive, activeRepertoireId, activeRepertoire, trainingStatsBySide, activeSide]);
  const trainingHintMoveText = useMemo(() => {
    if (!isTrainingActive || !trainingSession?.hintMoveUci) return '';
    return uciToFigurineSan(selectedNode.fen, trainingSession.hintMoveUci) || trainingSession.hintMoveUci;
  }, [isTrainingActive, trainingSession?.hintMoveUci, selectedNode.fen]);

  useEffect(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return;
    if (!isTrainingLineEnd) return;
    const sideTree = trees[trainingSession.side];
    const currentNode = sideTree.nodes[selectedNode.id];
    if (!currentNode) return;
    const scopeId = getActiveTrainingStatsScopeId(activeSide);
    const leafKey = getTrainingLeafKey(currentNode);
    const shownAt = Date.now();
    setTrainingLeafLastShownBySide((prev) => {
      const sideEntries = prev[activeSide];
      const scopeEntries = sideEntries[scopeId] ?? {};
      if (scopeEntries[leafKey] === shownAt) return prev;
      return {
        ...prev,
        [activeSide]: {
          ...sideEntries,
          [scopeId]: {
            ...scopeEntries,
            [leafKey]: shownAt,
          },
        },
      };
    });
    // If this leaf hasn't been recorded as completed in this session yet,
    // append a training answer indicating whether it was reached without errors.
    const alreadyCompleted = trainingSession.completedLeafNodeIds.includes(currentNode.id);
    if (!alreadyCompleted) {
      const scopeIds =
        trainingSession.currentPromptScopeIds && trainingSession.currentPromptScopeIds.length > 0
          ? trainingSession.currentPromptScopeIds
          : getScopeIdsForTrainingPosition(activeSide, currentNode.fen);
      const answer: 0 | 1 = trainingSession.currentPromptHadError ? 0 : 1;
      appendTrainingAnswer(activeSide, currentNode.fen, scopeIds, answer);
    }

    setTrainingSession((prev) => {
      if (!prev || prev.side !== activeSide) return prev;
      if (prev.completedLeafNodeIds.includes(currentNode.id)) return prev;
      return {
        ...prev,
        completedLeafNodeIds: [...prev.completedLeafNodeIds, currentNode.id],
      };
    });
  }, [trainingSession, activeSide, isTrainingLineEnd, selectedNode.id, trees, isBrowseMode, activeRepertoireIdBySide]);

  const collectTreeEvalTargets = (onlyMissing: boolean): Array<{ repoId: string | null; nodeId: string; fen: string }> => {
    const hasEval = (node: MoveNode) => typeof node.stockfishEval === 'string' && node.stockfishEval.trim().length > 0;
    if (isBrowseMode) {
      return enabledRepertoiresBySide[activeSide].flatMap((repertoire) =>
        Object.values(repertoire.tree.nodes)
          .filter((node) => !onlyMissing || !hasEval(node))
          .map((node) => ({ repoId: repertoire.id, nodeId: node.id, fen: node.fen })),
      );
    }
    return Object.values(trees[activeSide].nodes)
      .filter((node) => !onlyMissing || !hasEval(node))
      .map((node) => ({ repoId: null, nodeId: node.id, fen: node.fen }));
  };

  const applyTreeEvalToTargets = (targets: Array<{ repoId: string | null; nodeId: string }>, scoreText: string) => {
    const side = activeSide;
    const directNodeIds = targets.filter((target) => target.repoId === null).map((target) => target.nodeId);
    if (directNodeIds.length > 0) {
      const nodeIdSet = new Set(directNodeIds);
      setTrees((prev) => {
        const currentTree = prev[side];
        const nextNodes = { ...currentTree.nodes };
        let changed = false;
        nodeIdSet.forEach((nodeId) => {
          const node = nextNodes[nodeId];
          if (!node) return;
          if (node.stockfishEval === scoreText) return;
          nextNodes[nodeId] = { ...node, stockfishEval: scoreText };
          changed = true;
        });
        if (!changed) return prev;
        return {
          ...prev,
          [side]: {
            ...currentTree,
            nodes: nextNodes,
          },
        };
      });
    }

    const byRepo = new Map<string, string[]>();
    targets.forEach((target) => {
      if (!target.repoId) return;
      const existing = byRepo.get(target.repoId) ?? [];
      existing.push(target.nodeId);
      byRepo.set(target.repoId, existing);
    });
    if (byRepo.size > 0) {
      setRepertoiresBySide((prev) => {
        const list = prev[side];
        let changedAny = false;
        const nextList = list.map((entry) => {
          const targetNodeIds = byRepo.get(entry.id);
          if (!targetNodeIds || targetNodeIds.length === 0) return entry;
          const targetSet = new Set(targetNodeIds);
          const nextNodes = { ...entry.tree.nodes };
          let changed = false;
          targetSet.forEach((nodeId) => {
            const node = nextNodes[nodeId];
            if (!node) return;
            if (node.stockfishEval === scoreText) return;
            nextNodes[nodeId] = { ...node, stockfishEval: scoreText };
            changed = true;
          });
          if (!changed) return entry;
          changedAny = true;
          return {
            ...entry,
            tree: {
              ...entry.tree,
              nodes: nextNodes,
            },
          };
        });
        if (!changedAny) return prev;
        return {
          ...prev,
          [side]: nextList,
        };
      });
    }
  };

  const fetchLichessCloudEval = async (fen: string): Promise<string | null> => {
    const normalizedFen = fen === START_FEN ? new Chess().fen() : fen;
    const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(normalizedFen)}&multiPv=1`;

    for (let attempt = 0; attempt <= CLOUD_EVAL_MAX_RETRIES; attempt += 1) {
      if (treeEvalCancelRef.current) return null;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(response.headers.get('Retry-After')) ??
            CLOUD_EVAL_RETRY_FALLBACK_MS * Math.max(1, attempt + 1);
          if (attempt < CLOUD_EVAL_MAX_RETRIES) {
            await waitMs(retryAfterMs);
            continue;
          }
          return null;
        }
        if (!response.ok) return null;
        const data = (await response.json()) as {
          pvs?: Array<{ cp?: number; mate?: number }>;
          error?: string;
        };
        if (data?.error) return null;
        const first = data?.pvs?.[0];
        if (!first) return null;
        const perspective = whitePerspectiveMultiplierFromFen(normalizedFen);
        if (typeof first.cp === 'number' && Number.isFinite(first.cp)) return formatSignedCp(first.cp * perspective);
        if (typeof first.mate === 'number' && Number.isFinite(first.mate)) return formatSignedMate(first.mate * perspective);
        return null;
      } catch {
        if (attempt < CLOUD_EVAL_MAX_RETRIES) {
          await waitMs(CLOUD_EVAL_RETRY_FALLBACK_MS);
          continue;
        }
        return null;
      } finally {
        window.clearTimeout(timeout);
      }
    }
    return null;
  };

  const runTreeStockfishEval = async () => {
    if (isTreeEvalRunning || playerAssessmentJobRef.current) return;
    const worker = stockfishRef.current;
    if (!worker) return;
    const missingTargets = collectTreeEvalTargets(true);
    if (missingTargets.length === 0) {
      setTreeEvalProgress({
        running: false,
        phase: 'done',
        cloud: { done: 0, total: 0 },
        local: { done: 0, total: 0 },
      });
      return;
    }

    setEngineRunning(false);
    treeEvalCancelRef.current = false;
    pendingAnalysisRef.current = null;
    worker.postMessage('stop');
    setEngineStatus('analyzing');
    setTreeEvalProgress({
      running: true,
      phase: 'cloud',
      cloud: { done: 0, total: missingTargets.length },
      local: { done: 0, total: 0 },
    });

    const byFen = new Map<string, Array<{ repoId: string | null; nodeId: string; fen: string }>>();
    missingTargets.forEach((target) => {
      const fenKey = positionFenKey(target.fen);
      const existing = byFen.get(fenKey) ?? [];
      existing.push(target);
      byFen.set(fenKey, existing);
    });

    const unresolvedFenGroups: Array<Array<{ repoId: string | null; nodeId: string; fen: string }>> = [];
    for (const [fenKey, group] of byFen.entries()) {
      if (treeEvalCancelRef.current) break;
      let scoreText = treeEvalFenCacheRef.current.get(fenKey) ?? null;
      if (!scoreText) {
        scoreText = await fetchLichessCloudEval(group[0].fen);
        if (!treeEvalCancelRef.current) {
          await waitMs(CLOUD_EVAL_MIN_INTERVAL_MS);
        }
      }
      if (scoreText) {
        treeEvalFenCacheRef.current.set(fenKey, scoreText);
        applyTreeEvalToTargets(group, scoreText);
      } else {
        unresolvedFenGroups.push(group);
      }
      setTreeEvalProgress((prev) =>
        prev
          ? {
              ...prev,
              cloud: {
                ...prev.cloud,
                done: Math.min(prev.cloud.total, prev.cloud.done + group.length),
              },
            }
          : prev,
      );
    }

    const localTotal = unresolvedFenGroups.reduce((acc, group) => acc + group.length, 0);
    setTreeEvalProgress((prev) =>
      prev
        ? {
            ...prev,
            phase: 'local',
            local: { done: 0, total: localTotal },
          }
        : prev,
    );

    const waitForReady = async () => {
      const available = () => engineReadyRef.current && !suddenDeathBusyRef.current && !isSearchingRef.current;
      if (available()) return true;
      for (let i = 0; i < 100; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        if (available()) return true;
      }
      return false;
    };

    if (!treeEvalCancelRef.current && localTotal > 0 && selectedEngineRef.current !== 'maia') {
      const ready = await waitForReady();
      if (!ready) {
        setTreeEvalProgress((prev) => (prev ? { ...prev, running: false, phase: 'done' } : prev));
        setEngineStatus('stopped');
        return;
      }
    }

    for (const group of unresolvedFenGroups) {
      if (treeEvalCancelRef.current) break;
      const fenKey = positionFenKey(group[0].fen);
      let scoreText = treeEvalFenCacheRef.current.get(fenKey) ?? null;
      if (!scoreText) {
        const normalizedFen = group[0].fen === START_FEN ? new Chess().fen() : group[0].fen;
        if (selectedEngineRef.current === 'maia') {
          try {
            const maiaEval = await evaluateMaiaPosition({
              fen: normalizedFen,
              eloSelf: maiaStrengthEloRef.current,
              eloOppo: maiaStrengthEloRef.current,
              topK: 1,
            });
            scoreText = formatSignedCp(winProbabilityToCp(maiaEval.winProbability));
          } catch (error) {
            setMaiaTreeStatus(error instanceof Error ? error.message : String(error));
            scoreText = null;
          }
        } else {
          scoreText = await new Promise<string | null>((resolve) => {
            treeEvalAwaiterRef.current = { latestScore: null, resolve };
            engineWhitePerspectiveMultiplierRef.current = whitePerspectiveMultiplierFromFen(normalizedFen);
            worker.postMessage('setoption name MultiPV value 1');
            worker.postMessage('setoption name UCI_LimitStrength value false');
            worker.postMessage(`position fen ${normalizedFen}`);
            worker.postMessage(`go movetime ${stockfishEvalSeconds * 1000}`);
          });
        }
      }
      if (treeEvalCancelRef.current) break;
      if (scoreText) {
        treeEvalFenCacheRef.current.set(fenKey, scoreText);
        applyTreeEvalToTargets(group, scoreText);
      }
      setTreeEvalProgress((prev) =>
        prev
          ? {
              ...prev,
              local: {
                ...prev.local,
                done: Math.min(prev.local.total, prev.local.done + group.length),
              },
            }
          : prev,
      );
    }

    setTreeEvalProgress((prev) => (prev ? { ...prev, running: false, phase: 'done' } : prev));
    setEngineStatus('stopped');
  };

  const clearAllTreeStockfishEvals = () => {
    const side = activeSide;
    treeEvalFenCacheRef.current.clear();
    if (isBrowseMode) {
      setRepertoiresBySide((prev) => {
        const next = prev[side].map((entry) => {
          if (!entry.enabled) return entry;
          const nextNodes: Record<string, MoveNode> = {};
          let changed = false;
          Object.entries(entry.tree.nodes).forEach(([nodeId, node]) => {
            if (node.stockfishEval) {
              nextNodes[nodeId] = { ...node, stockfishEval: null };
              changed = true;
            } else {
              nextNodes[nodeId] = node;
            }
          });
          if (!changed) return entry;
          return {
            ...entry,
            tree: {
              ...entry.tree,
              nodes: nextNodes,
            },
          };
        });
        return {
          ...prev,
          [side]: next,
        };
      });
      return;
    }
    setTrees((prev) => {
      const currentTree = prev[side];
      const nextNodes: Record<string, MoveNode> = {};
      let changed = false;
      Object.entries(currentTree.nodes).forEach(([nodeId, node]) => {
        if (node.stockfishEval) {
          nextNodes[nodeId] = { ...node, stockfishEval: null };
          changed = true;
        } else {
          nextNodes[nodeId] = node;
        }
      });
      if (!changed) return prev;
      return {
        ...prev,
        [side]: {
          ...currentTree,
          nodes: nextNodes,
        },
      };
    });
  };

  const stopTreeStockfishEval = () => {
    if (!isTreeEvalRunning) return;
    treeEvalCancelRef.current = true;
    pendingAnalysisRef.current = null;
    stockfishRef.current?.postMessage('stop');
  };

  const treeEvalScopeStats = useMemo(() => {
    const hasEval = (node: MoveNode) => typeof node.stockfishEval === 'string' && node.stockfishEval.trim().length > 0;
    if (isBrowseMode) {
      const nodes = enabledRepertoiresBySide[activeSide].flatMap((entry) => Object.values(entry.tree.nodes));
      const missing = nodes.reduce((acc, node) => acc + (hasEval(node) ? 0 : 1), 0);
      return { total: nodes.length, missing };
    }
    const nodes = Object.values(trees[activeSide].nodes);
    const missing = nodes.reduce((acc, node) => acc + (hasEval(node) ? 0 : 1), 0);
    return { total: nodes.length, missing };
  }, [isBrowseMode, enabledRepertoiresBySide, trees, activeSide]);

  const dbStatsBySide = useMemo(() => {
    const hasEval = (node: MoveNode) => typeof node.stockfishEval === 'string' && node.stockfishEval.trim().length > 0;
    const summarize = (entry: RepertoireEntry, side: Side) => {
      const nodes = Object.values(entry.tree.nodes);
      const nodeCount = nodes.length;
      const leafCount = nodes.reduce((acc, node) => acc + (node.children.length === 0 ? 1 : 0), 0);
      const missingEvalCount = nodes.reduce((acc, node) => acc + (hasEval(node) ? 0 : 1), 0);
      const scopeId = `repo:${entry.id}`;
      const scopeStats = trainingStatsBySide[side][scopeId] ?? {};
      const scopeLeafLastShown = trainingLeafLastShownBySide[side][scopeId] ?? {};
      const repoFenKeys = new Set(nodes.map((node) => positionFenKey(node.fen)));
      let trainedPositionCount = 0;
      let recentAttemptCount = 0;
      let recentCorrectCount = 0;
      let summedPositionSuccess = 0;
      Object.entries(scopeStats).forEach(([fenKey, stat]) => {
        if (!repoFenKeys.has(fenKey)) return;
        if (stat.recentAnswers.length === 0) return;
        const positionCorrectCount = stat.recentAnswers.reduce((acc, answer) => acc + (answer ? 1 : 0), 0);
        trainedPositionCount += 1;
        recentAttemptCount += stat.recentAnswers.length;
        recentCorrectCount += positionCorrectCount;
        summedPositionSuccess += positionCorrectCount / stat.recentAnswers.length;
      });
      const trainedLineCount = Object.keys(scopeLeafLastShown).length;
      const trainedCoveragePct = leafCount > 0 ? Math.round((trainedLineCount / leafCount) * 100) : 0;
      const recentSuccessPct = recentAttemptCount > 0 ? Math.round((recentCorrectCount / recentAttemptCount) * 100) : null;
      const avgPositionSuccessPct = trainedPositionCount > 0 ? Math.round((summedPositionSuccess / trainedPositionCount) * 100) : null;
      const lastTrainedAt =
        Object.values(scopeLeafLastShown).reduce((latest, value) => (value > latest ? value : latest), 0) || null;
      return {
        id: entry.id,
        name: entry.name,
        nodeCount,
        leafCount,
        missingEvalCount,
        trainedLineCount,
        trainedCoveragePct,
        trainedPositionCount,
        recentAttemptCount,
        recentSuccessPct,
        avgPositionSuccessPct,
        lastTrainedAt,
      };
    };
    return {
      white: repertoiresBySide.white.map((entry) => summarize(entry, 'white')),
      black: repertoiresBySide.black.map((entry) => summarize(entry, 'black')),
    };
  }, [repertoiresBySide, trainingStatsBySide, trainingLeafLastShownBySide]);

  useEffect(() => {
    if (isBrowseMode || lichessSource === 'player') return;
    if (lichessStatus !== 'done' || lichessDataFen !== selectedNode.fen || !lichessData?.moves.length) return;

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
  }, [activeSide, isBrowseMode, lichessData, lichessDataFen, lichessSource, lichessStatus, selectedNode.fen, selectedNodeBySide]);

  const rewindToNode = (targetId: string) => {
    if (isTrainingActive || isSuddenDeathActive) return;
    if (selectedNode.id === targetId) return;
    let branchRoot = selectedNode;
    while (branchRoot.parentId && branchRoot.parentId !== targetId) {
      branchRoot = tree.nodes[branchRoot.parentId];
    }
    if (branchRoot.parentId !== targetId) return;
    navigateToNode(activeSide, targetId);
  };

  const goBackOneMove = () => {
    if (suddenDeathGameOver) {
      selectSuddenDeathPosition(suddenDeathGameOver.index - 1);
      return;
    }
    if (analysisScratchPosition?.enginePreview) {
      setHoveredEngineMove(null);
      setAnalysisScratchPosition(analysisScratchPosition.enginePreview.previous);
      return;
    }
    if (analysisScratchPosition?.playerMoves) {
      backPlayerPreview();
      return;
    }
    if (selectedNode.parentId) rewindToNode(selectedNode.parentId);
  };

  const goBackToPreviousBranchMove = () => {
    if (suddenDeathGameOver) {
      selectSuddenDeathPosition(0);
      return;
    }
    if (isTrainingActive || isSuddenDeathActive) return;
    let cursorId = selectedNode.parentId;
    while (cursorId) {
      const node = tree.nodes[cursorId];
      if (!node) break;
      if (node.children.length > 1) {
        rewindToNode(node.id);
        return;
      }
      cursorId = node.parentId;
    }
    if (selectedNode.id !== tree.rootId) {
      rewindToNode(tree.rootId);
    }
  };

  useEffect(() => {
    // Each hold stage uses the position and tree left by the previous stage.
    backLongPressActionRef.current = (stage) => {
      if (analysisScratchPosition?.enginePreview) {
        setHoveredEngineMove(null);
        setAnalysisScratchPosition(analysisScratchPosition.enginePreview.origin);
        return;
      }
      if (stage === 1) goBackToPreviousBranchMove();
      else rewindToNode(tree.rootId);
    };
  });

  const clearBackLongPress = () => {
    if (backLongPressTimeoutRef.current !== null) {
      window.clearTimeout(backLongPressTimeoutRef.current);
      backLongPressTimeoutRef.current = null;
    }
  };

  const scheduleBackLongPressStage = () => {
    clearBackLongPress();
    if (!backLongPressIsDownRef.current) return;
    if (backLongPressStageRef.current === 0) {
      backLongPressTimeoutRef.current = window.setTimeout(() => {
        if (!backLongPressIsDownRef.current) return;
        backLongPressHandledRef.current = true;
        backLongPressStageRef.current = 1;
        backLongPressActionRef.current(1);
        if (!analysisScratchPosition?.enginePreview && !suddenDeathGameOver) scheduleBackLongPressStage();
      }, 450);
      return;
    }
    if (backLongPressStageRef.current === 1) {
      backLongPressTimeoutRef.current = window.setTimeout(() => {
        if (!backLongPressIsDownRef.current) return;
        backLongPressHandledRef.current = true;
        backLongPressStageRef.current = 2;
        backLongPressActionRef.current(2);
      }, 800);
    }
  };

  const handleBackPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    backLongPressIsDownRef.current = true;
    backLongPressStageRef.current = 0;
    backLongPressHandledRef.current = false;
    scheduleBackLongPressStage();
  };

  const handleBackPointerEnd = () => {
    backLongPressIsDownRef.current = false;
    backLongPressStageRef.current = 0;
    clearBackLongPress();
  };

  const handleBackClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (backLongPressHandledRef.current) {
      event.preventDefault();
      backLongPressHandledRef.current = false;
      return;
    }
    goBackOneMove();
  };

  const handleBackContextMenu: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    if (isTouchContextMenu(event.nativeEvent) || !canGoBack) return;
    handleBackPointerEnd();
    goBackToPreviousBranchMove();
  };

  const goForward = (toEnd = false) => {
    if (!canGoForward || isTreeEvalRunning) return;
    const nextNode = displayedMovePath[toEnd ? displayedMovePath.length - 1 : selectedMoveIndex + 1];
    navigateToNode(activeSide, nextNode.id);
  };

  const clearForwardLongPress = () => {
    if (forwardLongPressTimeoutRef.current !== null) {
      window.clearTimeout(forwardLongPressTimeoutRef.current);
      forwardLongPressTimeoutRef.current = null;
    }
  };

  useEffect(() => clearForwardLongPress, [activeSide, selectedNode.id, tree, isTreeEvalRunning, canGoForward]);

  const handleForwardPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearForwardLongPress();
    forwardLongPressHandledRef.current = false;
    forwardLongPressTimeoutRef.current = window.setTimeout(() => {
      forwardLongPressTimeoutRef.current = null;
      forwardLongPressHandledRef.current = true;
      goForward(true);
    }, 450);
  };

  const handleForwardClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (forwardLongPressHandledRef.current) {
      forwardLongPressHandledRef.current = false;
      if (event.detail !== 0) {
        event.preventDefault();
        return;
      }
    }
    goForward();
  };

  const handleForwardContextMenu: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    if (isTouchContextMenu(event.nativeEvent)) return;
    clearForwardLongPress();
    goForward(true);
  };

  const trainButtonMenu = useLongPressMenu(() => {
    setIsTrainingStatsMenuOpen(true);
  }, () => startTraining());

  const suddenDeathMenu = useLongPressMenu(() => {
    setPortraitTab('moves');
    setIsSuddenDeathSettingsOpen(true);
    setIsTrainingStatsMenuOpen(false);
  }, toggleSuddenDeathMode, 420);
  const lichessArrowMenu = useLongPressMenu(
    () => setIsLichessArrowOptionsOpen(true),
    () => setShowLichessArrows(prev => !prev),
    420,
  );
  const findMissingMenu = useLongPressMenu(
    () => setIsFindMissingOptionsOpen(true),
    () => {
      if (opponentReviewOpen) setPortraitTab('lichess');
      else if (canRunFindMissingSearch) void jumpToNextMissingLichessMove();
    },
    420,
  );
  const lichessTabMenu = useLongPressMenu(
    () => setIsLichessFilterOpen(true),
    () => setPortraitTab('lichess'),
    420,
  );
  const aiTabMenu = useLongPressMenu(
    () => setIsStockfishQuickOpen(true),
    () => setPortraitTab('stockfish'),
    420,
  );

  useEffect(
    () => () => {
      clearBackLongPress();
      clearTreeOptionLongPress();
      clearInlineMoveLongPress();
    },
    [],
  );

  const navigateToNode = useCallback((side: Side, nextId: string) => {
    if (suddenDeathGameOver || trainingSession?.side === side) return;
    setAnalysisScratchPosition(null);
    setEngineLines([]);
    lineCacheRef.current = new Map();
    const currentId = selectedNodeBySide[side] ?? trees[side].rootId;
    if (currentId === nextId) return;
    setUndoStackBySide((prev) => ({
      ...prev,
      [side]: [...prev[side], { tree: trees[side], selectedNodeId: currentId }].slice(-200),
    }));
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: nextId }));
  }, [suddenDeathGameOver, trainingSession, selectedNodeBySide, trees]);

  useEffect(() => {
    if (displayedOpponentFindingRef.current === opponentFinding) return;
    displayedOpponentFindingRef.current = opponentFinding;
    if (!opponentFinding) return;
    setAnalysisScratchPosition(null);
    if (!isBrowseMode && opponentFinding.node.id !== selectedNode.id) {
      findMissingSearchAutoNavigationRef.current = true;
      navigateToNode(activeSide, opponentFinding.node.id);
    }
  }, [activeSide, isBrowseMode, navigateToNode, opponentFinding, selectedNode.id]);

  const undoNavigation = () => {
    if (isTrainingActive || isSuddenDeathActive) return;
    const stack = undoStackBySide[activeSide];
    if (stack.length === 0) return;

    const nextStack = [...stack];
    const snapshot = nextStack.pop();
    if (!snapshot) return;

    setUndoStackBySide((prev) => ({ ...prev, [activeSide]: nextStack }));
    setTrees((prev) => ({ ...prev, [activeSide]: snapshot.tree }));
    setSelectedNodeBySide((prev) => ({ ...prev, [activeSide]: snapshot.selectedNodeId }));
  };

  const isTreeBoard = !trainingSession && !hasExampleReplayBoardOverride && !suddenDeathGameOver &&
    !analysisScratchPosition && !browseMistakePosition && !browseOpponentPosition;
  const canAnnotateBoard = hasHydratedAppState && isTreeBoard && !isGameReviewRunning && !isTreeEvalRunning && !isReadOnlyRepertoire;
  const annotationPositionKey = `${activeSide}|${positionFenKey(selectedNode.fen)}`;
  const annotationTarget = JSON.stringify([activeRepertoireId, selectedNode.id, annotationPositionKey]);
  const savedAnnotations = isTreeBoard ? (isBrowseMode ? browseAnnotations[annotationPositionKey] ?? []
    : readBoardAnnotations(selectedNode.annotations)) : [];
  const isDrawingAnnotations = canAnnotateBoard && drawingTarget === annotationTarget;

  useEffect(() => {
    setDrawingTarget(target => canAnnotateBoard && target === annotationTarget ? target : null);
  }, [annotationTarget, canAnnotateBoard]);

  const toggleAnnotationDrawing = () => {
    if (!canAnnotateBoard) return;
    setHoveredEngineMove(null);
    setDrawingTarget(isDrawingAnnotations ? null : annotationTarget);
  };

  const saveAnnotations = (shapes: BoardAnnotation[]) => {
    if (!canAnnotateBoard) return;
    if (isBrowseMode) {
      setBrowseAnnotations(previous => {
        const next = { ...previous };
        if (shapes.length) next[annotationPositionKey] = shapes;
        else delete next[annotationPositionKey];
        return next;
      });
    } else {
      const annotatedNode = { ...selectedNode, annotations: shapes.length ? shapes : undefined };
      updateMoveTree({ ...tree, nodes: { ...tree.nodes, [annotatedNode.id]: annotatedNode } });
    }
  };

  const movesTabDrawing = useLongPressAction(toggleAnnotationDrawing, () => setPortraitTab('moves'), 420);
  const canPlayEngineMove = !isTrainingActive && !hasExampleReplayBoardOverride && !hasSuddenDeathBoardOverride &&
    !suddenDeathGameOver && !isDrawingAnnotations;
  const renderEngineMove = (move: ReturnType<typeof buildEnginePvMoves>[number] | undefined,
    className = '', action?: 'play' | 'preview', key?: number) => {
    if (!move) return <span>—</span>;
    const preview = {
      className: `engine-pv-move ${className}`,
      onMouseEnter: () => setHoveredEngineMove({ fen: move.fen, lastMove: move.lastMove }),
      onMouseLeave: () => setHoveredEngineMove(null),
    };
    const previewTitle = `Show position after ${move.san}`;
    return action ? (
      <button key={key} type="button" {...preview} title={action === 'play' ? `Play ${move.san}` : previewTitle} onClick={() => {
        setHoveredEngineMove(null);
        if (action === 'play') playSuggestedMove(move.uci);
        else openEnginePreview(move);
      }}>{move.san}</button>
    ) : <span key={key} {...preview} title={previewTitle}>{move.san}</span>;
  };

  const renderEngineContinuation = (moves: ReturnType<typeof buildEnginePvMoves>) => (
    <div className="engine-pv-moves">
      {moves.slice(1).map((move, index) => renderEngineMove(move, '', canPlayEngineMove ? 'preview' : undefined, index))}
    </div>
  );
  const reviewEvaluation = suddenDeathReviewPosition?.evaluation;
  const liveReviewLine = suddenDeathReviewPosition && !suddenDeathReviewPosition.terminal && engineRunning && selectedEngine === 'stockfish' &&
    stockfishLinesFen === suddenDeathReviewPosition.fen ? engineLines[0] : undefined;
  const reviewScore = liveReviewLine?.scoreText ?? (reviewEvaluation?.hasScore ? reviewEvaluation.scoreText : null);
  const reviewPv = liveReviewLine?.pv || reviewEvaluation?.pv || reviewEvaluation?.bestMove || '';
  const reviewPvMoves = suddenDeathReviewPosition && reviewPv ? buildEnginePvMoves(suddenDeathReviewPosition.fen, reviewPv) : [];
  const boardPreview = !hasExampleReplayBoardOverride && !hasSuddenDeathBoardOverride && !isDrawingAnnotations ? hoveredEngineMove : null;
  const activeMoveComment = !suddenDeathGameOver && selectedNode.comment && boardFen === selectedNode.fen && !analysisScratchFen
    ? <p className="active-move-comment">
        {selectedNode.moveSan && <><strong>{toFigurineSan(selectedNode.moveSan)}</strong>{' '}</>}
        {renderCommentText(selectedNode.comment)}
      </p>
    : null;
  const suddenDeathReviewPanel = suddenDeathGameOver && (
    <>
      <div className="controls-row sudden-death-review-controls">
        <strong>Sudden Death review</strong>
        <button type="button" onClick={finishSuddenDeathReview}>Finish review</button>
      </div>
      {suddenDeathGameOver.reason !== 'terminal' && <p className="status sudden-death-review-reason">
        {suddenDeathGameOver.reason === 'drop' ? 'The evaluation crossed the drop limit.' : 'The opponent’s reply was unavailable.'}
      </p>}
      <div className="controls-row sudden-death-review-controls">
        <button type="button" aria-label="Previous move" disabled={suddenDeathGameOver.index === 0}
          onClick={() => selectSuddenDeathPosition(suddenDeathGameOver.index - 1)}>‹</button>
        <span aria-live="polite">{suddenDeathGameOver.index} / {suddenDeathGameOver.positions.length - 1}</span>
        <button type="button" aria-label="Next move" disabled={suddenDeathGameOver.index === suddenDeathGameOver.positions.length - 1}
          onClick={() => selectSuddenDeathPosition(suddenDeathGameOver.index + 1)}>›</button>
      </div>
      <div className="move-notation-line" aria-label="Sudden Death game history">
        {suddenDeathGameOver.positions.map((position, index) => (
          <button key={index} type="button" aria-current={index === suddenDeathGameOver.index ? 'step' : undefined}
            className={`move-inline-item${index === suddenDeathGameOver.index ? ' analysis-selected' : ''}`}
            onClick={() => selectSuddenDeathPosition(index)}>{position.move?.label ?? 'Start'}</button>
        ))}
      </div>
      <div className="game-analysis-comment">
        <div aria-live="polite">
          <strong>{suddenDeathReviewPosition?.terminal ?? (reviewScore ? `${STOCKFISH_ENGINE_LABEL} ${reviewScore}` : 'Stockfish evaluation unavailable')}</strong>
          {reviewScore && <span className="status"> · White’s perspective</span>}
        </div>
        {reviewPvMoves.length > 0 && <div className="analysis-comment-line" aria-label="Stockfish continuation">
          {reviewPvMoves.map((move, index) => renderEngineMove(move, '', undefined, index))}
        </div>}
      </div>
    </>
  );
  const maiaLines = maiaResultKey === currentMaiaKey ? engineLines : [];
  const mixedRows = [
    ...maiaLines.map(line => ({ uci: line.bestMove, maia: line, score: comparison?.scores.get(line.bestMove) })),
    ...(comparison?.alternatives ?? []).map(score => ({ uci: score.uci, maia: undefined, score })),
  ];
  if (showMixedEngines) {
    const side = toTurnColor(maiaPositionFen);
    const rank = (score: CandidateEvaluation | undefined) => score ? stockfishRank(score, side) : -Infinity;
    mixedRows.sort((a, b) => rank(b.score) - rank(a.score));
  }
  const engineTable = (
    <div className="table ai-eval-table">
      {selectedEngine === 'stockfish' ? (suddenDeathGameOver && enginePvFen !== maiaPositionFen ? [] : engineLines).map(line => {
        const moves = buildEnginePvMoves(enginePvFen, line.pv || line.bestMove);
        return (
          <div className="table-row engine-pv-row" key={line.multipv}>
            {renderEngineMove(moves[0], 'engine-pv-first engine-pv-stockfish', canPlayEngineMove && enginePvFen === maiaPositionFen ? 'play' : undefined)}
            <span className="engine-pv-score">{line.scoreText}</span>
            {renderEngineContinuation(moves)}
          </div>
        );
      }) : (
        <>
          <MaiaPopularityControls checked={showMaiaPopularity} onChange={setShowMaiaPopularity} profile={maiaPopularity} />
          {showMixedEngines ? (
            <div className="mixed-engine-table" aria-label="Maia and Stockfish comparison">
              <div className="engine-pv-row mixed-engine-row mixed-engine-head">
                <strong>Move</strong>
                <strong>{MAIA_ENGINE_LABEL}</strong>
                <strong title="Scores from White’s perspective. Rows ranked for the side to move.">{STOCKFISH_ENGINE_LABEL}</strong>
                <strong>Line</strong>
              </div>
              {mixedRows.map(({ uci, maia, score }) => {
                const moves = buildEnginePvMoves(maiaPositionFen, score?.pv || uci);
                return (
                  <div className="table-row engine-pv-row mixed-engine-row" key={uci}>
                    {renderEngineMove(moves[0], `engine-pv-first ${maia ? 'engine-pv-maia' : 'engine-pv-stockfish'}`, canPlayEngineMove ? 'play' : undefined)}
                    <span className="engine-pv-score" title={maia ? undefined : 'Outside the displayed Maia suggestions'}>
                      {maia?.scoreText ?? '—'}
                    </span>
                    <span className="engine-pv-score">{score?.scoreText ?? '—'}</span>
                    {renderEngineContinuation(moves)}
                    {showMaiaPopularity && maia && <MaiaPopularityChart uci={uci} elo={maiaStrengthElo} profile={maiaPopularity} />}
                  </div>
                );
              })}
              {maiaLines.length > 0 && engineRunning && (
                (!comparison || comparison.pending) ? <div className="status" role="status">Stockfish is evaluating the moves…</div>
                  : maiaLines.some(line => !comparison.scores.has(line.bestMove)) &&
                    <div className="status" role="status">Some Stockfish evaluations are unavailable.</div>
              )}
            </div>
          ) : maiaLines.map(line => (
            <div className="table-row engine-pv-row" key={line.multipv}>
              {renderEngineMove(buildEnginePvMoves(maiaPositionFen, line.bestMove, 1)[0], 'engine-pv-first engine-pv-maia', canPlayEngineMove ? 'play' : undefined)}
              <span className="engine-pv-score">{line.scoreText}</span>
              {showMaiaPopularity && <MaiaPopularityChart uci={line.bestMove} elo={maiaStrengthElo} profile={maiaPopularity} />}
            </div>
          ))}
          {!maiaLines.length && engineStatus === 'analyzing' && (maiaLoadingStatus
            ? <MaiaStatusView status={maiaLoadingStatus} /> : <span className="maia-popularity-pending" role="status">Obliczanie ruchów…</span>)}
          {!maiaLines.length && maiaError && <div className="maia-load-error" role="alert">Maia: {maiaError}</div>}
        </>
      )}
    </div>
  );

  const treeArrowMenu = useLongPressMenu(
    () => setIsTreeArrowOptionsOpen(true),
    () => setShowTreeArrows(prev => !prev),
  );
  const mistakeHistoryMenu = useLongPressMenu(
    () => setIsMistakeHistoryOptionsOpen(true),
    () => {
      if (mistakeReview) closeMistakeReview();
      else if (canFindCommonMistakes) void findCommonMistakes();
    },
  );
  const renderForwardReviewButton = (className = '') => canGoForward && (
    <button
      type="button"
      ref={className === 'portrait-only' ? portraitForwardRef : undefined}
      className={`review-forward-btn mode-icon-btn has-submenu-dot ${className} ${className === 'portrait-only' && hidePortraitForward ? 'hide-when-wrapped' : ''}`}
      onClick={handleForwardClick}
      onContextMenu={handleForwardContextMenu}
      onPointerDown={handleForwardPointerDown}
      onPointerUp={clearForwardLongPress}
      onPointerCancel={clearForwardLongPress}
      onPointerLeave={clearForwardLongPress}
      onKeyDown={(event) => {
        if (event.key === 'End') {
          event.preventDefault();
          goForward(true);
        }
      }}
      disabled={isTreeEvalRunning}
      aria-label="Forward 1 move"
      title="Forward 1 move (long press: end of game)"
    >
      <ForwardIcon />
    </button>
  );
  const renderArrowToggleButtons = (compact = false) => (
    <>
      <button
        type="button"
        className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-lichess arrow-options-dot ${showLichessArrows ? 'active' : ''}`}
        {...lichessArrowMenu}
        aria-label="Toggle Lichess arrows"
        title="Toggle Lichess arrows (hold for options)"
      />
      {compact && (
        <CompactEngineArrowsButton
          stockfish={stockfishArrowsVisible}
          maia={maiaArrowsVisible}
          combined={combineCompactEngineArrows}
          disabled={!canToggleStockfishArrows && !canToggleMaiaArrows}
          onCycle={() => {
            if (combineCompactEngineArrows) {
              setShowStockfishArrows(!anyEngineArrows);
              setShowMaiaArrows(!anyEngineArrows);
            } else {
              setShowStockfishArrows(!anyEngineArrows);
              setShowMaiaArrows(stockfishArrowsVisible);
            }
          }}
          onSwitchMode={() => {
            setCombineCompactEngineArrows(!combineCompactEngineArrows);
            setShowStockfishArrows(anyEngineArrows);
            setShowMaiaArrows(!combineCompactEngineArrows && anyEngineArrows);
          }}
        />
      )}
      {!compact && selectedEngine === 'maia' && (
        <button
          type="button"
          className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-maia ${showMaiaArrows && canToggleMaiaArrows ? 'active' : ''}`}
          onClick={() => setShowMaiaArrows((prev) => !prev)}
          disabled={!canToggleMaiaArrows}
          aria-pressed={showMaiaArrows}
          aria-label={`Toggle ${MAIA_ENGINE_LABEL} arrows`}
          title={`Toggle ${MAIA_ENGINE_LABEL} arrows`}
        />
      )}
      {!compact && (selectedEngine === 'stockfish' || showMixedEngines) && (
        <button
          type="button"
          className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-stockfish ${showStockfishArrows && canToggleStockfishArrows ? 'active' : ''}`}
          onClick={() => setShowStockfishArrows((prev) => !prev)}
          disabled={!canToggleStockfishArrows}
          aria-pressed={showStockfishArrows}
          aria-label={`Toggle ${STOCKFISH_ENGINE_LABEL} arrows`}
          title={`Toggle ${STOCKFISH_ENGINE_LABEL} arrows`}
        />
      )}
      <button
        type="button"
        className={`icon-toggle-btn with-diagonal-arrow only-arrow arrow-tree arrow-options-dot ${showTreeArrows ? 'active' : ''}`}
        {...treeArrowMenu}
        aria-pressed={showTreeArrows}
        aria-label="Toggle tree arrows"
        title="Toggle tree arrows (hold for options)"
      />
    </>
  );

  const showDesktopMoveActions = !isExampleReplayActive && !suddenDeathGameOver;

  if (storageLoadFailed) {
    return (
      <div className={`app ${themeMode === 'dark' ? 'theme-dark' : ''}`}>
        <main className="layout">
          <section className="card" role="alert">
            <h1>Local data could not be loaded</h1>
            <p>Saved repertoires have not been changed. Reload the app to try again.</p>
            <button type="button" onClick={() => window.location.reload()}>Reload app</button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className={`app ${themeMode === 'dark' ? 'theme-dark' : ''}`}>
      <header className="topbar">
        <div className="topbar-row" />
      </header>
      <input
        ref={importInputRef}
        type="file"
        accept=".pgn,.txt,text/plain,application/x-chess-pgn"
        style={{ display: 'none' }}
        onChange={importPgn}
      />
      <input
        ref={backupImportInputRef}
        type="file"
        accept=".json,application/json,text/json"
        style={{ display: 'none' }}
        onChange={importBackupFile}
      />

      <main className="layout">
        <section className="left-panel">
          <div className={`board-row ${isTrainingActive ? 'training-mode' : ''}`}>
            {!isTrainingActive && <ExplorerPanel className={`lichess-panel card portrait-pane ${portraitTab === 'lichess' ? 'active' : ''}`}
              split={desktopLichessShare} onSplitChange={setDesktopLichessShare}>
              <section className="lichess-scroll" id="lichess-explorer-panel" aria-label="Lichess explorer">
                <div className={`lichess-toolbar${showPlayerMoveCheck ? '' : ' desktop-only'}`}>
                  {showPlayerMoveCheck && <button type="button" className="player-check-moves-btn"
                    disabled={!playerAssessmentRunning && (!stockfishLoaded || !playerMoveCounts.size ||
                      !hasHydratedAppState || !playerHandle.trim() || isTreeEvalRunning || isExampleReplayActive ||
                      Boolean(analysisGameProgress) || Boolean(trainingSession))}
                    onClick={() => void assessPlayerMoves(playerMoveCounts)}>
                    {playerAssessmentRunning ? 'Stop checking' : 'Check moves'}
                  </button>}
                  <button type="button" className="mode-icon-btn lichess-filters-btn desktop-only" aria-label="Lichess filters" title="Lichess filters"
                    onClick={() => setIsLichessFilterOpen(true)}><DbIcon /></button>
                </div>
                {opponentReview && (
                  <div className="player-repertoire-panel">
                    <div className="player-repertoire-controls mistake-review-controls">
                      <span title={activeRepertoireName}>Missing opponent moves{opponentReview.index >= 0 &&
                        ` · ${opponentReview.index + 1}/${opponentReview.findings.length}`}</span>
                      <button type="button" aria-label="Previous problem" title="Previous problem"
                        disabled={opponentReview.index <= 0}
                        onClick={() => setOpponentReview(prev => prev && ({
                          ...prev, index: prev.index - 1, waitingForNext: false,
                        }))}><PrevIcon /></button>
                      <button type="button" className="review-text-btn"
                        disabled={!hasNextOpponentFinding && (opponentReview.exhausted ||
                          (isFindMissingSearchRunning && opponentReview.waitingForNext))}
                        onClick={() => void jumpToNextMissingLichessMove()}>
                        <NextIcon /> <span>Next problem</span>
                      </button>
                      <button type="button" className="review-text-btn" onClick={closeOpponentFinding}>
                        <QuitIcon /> <span>Close review</span>
                      </button>
                    </div>
                    <div role="status" className="player-repertoire-status">
                      {playerSearchNote || (opponentReview.exhausted && !hasNextOpponentFinding &&
                        (opponentFinding ? 'No further missing opponent moves.' : 'No missing opponent moves found.'))}
                    </div>
                    {opponentReview.fromHistory && <div className="player-repertoire-status">Local game history · last 12 months</div>}
                  </div>
                )}
                {mistakeReview ? (
                  <div className="player-repertoire-panel">
                    <div className="player-repertoire-controls mistake-review-controls">
                      <span title={isBrowseMode ? 'All repertoires for this side' : activeRepertoireName}>
                        {isBrowseMode ? 'Repertoire mistakes' : 'Opening mistakes'} {mistakeReview.index >= 0 &&
                        `· ${mistakeReview.index + 1}/${mistakeReview.positions.length}`}</span>
                      <button type="button" aria-label="Previous mistake position" title="Previous mistake position"
                        disabled={mistakeReview.index <= 0 || isFindMissingSearchRunning}
                        onClick={() => void findCommonMistakes(-1)}><PrevIcon /></button>
                      <button type="button" aria-label="Next mistake position" title="Next mistake position"
                        disabled={isFindMissingSearchRunning ||
                          (mistakeReview.exhausted && mistakeReview.index >= mistakeReview.positions.length - 1)}
                        onClick={() => void findCommonMistakes(1)}><NextIcon /></button>
                      <button type="button" className="review-text-btn"
                        onClick={closeMistakeReview}>
                        <QuitIcon /> <span>Close review</span>
                      </button>
                    </div>
                    <div className="player-repertoire-status" role="status">{playerSearchNote}</div>
                    {isFindMissingSearchRunning && (
                      <button type="button" className="player-best-move" onClick={() => {
                        findMissingControllerRef.current?.abort();
                        setPlayerSearchNote('Search stopped. Use Next to continue.');
                      }}>Stop search</button>
                    )}
                    {reviewPosition && !reviewPositionOnBoard && (
                      <button type="button" className="player-best-move" onClick={() => showMistakePosition(reviewPosition)}>
                        Return to mistake position
                      </button>
                    )}
                    {reviewPositionOnBoard && (analysisScratchFen ? (
                      <div className="player-repertoire-controls">
                        <span>Preview</span>
                        <button type="button" onClick={backPlayerPreview}>Back</button>
                        <button type="button" onClick={() => setAnalysisScratchPosition(null)}>Return</button>
                        {!isBrowseMode && analysisScratchPosition?.playerMoves?.length ? (
                          <button type="button" onClick={savePlayerLine}>Save line</button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {!reviewPosition.moves.some(move => move.inRepertoire) &&
                          <div className="player-repertoire-status">No repertoire move saved for this position.</div>}
                        <PlayerRepertoireTable rows={mistakeRows} complete side={activeSide} onMove={playPlayerMove} />
                        <div className="player-repertoire-status">
                          {reviewPosition.fromHistory && 'Local game history. Dates show game start. '}
                          Recent = last 3 calendar months.
                        </div>
                      </>
                    ))}
                  </div>
                ) : isPlayerExplorer && (
                  <div className="player-repertoire-panel">
                    {!opponentReviewOpen && <div className="player-repertoire-controls">
                      {isFindMissingSearchRunning && <button type="button" onClick={() => findMissingControllerRef.current?.abort()}>
                        Stop search
                      </button>}
                      {playerAfterLine && !isFindMissingSearchRunning && Boolean(explorerData?.moves.length) && (
                        <button type="button" disabled={!stockfishLoaded || playerAssessmentRunning || isTreeEvalRunning ||
                          isExampleReplayActive || Boolean(trainingSession) || Boolean(analysisGameProgress)}
                          onClick={() => void checkPlayerReplies()}>Check replies</button>
                      )}
                    </div>}
                    {analysisScratchPosition?.playerMoves && (
                      <div className="player-repertoire-controls">
                        <span>Preview</span>
                        <button type="button" onClick={backPlayerPreview}>Back</button>
                        <button type="button" onClick={() => setAnalysisScratchPosition(null)}>Return</button>
                        {!isBrowseMode && <button type="button" disabled={isTreeEvalRunning || isExampleReplayActive}
                          onClick={savePlayerLine}>Save line</button>}
                      </div>
                    )}
                    {!opponentReviewOpen && <div role="status" className="player-repertoire-status">
                      {!playerHandle.trim() ? 'Enter your Lichess username in the database options.'
                        : usingLocalExplorer ? (!lichessTotal ? 'No synced games in this position.' : dateRange === '3y' ? 'Showing synced games from the last 12 months.' : '')
                        : lichessStatus === 'indexing' ? (explorerData?.queuePosition
                          ? `Partial results · Lichess queue: ${explorerData.queuePosition}` : 'Partial results · Lichess is indexing.')
                        : lichessStatus === 'refreshing' ? 'Showing saved results · refreshing…'
                        : lichessStatus === 'cached' ? 'Showing saved results · refresh unavailable.'
                        : lichessStatus === 'partial' ? 'Partial results · refresh to continue.'
                        : lichessStatus === 'loading' ? 'Waiting for Lichess…'
                        : lichessStatus === 'done' && explorerData && !explorerData.moves.length ? 'No games in this position.'
                        : ''}
                      {playerSearchNote && <div>{playerSearchNote}</div>}
                      {playerAssessmentNotice?.key === playerReviewKey && <div>{playerAssessmentNotice.message}</div>}
                      {isFindMissingSearchRunning && <div>Checking opponent moves…</div>}
                      {playerAfterLine && !playerRows.length && Boolean(explorerData?.moves.length) &&
                        !isFindMissingSearchRunning && !playerSearchNote && <div>End of the line · check your replies to reveal problems.</div>}
                    </div>}
                    {!opponentReviewOpen && playerAssessment && playerBestMove && playerBestSan && !playerRows.some(row => row.best) && (
                      <button type="button" className="player-best-move" onClick={() => playPlayerMove(playerBestMove)}>
                        {STOCKFISH_ENGINE_LABEL} best: {toFigurineSan(playerBestSan)}{' '}
                        <span className="player-stockfish-score">{playerScoreForWhite(playerAssessment.best.scoreText, activeSide)}</span>
                      </button>
                    )}
                    {(!opponentReviewOpen || showingOpponentResult) && playerRows.length > 0 && (
                      <PlayerRepertoireTable rows={playerRows} complete={usingLocalExplorer || showingOpponentResult ||
                        Boolean(explorerData) && ['done', 'cached', 'refreshing'].includes(lichessStatus)}
                        side={activeSide} positionGames={lichessTotal} onMove={playPlayerMove} />
                    )}
                  </div>
                )}
                {!mistakeReview && !opponentReviewOpen && !isPlayerExplorer && (playerSearchNote || isFindMissingSearchRunning) && (
                  <div className="player-repertoire-controls">
                    <span role="status">{playerSearchNote || 'Checking opponent moves…'}</span>
                    {isFindMissingSearchRunning && (
                      <button type="button" onClick={() => findMissingControllerRef.current?.abort()}>Stop search</button>
                    )}
                  </div>
                )}
                {!mistakeReview && !opponentReviewOpen && !isPlayerExplorer && !lichessAuthRequired &&
                  (visibleLichessStatus || lichessStatus === 'loading') && (
                  <div className="status lichess-status-row">
                    {lichessStatus === 'loading' && <span className="spinner" aria-hidden="true" />}
                    <span>{visibleLichessStatus || 'loading'}</span>
                  </div>
                )}
                {!mistakeReview && lichessStatus === 'limited' && !explorerData && (
                  <div className="status lichess-api-note">
                    {`Lichess API error (429), ${lichessData ? 'showing cached data' : 'no cached data'}`}
                  </div>
                )}
                {!mistakeReview && !usingLocalExplorer && !lichessAuthRequired && lichessApiIssueNote && (!explorerData || isPlayerExplorer) && (
                  <div className="status lichess-api-note">{lichessApiIssueNote}</div>
                )}
                {!mistakeReview && !usingLocalExplorer && lichessAuthRequired && (
                  <div className="status lichess-api-note">Lichess token missing or invalid (401).</div>
                )}
                {!mistakeReview && (!opponentReviewOpen || showingOpponentResult) && (explorerData || isPlayerExplorer) && (
                  <>
                    {!isPlayerExplorer && <div className="table">
                      {filteredLichessMoves.map((move) => {
                        const total = move.white + move.draws + move.black;
                        return (
                          <div
                            className={`table-row lichess-clickable-row ${isTrainingActive ? 'disabled' : ''}`}
                            key={`${move.uci}-${move.san}`}
                            role="button"
                            tabIndex={isTrainingActive ? -1 : 0}
                            onClick={() => playSuggestedMove(move.uci)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                playSuggestedMove(move.uci);
                              }
                            }}
                          >
                            <span className="lichess-cell-move">{toFigurineSan(move.san)}</span>
                            <span className="lichess-cell-games">
                              {formatGamesCount(total)} ({formatPercent(total, lichessTotal)})
                            </span>
                            <span className="lichess-cell-elo">{formatAverageElo(move)}</span>
                            <span className="lichess-cell-bar">
                              <LichessStatsBar white={move.white} draws={move.draws} black={move.black} />
                            </span>
                          </div>
                        );
                      })}
                    </div>}
                    {(!isPlayerExplorer || hasLichessExampleGames) && <div className="lichess-example-games">
                      {!hasLichessExampleGames && (
                        <span className="status">No example games for current filters.</span>
                      )}
                      {hasLichessExampleGames && (
                        <div className="lichess-example-lists">
                          {lichessTopGames.map((game, index) => {
                            const gameId = typeof game.id === 'string' ? game.id.trim() : '';
                            const gameLine = formatLichessExampleLine(game);
                            return (
                              <div key={`top-${gameId || index}`} className="lichess-example-item">
                                <button
                                  type="button"
                                  className="lichess-example-load-btn"
                                  onClick={() => void loadExampleReplayGame(game)}
                                  disabled={!gameId || exampleReplayLoadingId === gameId}
                                >
                                  {exampleReplayLoadingId === gameId ? 'Loading...' : gameLine}
                                </button>
                              </div>
                            );
                          })}
                          {lichessRecentGames.map((game, index) => {
                            const gameId = typeof game.id === 'string' ? game.id.trim() : '';
                            const gameLine = formatLichessExampleLine(game);
                            return (
                              <div key={`recent-${gameId || index}`} className="lichess-example-item">
                                <button
                                  type="button"
                                  className="lichess-example-load-btn"
                                  onClick={() => void loadExampleReplayGame(game)}
                                  disabled={!gameId || exampleReplayLoadingId === gameId}
                                >
                                  {exampleReplayLoadingId === gameId ? 'Loading...' : gameLine}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {exampleReplayError && <span className="status">{exampleReplayError}</span>}
                    </div>}
                  </>
                )}
              </section>
              <section className="stockfish-inline desktop-only" aria-label="AI analysis">
                <div className="controls-row stockfish-controls-row ai-engine-controls">
                  <div className="ai-engine-row">
                    <span className="ai-engine-select">
                      <button
                        type="button"
                        className={`ai-engine-tab ${selectedEngine === 'maia' ? 'active' : ''}`}
                        aria-pressed={selectedEngine === 'maia'}
                        disabled={isGameReviewRunning || isTreeEvalRunning || playerAssessmentRunning}
                        onClick={() => selectEngine('maia')}
                      >
                        {MAIA_ENGINE_LABEL}
                      </button>
                      <button
                        type="button"
                        className={`ai-engine-tab ${selectedEngine === 'stockfish' || showMixedEngines ? 'active' : ''}`}
                        aria-pressed={selectedEngine === 'stockfish' || showMixedEngines}
                        disabled={isGameReviewRunning || isTreeEvalRunning || playerAssessmentRunning}
                        onClick={() => selectEngine('stockfish')}
                      >
                        {STOCKFISH_ENGINE_LABEL}
                      </button>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isEngineEnabled}
                      className={`ai-switch ${isEngineEnabled ? 'on' : 'off'}`}
                      disabled={Boolean(analysisGameProgress)}
                      onClick={() => setEngineRunningEnabled(!isEngineEnabled)}
                    >
                      <span className="ai-switch-track" aria-hidden="true">
                        <span className="ai-switch-thumb" />
                      </span>
                      <span className="ai-switch-text">{isEngineEnabled ? 'On' : 'Off'}</span>
                    </button>
                    {selectedEngine === 'maia' && (
                      <label className="ai-elo-select-wrap">
                        <select
                          className="ai-elo-select"
                          value={maiaStrengthElo}
                          onChange={(e) => {
                            const next = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(next)) {
                              setMaiaStrengthElo(
                                Math.min(MAIA_STRENGTH_ELO_MAX, Math.max(MAIA_STRENGTH_ELO_MIN, next)),
                              );
                            }
                          }}
                          aria-label={`${MAIA_ENGINE_LABEL} strength`}
                        >
                          {MAIA_STRENGTH_ELO_VALUES.map((elo) => (
                            <option key={elo} value={elo}>
                              {`${elo} Elo`}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <span className="inline-stepper ai-row-right">
                      <button
                        type="button"
                        onClick={() => setEngineMultiPv((prev) => Math.max(1, prev - 1))}
                        aria-label="Decrease lines"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M6 12h12" />
                        </svg>
                      </button>
                      <span className="stepper-value">{engineMultiPv}</span>
                      <button
                        type="button"
                        onClick={() => setEngineMultiPv((prev) => Math.min(10, prev + 1))}
                        aria-label="Increase lines"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M12 6v12M6 12h12" />
                        </svg>
                      </button>
                    </span>
                    <button
                      type="button"
                      className="stockfish-settings-btn"
                      aria-label="AI options"
                      title="AI options"
                      onClick={() => setIsStockfishQuickOpen(true)}
                    >
                      <ComputerIcon />
                    </button>
                  </div>
                  {engineTable}
                  {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
                </div>
              </section>
            </ExplorerPanel>}

            <div className="board-center">
              <div className="board-meta">
                <div className="board-head-row">
                  <div className={`opening-title ${!isBrowseMode ? (isEditingRepertoire ? 'editing-repertoire' : 'reviewing-repertoire') : ''}`} title={openingFullTitle}>
                    {openingTitleContent}
                  </div>
                  <button className="hamburger-btn board-options-btn" aria-label="Options menu" onClick={() => setIsOptionsOpen(true)}>
                    &#9776;
                  </button>
                </div>
                <div className="stats-row">
                  <LichessStatsBar
                    white={explorerData?.white ?? 0}
                    draws={explorerData?.draws ?? 0}
                    black={explorerData?.black ?? 0}
                  />
                  <span className="games-total">
                    {formatGamesCount(explorerData ? lichessTotal : 0)}
                    {visibleEngineEval && <span className="games-eval-inline">{` ${visibleEngineEval}`}</span>}
                  </span>
                </div>
              </div>
              <Board
                fen={boardPreview?.fen ?? boardFen}
                orientation={boardOrientation}
                lastMove={boardPreview?.lastMove ?? boardLastMove}
                arrows={boardPreview ? [] : trainingForActive ? trainingHintArrow : autoArrows}
                annotations={boardPreview ? [] : savedAnnotations}
                annotationTarget={canAnnotateBoard && !boardPreview ? annotationTarget : undefined}
                drawing={isDrawingAnnotations}
                allowedMoveUcis={isReadOnlyRepertoire ? childNodes.map(node => node.moveUci).filter((uci): uci is string => Boolean(uci)) : undefined}
                disableDrawing={isReadOnlyRepertoire}
                onAnnotationsChange={saveAnnotations}
                readOnly={Boolean(suddenDeathGameOver || (isSuddenDeathActive && (suddenDeathThinking || toTurnColor(boardFen) !== activeSide)))}
                onMove={makeMove}
              />
              <div className={`portrait-tabbar${showTrainingContinue || showHintButton ? ' with-desktop-training-action' : ''}`}>
                {!isTrainingActive && isExampleReplayActive && (
                  <>
                    <button
                      type="button"
                      className="replay-control-btn mode-icon-btn"
                      onClick={() => {
                        if (!exampleReplay) return;
                        const atEnd = exampleReplay.currentIndex >= exampleReplay.fens.length - 1;
                        if (atEnd) {
                          setExampleReplay((prev) => (prev ? { ...prev, currentIndex: 0, playing: true } : prev));
                          return;
                        }
                        setExampleReplayPlaying(!exampleReplay.playing);
                      }}
                      aria-label={exampleReplay?.playing ? 'Stop autoplay' : 'Play autoplay'}
                      title={exampleReplay?.playing ? 'Stop autoplay' : 'Play autoplay'}
                    >
                      {exampleReplay?.playing ? <StopIcon /> : <PlayIcon />}
                    </button>
                    <button
                      type="button"
                      className="replay-control-btn mode-icon-btn"
                      onClick={() => stepExampleReplay(-1)}
                      disabled={!exampleReplay || exampleReplay.currentIndex <= 0}
                      aria-label="Previous move"
                      title="Previous move"
                    >
                      <PrevIcon />
                    </button>
                    <button
                      type="button"
                      className="replay-control-btn mode-icon-btn"
                      onClick={() => stepExampleReplay(1)}
                      disabled={!exampleReplay || exampleReplay.currentIndex >= exampleReplay.fens.length - 1}
                      aria-label="Next move"
                      title="Next move"
                    >
                      <NextIcon />
                    </button>
                    <button
                      type="button"
                      className="replay-control-btn mode-icon-btn danger"
                      onClick={quitExampleReplay}
                      aria-label="Quit replay"
                      title="Quit replay"
                    >
                      <QuitIcon />
                    </button>
                  </>
                )}
                {!isTrainingActive && !isExampleReplayActive && (
                  <>
                    <button
                      type="button"
                      className={`long-pressable-btn ${portraitTab === 'lichess' ? 'active' : ''}`}
                      {...lichessTabMenu}
                      aria-label="Lichess"
                      title="Lichess (long press: filters)"
                    >
                      <DbIcon />
                    </button>
                    <button
                      type="button"
                      className={`long-pressable-btn ${portraitTab === 'stockfish' ? 'active' : ''}`}
                      {...aiTabMenu}
                      aria-label="AI"
                      title="AI (long press: options)"
                    >
                      <ComputerIcon />
                    </button>
                    <button
                      type="button"
                      className={`${portraitTab === 'moves' ? 'active' : ''}${canAnnotateBoard ? ' long-pressable-btn' : ''}${isDrawingAnnotations ? ' icon-toggle-btn with-diagonal-arrow only-arrow arrow-annotation' : ''}`}
                      {...movesTabDrawing}
                      aria-label="Moves"
                      title={canAnnotateBoard ? `Moves (long press: ${isDrawingAnnotations ? 'return to move entry' : 'draw annotations'})` : 'Moves'}
                    >
                      {!isDrawingAnnotations && <MoveIcon />}
                    </button>
                  </>
                )}
                {(!isExampleReplayActive || isTrainingActive) && (
                  <button
                    type="button"
                    className={`${isTrainingActive ? 'active training-stop-btn' : 'train-options-btn'} long-pressable-btn`}
                    {...(isTrainingActive ? { onClick: () => stopTraining() } : trainButtonMenu)}
                    aria-label={isTrainingActive ? 'Stop training' : 'Train'}
                    title={isTrainingActive ? 'Stop training' : 'Train (long press: options)'}
                    disabled={Boolean(suddenDeathGameOver) || (!isTrainingActive && !canStartTrainingForActiveSide)}
                  >
                    {isTrainingActive ? 'Stop training' : <TrainIcon />}
                  </button>
                )}
                {!isTrainingActive && !isExampleReplayActive && (
                  <button
                    type="button"
                    className={
                      trainingSession?.suddenDeathMode
                        ? 'active sudden-death-toggle-btn mode-icon-btn has-submenu-dot'
                        : 'sudden-death-toggle-btn mode-icon-btn has-submenu-dot'
                    }
                    {...suddenDeathMenu}
                    aria-label={isSuddenDeathActive ? 'Restart sudden death round' : 'Start sudden death training'}
                    title={isSuddenDeathActive ? 'Restart sudden death round (long press: options)' : 'Start sudden death training (long press: options)'}
                    disabled={suddenDeathThinking || Boolean(suddenDeathGameOver)}
                  >
                    <SuddenDeathIcon />
                  </button>
                )}
                {isTrainingActive && (
                  <button
                    type="button"
                    className={trainingSession?.flashcardMode ? 'active flashcard-toggle-btn mode-icon-btn' : 'flashcard-toggle-btn mode-icon-btn'}
                    onClick={toggleFlashcardMode}
                    aria-label="Toggle flashcard mode"
                    title="Toggle flashcard mode"
                  >
                    <FlashcardIcon />
                  </button>
                )}
                {showTrainingContinue && (
                  <button type="button" className="continue-portrait-btn" onClick={restartTrainingLine}>
                    Continue
                  </button>
                )}
                {isTrainingActive && showHintButton && (
                  <button
                    type="button"
                    className="hint-portrait-btn"
                    onClick={() => setTrainingSession((prev) => (prev ? { ...prev, hintVisible: true } : prev))}
                  >
                    Hint
                  </button>
                )}
                {!isTrainingActive && !isExampleReplayActive && (
                  <div className="portrait-navigation">
                    <div ref={topArrowGroupRef} className={`arrow-toggle-group ${showMixedEngines ? 'mixed-engine-arrows' : ''}`}>{renderArrowToggleButtons()}</div>
                    <button
                      type="button"
                      className="portrait-back-btn long-pressable-btn"
                      onClick={handleBackClick}
                      onContextMenu={handleBackContextMenu}
                      onPointerDown={handleBackPointerDown}
                      onPointerUp={handleBackPointerEnd}
                      onPointerCancel={handleBackPointerEnd}
                      onPointerLeave={handleBackPointerEnd}
                      disabled={!canGoBack}
                      aria-label="Back 1 move"
                      title={backTitle ?? 'Back 1 move (long press: previous branch)'}
                    >
                      <BackIcon />
                    </button>
                  </div>
                )}
              </div>
            </div>
            {!isTrainingActive && <aside className={`stockfish-panel card portrait-only portrait-pane ${portraitTab === 'stockfish' ? 'active' : ''}`}>
              <div className="controls-row stockfish-controls-row ai-engine-controls">
                <div className="ai-engine-row ai-engine-row-top">
                  <span className="ai-engine-select">
                    <button
                      type="button"
                      className={`ai-engine-tab ${selectedEngine === 'stockfish' || showMixedEngines ? 'active' : ''}`}
                      aria-pressed={selectedEngine === 'stockfish' || showMixedEngines}
                      disabled={Boolean(analysisGameProgress)}
                      onClick={() => selectEngine('stockfish')}
                    >
                      {STOCKFISH_ENGINE_LABEL}
                    </button>
                    <button
                      type="button"
                      className={`ai-engine-tab ${selectedEngine === 'maia' ? 'active' : ''}`}
                      aria-pressed={selectedEngine === 'maia'}
                      disabled={Boolean(analysisGameProgress)}
                      onClick={() => selectEngine('maia')}
                    >
                      {MAIA_ENGINE_LABEL}
                    </button>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEngineEnabled}
                    className={`ai-switch ${isEngineEnabled ? 'on' : 'off'}`}
                    disabled={Boolean(analysisGameProgress)}
                    onClick={() => setEngineRunningEnabled(!isEngineEnabled)}
                  >
                    <span className="ai-switch-track" aria-hidden="true">
                      <span className="ai-switch-thumb" />
                    </span>
                    <span className="ai-switch-text">{isEngineEnabled ? 'On' : 'Off'}</span>
                  </button>
                  <span className="ai-elo-slot">
                    {selectedEngine === 'maia' && (
                      <label className="ai-elo-select-wrap">
                        <select
                          className="ai-elo-select"
                          value={maiaStrengthElo}
                          onChange={(e) => {
                            const next = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(next)) {
                              setMaiaStrengthElo(
                                Math.min(MAIA_STRENGTH_ELO_MAX, Math.max(MAIA_STRENGTH_ELO_MIN, next)),
                              );
                            }
                          }}
                          aria-label={`${MAIA_ENGINE_LABEL} strength`}
                        >
                          {MAIA_STRENGTH_ELO_VALUES.map((elo) => (
                            <option key={elo} value={elo}>
                              {`${elo} Elo`}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </span>
                  <span className="inline-stepper ai-row-right">
                    <button
                      type="button"
                      onClick={() => setEngineMultiPv((prev) => Math.max(1, prev - 1))}
                      aria-label="Decrease lines"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M6 12h12" />
                      </svg>
                    </button>
                    <span className="stepper-value">{engineMultiPv}</span>
                    <button
                      type="button"
                      onClick={() => setEngineMultiPv((prev) => Math.min(10, prev + 1))}
                      aria-label="Increase lines"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M12 6v12M6 12h12" />
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
              <div className="ai-portrait-scroll">
                {engineTable}
                {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
              </div>
            </aside>}

            <aside className={`move-list card portrait-pane ${portraitTab === 'moves' ? 'active' : ''} ${isTrainingActive ? 'training-pane' : ''}`}>
              {!isTrainingActive && showDesktopMoveActions && <div className="controls-row desktop-only">
                <button type="button" className="mode-icon-btn has-submenu-dot train-options-btn"
                  {...trainButtonMenu} aria-label="Train" title="Train (long press: options)"
                  disabled={!canStartTrainingForActiveSide}>
                  <TrainIcon />
                </button>
                <button type="button" className="sudden-death-toggle-btn mode-icon-btn has-submenu-dot"
                  {...suddenDeathMenu}
                  aria-label={isSuddenDeathActive ? 'Restart sudden death round' : 'Start sudden death training'}
                  title={isSuddenDeathActive ? 'Restart sudden death round (long press: options)' : 'Start sudden death training (long press: options)'}
                  disabled={suddenDeathThinking}>
                  <SuddenDeathIcon />
                </button>
                <div className="desktop-review-navigation">
                  {renderForwardReviewButton()}
                  <button type="button" className="back-btn has-submenu-dot" onClick={handleBackClick}
                    onContextMenu={handleBackContextMenu} onPointerDown={handleBackPointerDown}
                    onPointerUp={handleBackPointerEnd} onPointerCancel={handleBackPointerEnd}
                    onPointerLeave={handleBackPointerEnd} disabled={!canGoBack} aria-label="Back 1 move"
                    title={backTitle ?? 'Back 1 move (long press: previous branch)'}>
                    <BackIcon />
                  </button>
                </div>
              </div>}
              {suddenDeathReviewPanel || (isTrainingActive ? (
                <>
                  <div className="controls-row desktop-only">
                    <button type="button" className="stop-training-btn" onClick={stopTraining}>
                      Stop training
                    </button>
                    <button
                      type="button"
                      className={trainingSession?.flashcardMode ? 'flashcard-toggle-btn mode-icon-btn active' : 'flashcard-toggle-btn mode-icon-btn'}
                      onClick={toggleFlashcardMode}
                      aria-label="Toggle flashcard mode"
                      title="Toggle flashcard mode"
                    >
                      <FlashcardIcon />
                    </button>
                    <button
                      type="button"
                      className="gear-btn training-stats-gear-btn"
                      aria-label="Training statistics options"
                      title="Training statistics options"
                      onClick={() => setIsTrainingStatsMenuOpen((prev) => !prev)}
                    >
                      ⚙
                    </button>
                  </div>
                  <div className={`training-repertoire-name ${isEditingRepertoire ? 'editing-repertoire' : ''}`} title={isBrowseMode ? `${activeSide}: whole db` : activeRepertoireName}>
                    {isBrowseMode ? `${activeSide}: whole db` : `${activeSide}: ${activeRepertoireName}`}
                  </div>
                  <div className="controls-row">
                    <span className="status">{`Progress: ${trainingAnsweredLines}/${trainingTotalLines} (${trainingProgressPct}%)`}</span>
                  </div>
                  <div className="controls-row">
                    <span className="status">{`Success rate: ${trainingSessionSuccessPct}%`}</span>
                  </div>
                  <div className="controls-row">
                    <span className="status">{`Correct: ${trainingCorrectCount}`}</span>
                  </div>
                  <div className="controls-row">
                    <span className="status">{`Errors: ${trainingErrorCount}`}</span>
                  </div>
                  {trainingSession?.suddenDeathMode && suddenDeathThinking && (
                    <div className="controls-row training-thinking-row">
                      <span className="spinner" aria-hidden="true" />
                      <span className="status">{`${STOCKFISH_ENGINE_NAME} thinking...`}</span>
                    </div>
                  )}
                  <div className="controls-row training-position-stats">
                    <span className="status">{`This position success rate: ${trainingPositionSuccessPct}%`}</span>
                  </div>
                  {isTrainingActive && trainingSession?.hintVisible && trainingHintMoveText && (
                    <div className="controls-row training-position-stats">
                      <span className="status">{`Hint move: ${trainingHintMoveText}`}</span>
                    </div>
                  )}
                  {trainingRepoOverallSuccessPct !== null && (
                    <div className="controls-row training-position-stats">
                      <span className="status">{`Overall success rate: ${trainingRepoOverallSuccessPct}%`}</span>
                    </div>
                  )}
                  {activeMoveComment}
                </>
              ) : (
                <>
                  <div ref={moveToolbarRef} className={`controls-row${isExampleReplayActive ? '' : ' move-toolbar'}`}>
                    {isExampleReplayActive ? (
                      <>
                        <button
                          type="button"
                          className="replay-control-btn mode-icon-btn"
                          onClick={() => {
                            if (!exampleReplay) return;
                            const atEnd = exampleReplay.currentIndex >= exampleReplay.fens.length - 1;
                            if (atEnd) {
                              setExampleReplay((prev) => (prev ? { ...prev, currentIndex: 0, playing: true } : prev));
                              return;
                            }
                            setExampleReplayPlaying(!exampleReplay.playing);
                          }}
                          aria-label={exampleReplay?.playing ? 'Stop autoplay' : 'Play autoplay'}
                          title={exampleReplay?.playing ? 'Stop autoplay' : 'Play autoplay'}
                        >
                          {exampleReplay?.playing ? <StopIcon /> : <PlayIcon />}
                        </button>
                        <button
                          type="button"
                          className="replay-control-btn mode-icon-btn"
                          onClick={() => stepExampleReplay(-1)}
                          disabled={!exampleReplay || exampleReplay.currentIndex <= 0}
                          aria-label="Previous move"
                          title="Previous move"
                        >
                          <PrevIcon />
                        </button>
                        <button
                          type="button"
                          className="replay-control-btn mode-icon-btn"
                          onClick={() => stepExampleReplay(1)}
                          disabled={!exampleReplay || exampleReplay.currentIndex >= exampleReplay.fens.length - 1}
                          aria-label="Next move"
                          title="Next move"
                        >
                          <NextIcon />
                        </button>
                        <button
                          type="button"
                          className="replay-control-btn mode-icon-btn danger"
                          onClick={quitExampleReplay}
                          aria-label="Quit replay"
                          title="Quit replay"
                        >
                          <QuitIcon />
                        </button>
                        {exampleReplay?.label && <span className="status replay-label">{exampleReplay.label}</span>}
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="next-missing-btn mode-icon-btn has-long-press-menu"
                          {...findMissingMenu}
                          data-search-unavailable={!opponentReviewOpen && !canRunFindMissingSearch || undefined}
                          aria-label={isPlayerExplorer ? 'Find missing opponent moves' : 'Find missing popular opponent move'}
                          title={isPlayerExplorer ? 'Find missing opponent moves in your games (long press: options)'
                            : 'Find missing popular opponent move (long press: options)'}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <circle cx="12" cy="12" r="4.2" />
                            <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
                            <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2" />
                          </svg>
                        </button>
                        <button type="button" className={`mode-icon-btn find-mistakes-btn has-submenu-dot ${mistakeReview ? 'active' : ''}`}
                          {...mistakeHistoryMenu}
                          aria-disabled={!mistakeReview && !canFindCommonMistakes} aria-pressed={mistakeReviewOpen}
                          aria-label="Find common mistakes" title={playerHandle.trim()
                            ? 'Find common mistakes in your games (hold for time range)' : 'Set your Lichess username in Player settings (hold for time range)'}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <circle cx="12" cy="12" r="8.5" />
                            <path d="m9 9 6 6m0-6-6 6" />
                          </svg>
                        </button>
                        <button type="button"
                          className={`mode-icon-btn desktop-only move-entry-toggle${isDrawingAnnotations ? ' icon-toggle-btn with-diagonal-arrow only-arrow arrow-annotation' : ''}`}
                          aria-label="Moves"
                          title={isDrawingAnnotations ? 'Return to move entry' : 'Draw arrows and mark squares'}
                          aria-pressed={isDrawingAnnotations} disabled={!canAnnotateBoard}
                          onClick={toggleAnnotationDrawing}>
                          {!isDrawingAnnotations && <MoveIcon />}
                        </button>
                        <button type="button" className="mode-icon-btn" aria-label="Undo" title="Undo"
                          onClick={undoNavigation} disabled={undoStackBySide[activeSide].length === 0}>
                          <UndoIcon />
                        </button>
                        {renderForwardReviewButton('portrait-only')}
                        <div ref={movesArrowGroupRef} className={`arrow-toggle-group portrait-panel-arrows ${showMixedEngines ? 'mixed-engine-arrows' : ''}`}>{renderArrowToggleButtons(useCompactEngineArrows)}</div>
                      </>
                    )}
                  </div>
                  {isBrowseMode && analysisGameProgress && (
                    <div className="game-analysis-progress-inline" aria-live="polite">
                      <div className="game-analysis-progress-label">
                        <span>{analysisGameProgress.detail ?? `${analysisGameProgress.moveText} · ${analysisGameProgress.phase === 'refine' ? 'Checking critical position' : analysisGameProgress.phase === 'alternatives' ? 'Checking human alternatives' : analysisGameProgress.phase === 'profile' ? `${MAIA_ENGINE_LABEL}: comparing rating profiles` : analysisGameProgress.phase === 'maia' ? `${MAIA_ENGINE_LABEL} · ${gameAnalysisReport?.maiaElo ?? maiaStrengthElo} Elo` : analysisGameProgress.phase === 'book' ? 'Book lookup' : analysisGameProgress.phase === 'best' ? 'Stockfish screening: best move' : 'Stockfish screening: played move'}`}</span>
                        <span>{analysisGameProgress.done}/{analysisGameProgress.total}</span>
                        {analysisGameProgress.liveScoreText && <b>{analysisGameProgress.liveScoreText}</b>}
                      </div>
                      <progress value={analysisGameProgress.done} max={Math.max(1, analysisGameProgress.total)} aria-label="Game analysis progress" />
                    </div>
                  )}
                  {isBrowseMode && analysisMaiaNotice && !analysisGameProgress && (
                    <div className={`analysis-maia-notice ${analysisMaiaNotice.kind}`} role={analysisMaiaNotice.kind === 'error' ? 'alert' : 'status'}>
                      {analysisMaiaNotice.text}
                    </div>
                  )}
                  {!analysisGameProgress && <div ref={moveNotationRef} className="move-notation-line">
                    <div className="move-inline-wrap">
                      {inlineMoves.map((move) => (
                        <button
                          key={move.id}
                          ref={move.selected ? selectedMoveButtonRef : undefined}
                          type="button"
                          className={`move-inline-item ${move.hasAlternatives ? 'has-alternatives' : ''} ${move.categoryClass ? `analysis-${move.categoryClass}` : ''} ${move.selected ? 'analysis-selected' : ''} ${move.missedInGames ? 'missed-in-games' : ''}`}
                          data-move-status={move.moveStatus}
                          title={[move.moveStatus && REPERTOIRE_MOVE_LABELS[move.moveStatus], move.annotationTitle,
                            move.missedInGames && 'You played outside this repertoire here', move.comment].filter(Boolean).join('\n') || undefined}
                          onClick={(event) => handleInlineMoveClick(move.id, event)}
                          onContextMenu={(event) => openInlineMoveContextMenu(move.id, event)}
                          onPointerDown={(event) => handleInlineMovePointerDown(move.id, event)}
                          onPointerUp={handleInlineMovePointerEnd}
                          onPointerCancel={handleInlineMovePointerEnd}
                          onPointerLeave={handleInlineMovePointerEnd}
                        >
                          {move.prefix ? <span className="move-inline-prefix">{move.prefix}</span> : null}
                          <span className={move.comment ? 'commented-move' : undefined}>{move.san}</span>
                          {move.annotation && <span className="move-inline-annotation">{move.annotation}</span>}
                          {move.maiaBaselineTag && (
                            <span
                              className={`move-inline-maia-tag ${move.maiaBaselineTag}`}
                              title={move.maiaBaselineTag === 'above' ? 'Unusual strong move for the Maia baseline' : 'Unusual weak move for the Maia baseline'}
                            >
                              {move.maiaBaselineTag === 'above' ? 'M+' : 'M−'}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    {activeMoveComment}
                  </div>}
                  {selectedAnalysisResult && (
                    <div className={`game-analysis-comment ${selectedAnalysisResult.greatFind ? 'excellent' : selectedAnalysisResult.category === 'excellent' ? 'good' : selectedAnalysisResult.category}`} aria-live="polite">
                          <strong>
                            {selectedAnalysisResult.moveNumber}{selectedAnalysisResult.mover === 'black' ? '…' : '.'} {toFigurineSan(selectedAnalysisResult.moveSan)}
                            {' '}{selectedAnalysisResult.status === 'uncertain' ? ' (provisional)' : selectedAnalysisResult.greatFind ? '!' : selectedAnalysisResult.category === 'inaccuracy' ? '?!' : selectedAnalysisResult.category === 'mistake' ? '?' : selectedAnalysisResult.category === 'blunder' ? '??' : ''}
                          </strong>
                          {selectedAnalysisResult.status === 'uncertain'
                        ? <span>Classification uncertain: engine evaluations changed or need further confirmation.</span>
                        : selectedAnalysisResult.status === 'unavailable'
                          ? <span>Stockfish could not provide a reliable evaluation for this move.</span>
                          : <span>{selectedAnalysisResult.lossPoints === null ? 'No comparable score was available.' : `${selectedAnalysisResult.lossPoints.toFixed(1)} evaluation-impact points lost.`}
                            {selectedAnalysisResult.bestMoveUci && selectedAnalysisResult.bestMoveUci === selectedNode.moveUci
                              ? ''
                              : selectedAnalysisBestMove ? ` Engine preferred ${selectedAnalysisBestMove}.` : ''}
                          </span>}
                          {selectedAnalysisResult.bestPv && selectedAnalysisParent && (
                            <span className="analysis-comment-line">
                              <span>Computer line:</span>
                              {buildEnginePvMoves(selectedAnalysisParent.fen, selectedAnalysisResult.bestPv).map((move, index) => (
                                <button
                                  type="button"
                                  className="analysis-pv-move"
                                  key={`analysis-comment-pv-${index}-${move.san}`}
                                  title={`Show position after ${move.san}`}
                                  onClick={() => previewEnginePvMove(selectedAnalysisParent.fen, selectedAnalysisResult.bestPv, index)}
                                >
                                  {move.san}
                                </button>
                              ))}
                            </span>
                          )}
                          <MaiaMoveSummary result={selectedAnalysisResult} positionFen={selectedReportParent?.fen} />
                          {selectedAnalysisResult.attackEvidence && <span>{selectedAnalysisResult.attackEvidence}</span>}
                          {selectedAnalysisResult.playedPv && (
                            <span className="analysis-comment-line">
                              <span>After the played move:</span>
                              {buildEnginePvMoves(selectedNode.fen, selectedAnalysisResult.playedPv).map((move, index) => (
                                <button type="button" className="analysis-pv-move" key={`played-pv-${index}`}
                                  onClick={() => previewEnginePvMove(selectedNode.fen, selectedAnalysisResult.playedPv, index)}>{move.san}</button>
                              ))}
                            </span>
                          )}
                    </div>
                  )}
                  {!analysisGameProgress && optionRows.length > 0 && (
                    <div className="tree-options-wrap">
                      {optionRows.map(({ node, leaves, moveStatus }) => (
                        <div key={node.id} className="tree-option">
                          <button
                            type="button"
                            className={`tree-option-btn ${currentDeviations?.length ? 'missed-in-games' : ''}`}
                            data-move-status={moveStatus}
                            title={[moveStatus && REPERTOIRE_MOVE_LABELS[moveStatus],
                              currentDeviations?.length && 'You played outside this repertoire here', node.comment].filter(Boolean).join('\n') || undefined}
                            onClick={(event) => handleTreeOptionClick(node, event)}
                            onPointerDown={(event) => handleTreeOptionPointerDown(node, event)}
                            onPointerUp={handleTreeOptionPointerEnd}
                            onPointerCancel={handleTreeOptionPointerEnd}
                            onMouseDown={(event) => handleTreeOptionMouseDown(node, event)}
                            onMouseUp={handleTreeOptionPointerEnd}
                            onMouseLeave={handleTreeOptionPointerEnd}
                            onTouchStart={(event) => handleTreeOptionTouchStart(node, event)}
                            onTouchEnd={handleTreeOptionPointerEnd}
                            onTouchCancel={handleTreeOptionPointerEnd}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              openTreeOptionDeleteFromContextMenu(node, event.currentTarget);
                            }}
                          >
                            <span className={node.comment ? 'commented-move' : undefined}>{toFigurineSan(node.moveSan ?? '')}</span>
                          </button>
                          <span className="tree-option-leaves">
                            {node.stockfishEval ? `${STOCKFISH_ENGINE_LABEL} ${node.stockfishEval} | ${leaves}` : leaves}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!analysisGameProgress && repertoiresAtPosition.length > 0 && (
                    <div className="repertoire-hit-block">
                      <div className="repertoire-hit-head">
                        <strong>Repertoires with this position</strong>
                      </div>
                      <div className="repertoire-hit-list">
                        {repertoiresAtPosition.map((item) => (
                          <RepertoireSelectButton
                            key={item.id}
                            name={item.name}
                            mode={item.isActive ? repertoireModeBySide[boardOrientation] : null}
                            className={`repertoire-hit-item ${item.isActive ? 'active' : ''} ${item.isActive && repertoireModeBySide[boardOrientation] === 'edit' ? 'editing-repertoire' : ''}`}
                            onSelect={(mode) => loadRepertoire(item.id, boardOrientation, true, mode)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ))}
            </aside>
          </div>

        </section>
      </main>

      {showAnalysisReport && gameAnalysisReport && gameAnalysisReportMatchesLine && (
        <div className="modal-backdrop game-analysis-backdrop" onClick={() => setShowAnalysisReport(false)}>
          <div className="modal-card game-analysis-modal" role="dialog" aria-modal="true" aria-labelledby="game-analysis-title" onClick={(event) => event.stopPropagation()}>
            <div className="game-analysis-modal-heading">
              <h3 id="game-analysis-title">Game analysis</h3>
              <button type="button" onClick={() => setShowAnalysisReport(false)} aria-label="Close game analysis report">×</button>
            </div>
            <p>
              {gameAnalysisReport.status === 'complete' ? 'Analysis complete' : `Analysis ${gameAnalysisReport.status}`}
              {' · '}{gameAnalysisReport.results.length} moves · {gameAnalysisReport.engine}
              {gameAnalysisReport.maiaEngine && gameAnalysisReport.maiaElo !== undefined
                ? ` · ${gameAnalysisReport.maiaEngine} (fallback baseline ${gameAnalysisReport.maiaElo})`
                : ''}
            </p>
            {gameAnalysisReport.status !== 'complete' && <p>Analysis {gameAnalysisReport.status}. Only available results are included.</p>}
            {gameAnalysisReport.reviewMode !== 'deep' && <p>Quick review: Stockfish plus Maia on up to six selected decisions. Repertoire moves are skipped. Hold the analysis button for detailed review and benchmark settings.</p>}
            <GameReport mode={gameAnalysisReport.reviewMode} results={gameAnalysisReport.results} positions={Object.fromEntries(Object.values(tree.nodes).map(node => [node.id, node.fen]))}
              onSelect={(nodeId) => {
                setSelectedNodeBySide(prev => ({ ...prev, [gameAnalysisReport.side]: nodeId }));
                setShowAnalysisReport(false);
              }} />
            <div className="game-analysis-modal-actions">
              {!analysisGameProgress && <button type="button" onClick={() => { void analyzeCurrentGame(true); }}>Deep review with Maia (slower)</button>}
              <button type="button" onClick={() => setShowAnalysisReport(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {treeOptionDeletePopup && (
        <>
          <div
            className="tree-delete-popup-backdrop"
            onClick={() => {
              if (!treeOptionDeletePopup) return;
              if (Date.now() - treeOptionDeletePopup.openedAt < 350) return;
              setTreeOptionDeletePopup(null);
            }}
          />
          <div
            className="tree-delete-popup"
            style={{ left: treeOptionDeletePopup.x, top: treeOptionDeletePopup.y,
              maxHeight: `calc(100dvh - ${treeOptionDeletePopup.y + 8}px)` }}
            onClick={(event) => event.stopPropagation()}
          >
            {menuMoveStatus && (
              <span className="tree-move-menu-status">{REPERTOIRE_MOVE_LABELS[menuMoveStatus]}</span>
            )}
            {menuMoveStatus && menuMoveStatus !== 'main' && !trainingSession && !isTreeEvalRunning &&
              (Object.keys(REPERTOIRE_MOVE_LABELS) as RepertoireMoveStatus[])
                .filter(status => status !== menuMoveStatus)
                .map(status => (
                  <button key={status} type="button" data-move-status={status} onClick={() => changeMoveStatus(status)}>
                    Set as {REPERTOIRE_MOVE_LABELS[status].toLowerCase()}
                  </button>
                ))}
            {menuNode?.moveUci && isEditingRepertoire && !trainingSession && !isTreeEvalRunning && (
              <button type="button" onClick={() => {
                setMoveCommentEditor({ nodeId: menuNode.id, draft: menuNode.comment ?? '' });
                setTreeOptionDeletePopup(null);
              }}>
                {menuNode.comment ? 'Edit comment' : 'Add comment'}
              </button>
            )}
            <button type="button" className="danger" onClick={deleteTreeOptionBranch}>
              Delete branch
            </button>
          </div>
        </>
      )}

      {moveCommentEditor && isEditingRepertoire && (
        <div className="modal-backdrop" onClick={() => setMoveCommentEditor(null)}>
          <form className="modal-card stockfish-quick-modal move-comment-editor" role="dialog" aria-modal="true"
            aria-labelledby="move-comment-title" onClick={event => event.stopPropagation()}
            onSubmit={event => { event.preventDefault(); saveMoveComment(); }}>
            <label id="move-comment-title" htmlFor="move-comment">Move comment</label>
            <textarea id="move-comment" rows={4} value={moveCommentEditor.draft}
              onChange={event => setMoveCommentEditor({ ...moveCommentEditor, draft: event.target.value })} />
            <div className="game-analysis-modal-actions">
              <button type="button" onClick={() => setMoveCommentEditor(null)}>Cancel</button>
              <button type="submit">Save comment</button>
            </div>
          </form>
        </div>
      )}

      {isStockfishQuickOpen && (
        <div className="modal-backdrop" onClick={() => setIsStockfishQuickOpen(false)}>
          <div className="modal-card stockfish-quick-modal" onClick={(e) => e.stopPropagation()}>
            <div className="slider-stack single-column">
              <label>
                {`${STOCKFISH_ENGINE_NAME} depth: ${engineDepth}`}
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
              <label>
                {`Add eval seconds: ${stockfishEvalSeconds}s`}
                <span className="slider-field">
                  <input
                    className="threshold-slider"
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={stockfishEvalSeconds}
                    onChange={(e) => {
                      const next = Number.parseInt(e.target.value, 10);
                      if (Number.isFinite(next)) setStockfishEvalSeconds(Math.min(30, Math.max(1, next)));
                    }}
                  />
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {isTrainingStatsMenuOpen && (
        <div className="modal-backdrop" onClick={() => setIsTrainingStatsMenuOpen(false)}>
          <div className="modal-card stockfish-quick-modal" role="dialog" aria-modal="true" aria-labelledby="training-options-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="training-options-title" className="eval-manager-title">Training options</h3>
            <label className="inline-check">
              <input type="checkbox" checked={trainAlternativeMoves} disabled={isTrainingActive}
                onChange={event => setTrainAlternativeMoves(event.target.checked)} />
              Include alternative moves in training
            </label>
            <div className="slider-stack single-column">
              <label>
                {`Stats FIFO length: ${trainingStatsQueueLength}`}
                <span className="slider-field">
                  <input
                    className="threshold-slider"
                    type="range"
                    min={TRAINING_STATS_QUEUE_MIN}
                    max={TRAINING_STATS_QUEUE_MAX}
                    step={1}
                    value={trainingStatsQueueLength}
                    onChange={(event) => setTrainingStatsQueueLength(Number(event.target.value))}
                  />
                </span>
              </label>
            </div>
            <div className="training-stats-menu-actions">
              <button type="button" onClick={clearActiveTrainingStatistics}>Clear current repertoire stats</button>
              <button type="button" onClick={clearAllTrainingStatistics}>Clear all stats</button>
              <button type="button" onClick={() => setIsTrainingStatsMenuOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {isFindMissingOptionsOpen && (
        <div className="modal-backdrop" onClick={() => setIsFindMissingOptionsOpen(false)}>
          <div className="modal-card stockfish-quick-modal" role="dialog" aria-modal="true"
            aria-label={isPlayerExplorer ? 'Find missing opponent moves options' : 'Find missing popular moves options'}
            onClick={(event) => event.stopPropagation()}>
            <label>
              {`Min frequency: ${isPlayerExplorer ? playerNextMissingMoveThreshold : nextMissingMoveThreshold}%`}
              <span className="slider-field">
                <input
                  className="threshold-slider min-frequency-slider"
                  type="range"
                  min={0}
                  max={MOVE_THRESHOLD_OPTIONS.length - 1}
                  step={1}
                  value={MOVE_THRESHOLD_OPTIONS.indexOf(isPlayerExplorer ? playerNextMissingMoveThreshold : nextMissingMoveThreshold)}
                  onChange={(event) => {
                    const threshold = MOVE_THRESHOLD_OPTIONS[Number(event.target.value)];
                    if (threshold === undefined) return;
                    if (isPlayerExplorer) setPlayerNextMissingMoveThreshold(threshold);
                    else setNextMissingMoveThreshold(threshold);
                    if (opponentReview) closeOpponentFinding();
                  }}
                />
              </span>
            </label>
          </div>
        </div>
      )}

      {isLichessArrowOptionsOpen && (
        <div className="modal-backdrop" onClick={() => setIsLichessArrowOptionsOpen(false)}>
          <div className="modal-card stockfish-quick-modal" role="dialog" aria-modal="true" aria-label="Lichess arrow options" onClick={(event) => event.stopPropagation()}>
            <label className="inline-check">
              <input type="checkbox" checked={showLichessOnTreeMoves} onChange={(event) => setShowLichessOnTreeMoves(event.target.checked)} />
              Show Lichess arrows for tree moves
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={lichessArrowsOpponentOnly} onChange={(event) => setLichessArrowsOpponentOnly(event.target.checked)} />
              Show Lichess arrows only on the opponent’s turn
            </label>
          </div>
        </div>
      )}

      {isTreeArrowOptionsOpen && (
        <div className="modal-backdrop" onClick={() => setIsTreeArrowOptionsOpen(false)}>
          <div className="modal-card stockfish-quick-modal" role="dialog" aria-modal="true" aria-label="Tree arrow options" onClick={(event) => event.stopPropagation()}>
            <label className="inline-check">
              <input type="checkbox" checked={showMistakeArrows} onChange={(event) => setShowMistakeArrows(event.target.checked)} />
              Show red arrows for mistakes
            </label>
          </div>
        </div>
      )}

      {isMistakeHistoryOptionsOpen && (
        <div className="modal-backdrop" onClick={() => setIsMistakeHistoryOptionsOpen(false)}>
          <div className="modal-card stockfish-quick-modal" role="dialog" aria-modal="true" aria-label="Find common mistakes options" onClick={(event) => event.stopPropagation()}>
            <label className="inline-check">
              Look for mistakes in
              <select value={mistakeHistoryMonths} onChange={(event) => {
                const months = MISTAKE_HISTORY_WINDOWS.find(window => window === Number(event.target.value));
                if (!months) return;
                setMistakeHistoryMonths(months);
                closeMistakeReview();
              }}>
                <option value={1}>Last month</option>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last year</option>
              </select>
            </label>
          </div>
        </div>
      )}

      {isSuddenDeathSettingsOpen && (
        <div className="modal-backdrop" onClick={() => setIsSuddenDeathSettingsOpen(false)}>
          <div className="modal-card stockfish-quick-modal sudden-death-settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">Sudden death settings</h3>
            <div className="slider-stack single-column">
              <label>
                Engine
                <span className="toggle-group database-toggle">
                  <button
                    type="button"
                    className={suddenDeathEngine === 'stockfish' ? 'active' : ''}
                    onClick={() => setSuddenDeathEngine('stockfish')}
                  >
                    {STOCKFISH_ENGINE_LABEL}
                  </button>
                  <button
                    type="button"
                    className={suddenDeathEngine === 'maia' ? 'active' : ''}
                    onClick={() => setSuddenDeathEngine('maia')}
                  >
                    {MAIA_ENGINE_LABEL}
                  </button>
                </span>
              </label>
              <label>
                {`Max think time: ${suddenDeathMaxThinkTimeSec.toFixed(1)}s`}
                <span className="slider-field">
                  <input
                    className="threshold-slider"
                    type="range"
                    min={SUDDEN_DEATH_THINK_TIME_MIN}
                    max={SUDDEN_DEATH_THINK_TIME_MAX}
                    step={0.1}
                    value={suddenDeathMaxThinkTimeSec}
                    onChange={(e) => {
                      const next = Number.parseFloat(e.target.value);
                      if (Number.isFinite(next)) {
                        setSuddenDeathMaxThinkTimeSec(
                          Math.min(SUDDEN_DEATH_THINK_TIME_MAX, Math.max(SUDDEN_DEATH_THINK_TIME_MIN, next)),
                        );
                      }
                    }}
                  />
                </span>
              </label>
              <label>
                {`Drop threshold: ${suddenDeathThreshold.toFixed(1)}`}
                <span className="slider-field">
                  <input
                    className="threshold-slider"
                    type="range"
                    min={SUDDEN_DEATH_THRESHOLD_MIN}
                    max={SUDDEN_DEATH_THRESHOLD_MAX}
                    step={0.1}
                    value={suddenDeathThreshold}
                    onChange={(e) => {
                      const next = Number.parseFloat(e.target.value);
                      if (Number.isFinite(next)) {
                        setSuddenDeathThreshold(
                          Math.min(SUDDEN_DEATH_THRESHOLD_MAX, Math.max(SUDDEN_DEATH_THRESHOLD_MIN, next)),
                        );
                      }
                    }}
                  />
                </span>
              </label>
              {suddenDeathEngine === 'stockfish' && (
                <label>
                  {`${STOCKFISH_ENGINE_NAME}: ${suddenDeathStockfishElo >= SUDDEN_DEATH_STOCKFISH_ELO_MAX ? 'Max' : suddenDeathStockfishElo}`}
                  <span className="slider-field">
                    <input
                      className="threshold-slider"
                      type="range"
                      min={SUDDEN_DEATH_STOCKFISH_ELO_MIN}
                      max={SUDDEN_DEATH_STOCKFISH_ELO_MAX}
                      step={50}
                      value={suddenDeathStockfishElo}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(next)) {
                          setSuddenDeathStockfishElo(
                            Math.min(SUDDEN_DEATH_STOCKFISH_ELO_MAX, Math.max(SUDDEN_DEATH_STOCKFISH_ELO_MIN, next)),
                          );
                        }
                      }}
                    />
                  </span>
                </label>
              )}
              {suddenDeathEngine === 'maia' && (
                <label>
                  {`${MAIA_ENGINE_LABEL}: ${suddenDeathMaiaElo}`}
                  <span className="slider-field">
                    <input
                      className="threshold-slider"
                      type="range"
                      min={MAIA_STRENGTH_ELO_MIN}
                      max={MAIA_STRENGTH_ELO_MAX}
                      step={MAIA_STRENGTH_ELO_STEP}
                      value={suddenDeathMaiaElo}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(next)) {
                          setSuddenDeathMaiaElo(
                            Math.min(MAIA_STRENGTH_ELO_MAX, Math.max(MAIA_STRENGTH_ELO_MIN, next)),
                          );
                        }
                      }}
                    />
                  </span>
                </label>
              )}
            </div>
          </div>
        </div>
      )}

      {isEvalManagerOpen && (
        <div className="modal-backdrop" onClick={() => { if (!isTreeEvalRunning) setIsEvalManagerOpen(false); }}>
          <div className="modal-card stockfish-quick-modal eval-manager-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">{`${STOCKFISH_ENGINE_NAME} evals`}</h3>
            <div className="eval-progress-block">
              <div className="eval-progress-label">
                {`Cloud API: ${treeEvalProgress?.cloud.done ?? 0}/${treeEvalProgress?.cloud.total ?? treeEvalScopeStats.missing}`}
              </div>
              <div className="eval-progress-track">
                <div
                  className="eval-progress-fill cloud"
                  style={{
                    width: `${Math.round(
                      ((treeEvalProgress?.cloud.done ?? 0) /
                        Math.max(1, treeEvalProgress?.cloud.total ?? treeEvalScopeStats.missing)) *
                        100,
                    )}%`,
                  }}
                />
              </div>
            </div>
            <div className="eval-progress-block">
              <div className="eval-progress-label">
                {`Local fallback: ${treeEvalProgress?.local.done ?? 0}/${treeEvalProgress?.local.total ?? 0}`}
              </div>
              <div className="eval-progress-track">
                <div
                  className="eval-progress-fill local"
                  style={{
                    width: `${Math.round(
                      ((treeEvalProgress?.local.done ?? 0) / Math.max(1, treeEvalProgress?.local.total ?? 0)) * 100,
                    )}%`,
                  }}
                />
              </div>
            </div>
            <div className="eval-manager-summary">
              {`Nodes with evals: ${treeEvalScopeStats.total - treeEvalScopeStats.missing}/${treeEvalScopeStats.total}`}
            </div>
            {maiaTreeStatus && <div className="maia-load-error" role="alert">Maia: {maiaTreeStatus}</div>}
            <div className="eval-manager-actions">
              <button
                type="button"
                onClick={() => {
                  void runTreeStockfishEval();
                }}
                disabled={isTreeEvalRunning || treeEvalScopeStats.missing === 0}
              >
                Start process
              </button>
              <button type="button" onClick={stopTreeStockfishEval} disabled={!isTreeEvalRunning}>
                Stop
              </button>
              <button type="button" className="danger" onClick={clearAllTreeStockfishEvals} disabled={isTreeEvalRunning}>
                Remove all existing evals
              </button>
            </div>
          </div>
        </div>
      )}


      {isDbStatsOpen && (
        <div className="modal-backdrop" onClick={() => setIsDbStatsOpen(false)}>
          <div className="modal-card db-stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">DB stats</h3>
            {(['white', 'black'] as Side[]).map((side) => (
              <section key={side} className="db-stats-side">
                <h4>{side}</h4>
                {dbStatsBySide[side].length === 0 ? (
                  <div className="status">No repertoires</div>
                ) : (
                  <div className="db-stats-list">
                    {dbStatsBySide[side].map((entry) => (
                      <div key={entry.id} className="db-stats-item">
                        <div className="db-stats-name" title={entry.name}>
                          {entry.name}
                        </div>
                        <div className="db-stats-values">
                          <span>{`Nodes: ${entry.nodeCount}`}</span>
                          <span>{`Leaves: ${entry.leafCount}`}</span>
                          <span>{`Missing evals: ${entry.missingEvalCount}`}</span>
                        </div>
                        <div className="db-stats-values db-stats-training">
                          <span>{`Lines trained: ${entry.trainedLineCount}/${entry.leafCount} (${entry.trainedCoveragePct}%)`}</span>
                          <span>{`Positions trained: ${entry.trainedPositionCount}`}</span>
                          <span>{`Recent attempts: ${entry.recentAttemptCount}`}</span>
                          <span>{`Recent success: ${entry.recentSuccessPct ?? 0}%`}</span>
                          <span>{`Avg position success: ${entry.avgPositionSuccessPct ?? 0}%`}</span>
                          <span>{`Last trained: ${formatTrainedAt(entry.lastTrainedAt)}`}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      )}

      {isOptionsOpen && (
        <div className="modal-backdrop" onClick={() => { if (!isTreeEvalRunning) setIsOptionsOpen(false); }}>
          <div className="modal-card options-modal" onClick={(e) => e.stopPropagation()}>
            <div
              className={`current-repertoire ${!isBrowseMode ? 'active-repertoire' : ''} ${isEditingRepertoire ? 'editing-repertoire' : ''}`}
              title={activeRepertoireName}
            >
              {isBrowseMode ? activeRepertoireName : `${activeSide}: ${activeRepertoireName}`}
            </div>
            <div className="options-grid">
              {isBrowseMode && <AnalysisButton
                dark={themeMode === 'dark'}
                onQuick={() => { setIsOptionsOpen(false); void analyzeCurrentGame(); }}
                onDeep={() => { setIsOptionsOpen(false); void analyzeCurrentGame(true); }}
                onReport={gameAnalysisReport && gameAnalysisReportMatchesLine ? () => { setIsOptionsOpen(false); setShowAnalysisReport(true); } : undefined}
                benchmark={analysisBenchmarkElo} onBenchmarkChange={setAnalysisBenchmarkElo}
                context={analysisContext} onContextChange={updateAnalysisContext}
                running={Boolean(analysisGameProgress)}
                disabled={isTrainingActive || isSuddenDeathActive || isExampleReplayActive || isTreeEvalRunning || (!analysisGameProgress && mainLinePath.length < 2)}>
                {analysisGameProgress ? 'Stop analysis' : 'Analyze game'}
              </AnalysisButton>}
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  setIsTempBoardFlipped((prev) => !prev);
                  setIsOptionsOpen(false);
                }}
              >
                Rotate board
              </button>
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  setNewRepertoireName('');
                  setIsNewRepertoireOpen(true);
                  setIsOptionsOpen(false);
                }}
              >
                New repertoire ({newRepertoireSide})
              </button>
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  setIsLoadRepertoireOpen(true);
                  setIsOptionsOpen(false);
                }}
              >
                Load repertoire ({loadRepertoireSide})
              </button>
              <button
                disabled={isTreeEvalRunning || isBackupIoRunning || Boolean(analysisGameProgress)}
                onClick={() => {
                  setIsOptionsOpen(false);
                  setImportMode('review');
                  importInputRef.current?.click();
                }}
              >
                Load PGN
              </button>
              <button
                disabled={isTreeEvalRunning || isBackupIoRunning || mainLinePath.length < 2}
                onClick={() => { void saveCurrentGamePgn(); }}
              >
                Save PGN
              </button>
              <button
                disabled={isBrowseMode || isTreeEvalRunning}
                onClick={() => {
                  exportCurrentRepertoirePgn();
                  setIsOptionsOpen(false);
                }}
              >
                Export current repertoire PGN
              </button>
              <button
                disabled={isBrowseMode || isTreeEvalRunning}
                onClick={() => {
                  openImportDialog('current');
                  setIsOptionsOpen(false);
                }}
              >
                Import into current repertoire
              </button>
              <button
                onClick={() => {
                  setIsOptionsOpen(false);
                  setIsEvalManagerOpen(true);
                }}
              >
                {`Add ${STOCKFISH_ENGINE_NAME} evals`}
              </button>
              <button
                onClick={() => {
                  setIsOptionsOpen(false);
                  setIsDbStatsOpen(true);
                }}
              >
                DB stats
              </button>
              <button
                disabled={isTreeEvalRunning || !hasExportableDbGames}
                onClick={() => {
                  exportWholeDatabasePgn();
                  setIsOptionsOpen(false);
                }}
              >
                Export whole DB PGN
              </button>
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  openImportDialog('db');
                  setIsOptionsOpen(false);
                }}
              >
                Import whole DB
              </button>
              <button
                disabled={isTreeEvalRunning || isBackupIoRunning}
                onClick={() => {
                  void saveBackupToFile();
                }}
              >
                {isBackupIoRunning ? 'Saving...' : 'Save backup'}
              </button>
              <button
                disabled={isTreeEvalRunning || isBackupIoRunning}
                onClick={() => {
                  void restoreBackupFromFilePicker();
                }}
              >
                {isBackupIoRunning ? 'Restoring...' : 'Restore backup'}
              </button>
              <button
                className="danger"
                disabled={isTreeEvalRunning}
                onClick={clearWholeDatabase}
              >
                Delete whole DB
              </button>
              {isMobileClient && (
                <button
                  disabled={isTreeEvalRunning}
                  onClick={() => {
                    void shareFen();
                    setIsOptionsOpen(false);
                  }}
                >
                  Share FEN
                </button>
              )}
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  openInLichessAnalysis();
                  setIsOptionsOpen(false);
                }}
              >
                Analyse with Lichess
              </button>
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
                  setIsOptionsOpen(false);
                }}
              >
                {themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
            </div>
            <div className="options-footer-link-wrap">
              <a
                className="options-footer-link"
                href={PROJECT_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer external"
                aria-label="Open project on GitHub"
                title="Open project on GitHub"
                onClick={(event) => {
                  event.preventDefault();
                  openProjectGithub();
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 2A10 10 0 0 0 2 12C2 16.42 4.87 20.17 8.84 21.5C9.34 21.58 9.5 21.27 9.5 21V19.22C6.73 19.82 6.14 17.88 6.14 17.88C5.68 16.73 5.03 16.42 5.03 16.42C4.12 15.8 5.1 15.82 5.1 15.82C6.1 15.89 6.63 16.85 6.63 16.85C7.53 18.38 8.97 17.94 9.54 17.69C9.63 17.03 9.89 16.58 10.18 16.32C7.97 16.07 5.65 15.21 5.65 11.39C5.65 10.31 6.04 9.43 6.68 8.75C6.58 8.5 6.24 7.45 6.77 6.07C6.77 6.07 7.61 5.8 9.5 7.08C10.29 6.86 11.15 6.75 12 6.75C12.85 6.75 13.71 6.86 14.5 7.08C16.39 5.8 17.23 6.07 17.23 6.07C17.76 7.45 17.42 8.5 17.32 8.75C17.96 9.43 18.35 10.31 18.35 11.39C18.35 15.22 16.02 16.06 13.81 16.31C14.17 16.62 14.5 17.24 14.5 18.19V21C14.5 21.27 14.66 21.59 15.17 21.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2Z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      )}

      {isNewRepertoireOpen && (
        <div className="modal-backdrop" onClick={() => setIsNewRepertoireOpen(false)}>
          <div className="modal-card options-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>New repertoire ({newRepertoireSide})</h2>
            </div>
            <div className="options-grid">
              <label className="repertoire-name-row">
                Name
                <input
                  type="text"
                  value={newRepertoireName}
                  onChange={(e) => setNewRepertoireName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      createNewRepertoire(newRepertoireSide);
                    }
                  }}
                  placeholder="e.g. Sicilian mainline"
                  autoFocus
                />
              </label>
              <button type="button" onClick={() => createNewRepertoire(newRepertoireSide)}>
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsNewRepertoireOpen(false);
                  setNewRepertoireName('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoadRepertoireOpen && (
        <div className="modal-backdrop" onClick={() => { setIsLoadRepertoireOpen(false); cancelRenamingRepertoire(); }}>
          <div className="modal-card options-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>Load repertoire ({loadRepertoireSide})</h2>
            </div>
            <div className="options-grid">
              <div className="repertoire-list">
                {loadableRepertoiresForBoardSide.length === 0 && <span className="status">No saved repertoires</span>}
                {loadableRepertoiresForBoardSide.map((entry) => (
                  <div key={entry.id} className="repertoire-row">
                    {renamingRepertoireId === entry.id ? (
                      <>
                        <input
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              commitRenameRepertoire(entry.id, loadRepertoireSide);
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelRenamingRepertoire();
                            }
                          }}
                          autoFocus
                        />
                        <button type="button" onClick={() => commitRenameRepertoire(entry.id, loadRepertoireSide)}>
                          Save
                        </button>
                        <button type="button" onClick={cancelRenamingRepertoire}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {entry.enabled ? (
                          <RepertoireSelectButton
                            name={entry.name}
                            mode={entry.id === activeRepertoireIdBySide[loadRepertoireSide] ? repertoireModeBySide[loadRepertoireSide] : null}
                            className={entry.id === activeRepertoireIdBySide[loadRepertoireSide]
                              ? `active ${repertoireModeBySide[loadRepertoireSide] === 'edit' ? 'editing-repertoire' : ''}` : ''}
                            onSelect={(mode) => loadRepertoire(entry.id, loadRepertoireSide, false, mode)}
                          />
                        ) : (
                          <span className="repertoire-inactive-name">{entry.name}</span>
                        )}
                        <button
                          type="button"
                          aria-label={`${entry.enabled ? 'Deactivate' : 'Activate'} ${entry.name}`}
                          onClick={() => toggleRepertoireEnabled(entry, loadRepertoireSide)}
                        >
                          {entry.enabled ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          aria-label="Rename repertoire"
                          title="Rename repertoire"
                          onClick={() => startRenamingRepertoire(entry.id, loadRepertoireSide)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          aria-label="Delete repertoire"
                          title="Delete repertoire"
                          className="danger"
                          onClick={() => deleteRepertoire(entry.id, loadRepertoireSide)}
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => { setIsLoadRepertoireOpen(false); cancelRenamingRepertoire(); }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {isLichessFilterOpen && (
        <div className="modal-backdrop" onClick={() => { setIsLichessFilterOpen(false); setIsLichessTokenEditorOpen(false); }}>
          <div className="modal-card filters-modal" role="dialog" aria-modal="true" aria-label="Lichess filters" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className={`filters-grid${isPlayerExplorer ? ' filters-grid-player' : ''}`}>
                <label className="filters-database">
                  Lichess Database
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
                      onClick={() => {
                        setLichessSource(prev => prev === 'player' ? 'lichess' : 'player');
                        setPortraitTab('lichess');
                      }}
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
                        disabled={playerHistorySyncing}
                        onChange={(e) => setPlayerHandle(e.target.value)}
                        placeholder="Lichess handle"
                      />
                    </span>
                  )}
                  {isPlayerExplorer && historyPlayer && (
                    <span className="player-handle-row">
                      <button type="button" disabled={playerHistorySyncing || isFindMissingSearchRunning}
                        onClick={() => setPlayerHistoryRefresh(value => value + 1)}>
                        {playerHistorySyncing ? 'Syncing games…' : 'Sync games'}
                      </button>
                    </span>
                  )}
                  {shouldShowLichessAddTokenButton && (
                    <span className="player-handle-row">
                      <button type="button" onClick={() => setIsLichessTokenEditorOpen(true)}>
                        Add token
                      </button>
                    </span>
                  )}
                </label>
                {isPlayerExplorer && (
                  <section className="player-history-summary" aria-label="Synced game history">
                    <div className="player-history-summary-head">
                      <strong>Synced games · last 12 months</strong>
                      {savedPlayerHistory && <span>{(playerHistoryStats?.count ?? 0).toLocaleString()} games</span>}
                    </div>
                    {!historyPlayer ? <span>Enter a Lichess handle to sync your games.</span>
                      : playerHistorySyncing ? <span>Syncing games…</span>
                      : playerHistoryError ? <span className="player-history-summary-error">{playerHistoryError}</span>
                      : !savedPlayerHistory ? <span>No games synced yet.</span>
                      : playerHistoryStats?.count ? (
                        <>
                          <span>Game dates: {new Date(playerHistoryStats.first).toLocaleDateString()} – {new Date(playerHistoryStats.last).toLocaleDateString()}</span>
                          <span>Last game: {new Date(playerHistoryStats.last).toLocaleString()}</span>
                          <span>Last sync: {new Date(savedPlayerHistory.syncedAt).toLocaleString()}</span>
                        </>
                      ) : <span>No completed games in the stored period.</span>}
                    <small>Date, speed, and mode filters change the displayed results. Game sync keeps all standard games from the last 12 months.</small>
                  </section>
                )}
                <label className="filters-date-range">
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
                    {lichessSource !== 'player' && (
                      <button
                        type="button"
                        className={dateRange === '5y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '5y' ? null : '5y'))}
                      >
                        5Y
                      </button>
                    )}
                    {lichessSource !== 'player' && (
                      <button
                        type="button"
                        className={dateRange === '10y' ? 'active' : ''}
                        onClick={() => setDateRange((prev) => (prev === '10y' ? null : '10y'))}
                      >
                        10Y
                      </button>
                    )}
                  </span>
                </label>
              </div>

              {(lichessSource === 'lichess' || lichessSource === 'player') && (
                <div className="checkbox-grid">
                <div>
                  <strong>Speeds</strong>
                  {(isPlayerExplorer ? PLAYER_SPEEDS : SPEEDS).map((speed) => (
                    <label key={speed} className="inline-check">
                      <input
                        type="checkbox"
                        checked={(isPlayerExplorer ? playerSpeeds : selectedSpeeds).includes(speed)}
                        onChange={(e) => {
                          const setSpeeds = isPlayerExplorer ? setPlayerSpeeds : setSelectedSpeeds;
                          const checked = e.target.checked;
                          setSpeeds(prev => checked ? [...prev, speed]
                            : isPlayerExplorer && prev.length === 1 ? prev : prev.filter(item => item !== speed));
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
            <div className="filters-modal-frequency">
              <div className="slider-stack">
                <label>
                  {`${isPlayerExplorer ? 'Min arrow frequency' : 'Min frequency'}: ${lichessArrowThreshold}%`}
                  <span className="slider-field">
                    <input
                      className="threshold-slider min-frequency-slider"
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
              </div>
            </div>
          </div>
        </div>
      )}
      {isLichessTokenEditorOpen && (
        <div className="modal-backdrop" onClick={closeLichessTokenEditor}>
          <div className="modal-card options-modal token-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>Lichess token</h2>
            </div>
            <div className="options-grid">
              <span className="status token-editor-help">
                Add your personal Lichess API token to enable Lichess DB explorer requests.
              </span>
              <a
                className="token-editor-link"
                href="https://lichess.org/account/oauth/token"
                target="_blank"
                rel="noopener noreferrer"
              >
                https://lichess.org/account/oauth/token
              </a>
              <label className="repertoire-name-row">
                Token
                <input
                  type="password"
                  value={lichessApiToken}
                  onChange={(e) => setLichessApiToken(e.target.value)}
                  placeholder="Paste token"
                  autoFocus
                />
              </label>
              <button type="button" onClick={closeLichessTokenEditor}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;







