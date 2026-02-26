import {
  useCallback,
  useEffect,
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
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './App.css';

type Side = 'white' | 'black';
type LichessSource = 'lichess' | 'masters' | 'player';
type DateRange = '1m' | '2m' | '3m' | '6m' | '1y' | '3y' | '5y' | '10y' | '20y' | '30y' | '50y' | null;
type ThemeMode = 'light' | 'dark';

type MoveNode = {
  id: string;
  parentId: string | null;
  fen: string;
  moveSan: string | null;
  moveUci: string | null;
  stockfishEval?: string | null;
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

type LichessResponseCacheEntry = {
  expiresAt: number;
  data: LichessResponse;
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
  suddenDeathPromptFen: string | null;
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

type SuddenDeathGameOverState = {
  side: Side;
  startNodeId: string;
  baselineEvalCp: number;
  failedEvalCp: number;
  thresholdCp: number;
};

type PersistedAppState = {
  version: 2;
  repertoiresBySide: Record<Side, RepertoireEntry[]>;
  activeRepertoireIdBySide: Record<Side, string | null>;
};

type LegacyPersistedAppState = {
  version: 1;
  trees: Record<Side, MoveTree>;
  selectedNodeBySide: Record<Side, string>;
};

type RepertoireEntry = {
  id: string;
  name: string;
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
  repertoireSide: Side;
  isTempBoardFlipped: boolean;
  lichessSource: LichessSource;
  playerHandle: string;
  dateRange: DateRange;
  lichessArrowThreshold: MoveThreshold;
  engineDepth: number;
  engineMultiPv: number;
  selectedSpeeds: string[];
  selectedRatings: number[];
  selectedModes: string[];
  showLichessOnTreeMoves: boolean;
  showTreeArrows: boolean;
  showLichessArrows: boolean;
  showStockfishArrows: boolean;
  stockfishEvalSeconds: number;
  trainingStatsQueueLength: number;
  suddenDeathThreshold: number;
  suddenDeathMinMoves: number;
  suddenDeathStockfishElo: number;
  suddenDeathMaxThinkTimeSec: number;
  nextMissingMoveThreshold: MoveThreshold;
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
type MoveThreshold = (typeof MOVE_THRESHOLD_OPTIONS)[number];
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
const APP_DB_NAME = 'opening-prep-db';
const APP_DB_VERSION = 1;
const PROJECT_GITHUB_URL = 'https://github.com/zoltkowski/chess-openings';
const APP_DB_STORE = 'kv';
const APP_STATE_KEY = 'app-state-v1';
const APP_SETTINGS_KEY = 'settings-v1';
const APP_TRAINING_STATS_KEY = 'training-stats-v1';
const APP_TRAINING_LEAF_LAST_SHOWN_KEY = 'training-leaf-last-shown-v1';
const APP_LICHESS_RESPONSE_CACHE_KEY = 'lichess-response-cache-v1';
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
// Conservative pacing for explorer API requests to avoid 429 and respect public API usage guidance.
const LICHESS_API_MIN_INTERVAL_MS = 2000;
const LICHESS_API_COOLDOWN_FALLBACK_MS = 120000;
const LICHESS_CACHE_PLAYER_TTL_MS = 24 * 60 * 60 * 1000;
const LICHESS_CACHE_DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;
const LICHESS_CACHE_DEFAULT_JITTER_MS = 5 * 24 * 60 * 60 * 1000;
const LICHESS_API_HEALTHCHECK_INTERVAL_MS = 15 * 60 * 1000;
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

function isValidMoveTree(value: unknown): value is MoveTree {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as MoveTree;
  if (typeof candidate.rootId !== 'string') return false;
  if (typeof candidate.nextId !== 'number' || !Number.isFinite(candidate.nextId)) return false;
  if (!candidate.nodes || typeof candidate.nodes !== 'object') return false;
  return true;
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
      repertoiresBySide: {
        white: whiteList,
        black: blackList,
      },
      activeRepertoireIdBySide: {
        white: whiteActive && whiteList.some((entry) => entry.id === whiteActive) ? whiteActive : null,
        black: blackActive && blackList.some((entry) => entry.id === blackActive) ? blackActive : null,
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
    tree: whiteTree,
    selectedNodeId: whiteTree.nodes[parsedV1.selectedNodeBySide.white] ? parsedV1.selectedNodeBySide.white : whiteTree.rootId,
  };
  const blackRepertoire: RepertoireEntry = {
    id: createRepertoireId('black'),
    name: 'Imported black repertoire',
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
  const normalizedThemeMode: ThemeMode = parsed.themeMode === 'dark' ? 'dark' : 'light';
  const dateRangeValues: DateRange[] = ['1m', '2m', '3m', '6m', '1y', '3y', '5y', '10y', '20y', '30y', '50y', null];
  if (!dateRangeValues.includes(parsed.dateRange)) return null;
  return {
    ...parsed,
    themeMode: normalizedThemeMode,
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
  };
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

function positionFenKey(fen: string) {
  const fullFen = boardFen(fen);
  const parts = fullFen.split(' ');
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

  const [mainChildId, ...alternativeChildIds] = children;
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
      coordinates: false,
      coordinatesOnSquares: false,
      ranksPosition: 'left',
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
      coordinates: false,
      coordinatesOnSquares: false,
      ranksPosition: 'left',
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
  const initialThemeMode: ThemeMode = 'light';
  const initialLichessSource: LichessSource = 'lichess';
  const initialPlayerHandle = '';
  const initialDateRange: DateRange = null;
  const initialLichessArrowThreshold = 5;
  const initialEngineDepth = 24;
  const initialSelectedSpeeds: string[] = SPEEDS.filter((speed) => speed !== 'bullet');
  const initialSelectedRatings: number[] = [2000, 2200, 2500];
  const initialSelectedModes: string[] = [...MODES];
  const initialTrainingStatsQueueLength = 5;
  const initialSuddenDeathThreshold = 1;
  const initialSuddenDeathMinMoves = 4;
  const initialSuddenDeathStockfishElo = 2000;
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
  const [repertoireSide, setRepertoireSide] = useState<'white' | 'black'>('white');
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [isTempBoardFlipped, setIsTempBoardFlipped] = useState(false);
  const [, setStatus] = useState('Ready');
  const [engineDepth, setEngineDepth] = useState(initialEngineDepth);
  const [stockfishEvalSeconds, setStockfishEvalSeconds] = useState(10);
  const [trainingStatsQueueLength, setTrainingStatsQueueLength] = useState(initialTrainingStatsQueueLength);
  const [suddenDeathThreshold, setSuddenDeathThreshold] = useState(initialSuddenDeathThreshold);
  const [suddenDeathMinMoves, setSuddenDeathMinMoves] = useState(initialSuddenDeathMinMoves);
  const [suddenDeathStockfishElo, setSuddenDeathStockfishElo] = useState(initialSuddenDeathStockfishElo);
  const [suddenDeathMaxThinkTimeSec, setSuddenDeathMaxThinkTimeSec] = useState(initialSuddenDeathMaxThinkTimeSec);
  const [engineMultiPv, setEngineMultiPv] = useState(3);
  const [showStockfishArrows, setShowStockfishArrows] = useState(true);
  const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
  const [engineStatus, setEngineStatus] = useState('stopped');
  const [engineRunning, setEngineRunning] = useState(false);
  const [lichessData, setLichessData] = useState<LichessResponse | null>(null);
  const [lichessDataFen, setLichessDataFen] = useState<string | null>(null);
  const [openingByFen, setOpeningByFen] = useState<Record<string, { eco: string; name: string }>>({});
  const [lichessStatus, setLichessStatus] = useState('idle');
  const [lichessApiIssueNote, setLichessApiIssueNote] = useState('');
  const [lichessRateLimitedUntil, setLichessRateLimitedUntil] = useState<number | null>(null);
  const [showTreeArrows, setShowTreeArrows] = useState(true);
  const [showLichessArrows, setShowLichessArrows] = useState(true);
  const [showLichessOnTreeMoves, setShowLichessOnTreeMoves] = useState(true);
  const [isLichessFilterOpen, setIsLichessFilterOpen] = useState(false);
  const [lichessSource, setLichessSource] = useState<LichessSource>(initialLichessSource);
  const [playerHandle, setPlayerHandle] = useState(initialPlayerHandle);
  const [dateRange, setDateRange] = useState<DateRange>(initialDateRange);
  const [lichessArrowThreshold, setLichessArrowThreshold] = useState<MoveThreshold>(initialLichessArrowThreshold);
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
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
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
  const [renamingRepertoireId, setRenamingRepertoireId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [importMode, setImportMode] = useState<'current' | 'db'>('current');
  const [portraitTab, setPortraitTab] = useState<'lichess' | 'stockfish' | 'moves'>('moves');
  const [trainingSession, setTrainingSession] = useState<TrainingSession | null>(null);
  const [trainingStatsBySide, setTrainingStatsBySide] = useState<TrainingStatsState>(createEmptyTrainingStatsState());
  const [trainingLeafLastShownBySide, setTrainingLeafLastShownBySide] = useState<TrainingLeafLastShownState>(
    createEmptyTrainingLeafLastShownState(),
  );
  const [suddenDeathGameOver, setSuddenDeathGameOver] = useState<SuddenDeathGameOverState | null>(null);
  const [suddenDeathStartNodeId, setSuddenDeathStartNodeId] = useState<string | null>(null);
  const [suddenDeathCurrentFen, setSuddenDeathCurrentFen] = useState<string | null>(null);
  const [suddenDeathLastMove, setSuddenDeathLastMove] = useState<[Key, Key] | null>(null);
  const [treeEvalProgress, setTreeEvalProgress] = useState<TreeEvalProgressState | null>(null);
  const [isEvalManagerOpen, setIsEvalManagerOpen] = useState(false);
  const [isDbStatsOpen, setIsDbStatsOpen] = useState(false);
  const [suddenDeathThinking, setSuddenDeathThinking] = useState(false);

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
  const backupImportInputRef = useRef<HTMLInputElement | null>(null);
  const [engineReadyTick, setEngineReadyTick] = useState(0);
  const treeEvalAwaiterRef = useRef<{ latestScore: string | null; resolve: (score: string | null) => void } | null>(
    null,
  );
  const treeEvalCancelRef = useRef(false);
  const treeEvalFenCacheRef = useRef<Map<string, string>>(new Map());
  const engineWhitePerspectiveMultiplierRef = useRef(1);
  const suddenDeathBusyRef = useRef(false);
  const suddenDeathAwaiterRef = useRef<{
    perspectiveMultiplier: number;
    latestEvalCp: number;
    latestScoreText: string;
    resolve: (result: { scoreText: string; evalCp: number; bestMove: string | null }) => void;
    timeoutId: number | null;
  } | null>(null);
  const treeOptionLongPressTimeoutRef = useRef<number | null>(null);
  const treeOptionLongPressHandledNodeRef = useRef<string | null>(null);
  const inlineMoveLongPressTimeoutRef = useRef<number | null>(null);
  const inlineMoveLongPressHandledNodeRef = useRef<string | null>(null);
  const stockfishButtonLongPressTimeoutRef = useRef<number | null>(null);
  const stockfishButtonLongPressHandledRef = useRef(false);
  const [isStockfishQuickOpen, setIsStockfishQuickOpen] = useState(false);
  const [isTrainingStatsMenuOpen, setIsTrainingStatsMenuOpen] = useState(false);
  const [isSuddenDeathSettingsOpen, setIsSuddenDeathSettingsOpen] = useState(false);
  const [isMoveToolsOpen, setIsMoveToolsOpen] = useState(false);
  const dbButtonLongPressTimeoutRef = useRef<number | null>(null);
  const dbButtonLongPressHandledRef = useRef(false);
  const trainButtonLongPressTimeoutRef = useRef<number | null>(null);
  const trainButtonLongPressHandledRef = useRef(false);
  const suddenDeathButtonLongPressTimeoutRef = useRef<number | null>(null);
  const suddenDeathButtonLongPressHandledRef = useRef(false);
  const movesButtonLongPressTimeoutRef = useRef<number | null>(null);
  const movesButtonLongPressHandledRef = useRef(false);
  const [findMissingSearchBaseNodeId, setFindMissingSearchBaseNodeId] = useState<string | null>(null);
  const [findMissingSearchCursorNodeId, setFindMissingSearchCursorNodeId] = useState<string | null>(null);
  const findMissingSearchAutoNavigationRef = useRef(false);
  const [isFindMissingSearchRunning, setIsFindMissingSearchRunning] = useState(false);
  const lichessNodeLookupCacheRef = useRef<Map<string, LichessResponse | null>>(new Map());
  const lichessRateLimitedUntilRef = useRef(0);
  const lichessNextRequestAtRef = useRef(0);
  const lichessRequestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lichessResponseCacheRef = useRef<Map<string, LichessResponseCacheEntry>>(new Map());
  const lichessResponseCacheLoadedRef = useRef(false);
  const lichessResponseCacheLoadPromiseRef = useRef<Promise<void> | null>(null);
  const trainingStatsMenuRef = useRef<HTMLDivElement | null>(null);
  const movePaneRef = useRef<HTMLElement | null>(null);
  const backLongPressTimeoutRef = useRef<number | null>(null);
  const backLongPressHandledRef = useRef(false);
  const backLongPressIsDownRef = useRef(false);
  const backLongPressStageRef = useRef<0 | 1 | 2>(0);

  const activeSide: Side = repertoireSide;
  const activeRepertoireList = repertoiresBySide[activeSide];
  const activeRepertoireId = activeRepertoireIdBySide[activeSide];
  const activeRepertoire =
    activeRepertoireId ? activeRepertoireList.find((item) => item.id === activeRepertoireId) : null;
  const isBrowseMode = !activeRepertoire;
  const activeRepertoireName = activeRepertoire?.name ?? 'Review mode';
  const boardOrientation: 'white' | 'black' =
    isTempBoardFlipped ? (repertoireSide === 'white' ? 'black' : 'white') : repertoireSide;
  const newRepertoireSide: Side = boardOrientation;
  const loadRepertoireSide: Side = boardOrientation;
  const loadableRepertoiresForBoardSide = repertoiresBySide[loadRepertoireSide];
  const hasSideTrainingContent = useCallback(
    (side: Side) => {
      const sideActiveRepertoireId = activeRepertoireIdBySide[side];
      if (sideActiveRepertoireId) return repertoireHasMoves(trees[side]);
      return repertoiresBySide[side].some((repertoire) => repertoireHasMoves(repertoire.tree));
    },
    [activeRepertoireIdBySide, trees, repertoiresBySide],
  );
  const canStartTrainingForActiveSide = hasSideTrainingContent(activeSide);
  const tree = trees[activeSide];
  const selectedNodeId = selectedNodeBySide[activeSide] ?? tree.rootId;
  const selectedNode = tree.nodes[selectedNodeId] ?? tree.nodes[tree.rootId];
  const trainingForActive = trainingSession?.side === activeSide && !trainingSession.suddenDeathMode;
  const isTreeEvalRunning = Boolean(treeEvalProgress?.running);

  const path = useMemo(() => buildPath(tree, selectedNode.id), [tree, selectedNode.id]);

  const childNodes = useMemo(
    () => selectedNode.children.map((id) => tree.nodes[id]).filter(Boolean),
    [selectedNode.children, tree.nodes],
  );

  const collectBrowseMoveOptionsAtFen = (side: Side, fen: string): BrowseMoveOption[] => {
    const byUci = new Map<string, { moveSan: string; repertoireNames: Set<string> }>();
    const targetFenKey = positionFenKey(fen);

    for (const repertoire of repertoiresBySide[side]) {
      const nodes = Object.values(repertoire.tree.nodes).filter((node) => positionFenKey(node.fen) === targetFenKey);
      if (nodes.length === 0) continue;
      for (const node of nodes) {
        for (const childId of node.children) {
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
  };

  const browseMoveOptions = useMemo<BrowseMoveOption[]>(() => {
    if (!isBrowseMode) return [];
    return collectBrowseMoveOptionsAtFen(activeSide, selectedNode.fen);
  }, [isBrowseMode, selectedNode.fen, repertoiresBySide, activeSide]);

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
    return repertoiresBySide[activeSide]
      .filter((repertoire) => repertoireHasMoves(repertoire.tree))
      .filter((repertoire) =>
        Object.values(repertoire.tree.nodes).some((node) => positionFenKey(node.fen) === targetFenKey),
      )
      .map((repertoire) => ({
        id: repertoire.id,
        name: repertoire.name,
        isActive: repertoire.id === activeRepertoireIdBySide[activeSide],
      }))
      .sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [selectedNode.fen, repertoiresBySide, activeSide, activeRepertoireIdBySide]);

  const autoArrows = useMemo<DrawShape[]>(() => {
    const treeArrows = showTreeArrows
      ? displayedChildNodes
          .map((node) => parseUciMove(node.moveUci))
          .filter((value): value is [Key, Key] => Boolean(value))
          .map(([orig, dest]) => ({ orig, dest, brush: 'green' }))
      : [];

    const treeChildUcis = new Set(
      displayedChildNodes.map((node) => node.moveUci).filter((uci): uci is string => Boolean(uci)),
    );

    const positionGames = (lichessData?.white ?? 0) + (lichessData?.draws ?? 0) + (lichessData?.black ?? 0);
    const thresholdShare = lichessArrowThreshold / 100;
    const lichessArrows =
      showLichessArrows && positionGames > 0
        ? (() => {
            const allEntries = (lichessData?.moves ?? [])
              .map((move) => {
                const moveGames = move.white + move.draws + move.black;
                const share = moveGames / positionGames;
                const keyPair = parseUciMove(move.uci);
                const isHiddenByTreeFilter = !showLichessOnTreeMoves && treeChildUcis.has(move.uci);
                return { share, keyPair, isHiddenByTreeFilter };
              })
              .filter((entry) => Boolean(entry.keyPair));

            const maxShare = Math.max(...allEntries.map((item) => item.share), 0);

            const candidates = allEntries.filter(
              (entry) => !entry.isHiddenByTreeFilter && entry.share >= thresholdShare,
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
    displayedChildNodes,
    showTreeArrows,
    lichessData,
    lichessArrowThreshold,
    engineLines,
    showLichessArrows,
    showStockfishArrows,
    showLichessOnTreeMoves,
  ]);

  const lastMove = parseUciMove(selectedNode.moveUci);

  const applyPersistedSettingsState = useCallback((persistedSettings: PersistedSettingsState) => {
    setThemeMode(persistedSettings.themeMode);
    setRepertoireSide(persistedSettings.repertoireSide);
    setIsTempBoardFlipped(persistedSettings.isTempBoardFlipped);
    setLichessSource(persistedSettings.lichessSource);
    setPlayerHandle(persistedSettings.playerHandle);
    setDateRange(persistedSettings.dateRange);
    setLichessArrowThreshold(persistedSettings.lichessArrowThreshold);
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
    setShowTreeArrows(persistedSettings.showTreeArrows);
    setShowLichessArrows(persistedSettings.showLichessArrows);
    setShowStockfishArrows(persistedSettings.showStockfishArrows);
    setStockfishEvalSeconds(persistedSettings.stockfishEvalSeconds);
    setTrainingStatsQueueLength(persistedSettings.trainingStatsQueueLength);
    setSuddenDeathThreshold(persistedSettings.suddenDeathThreshold);
    setSuddenDeathMinMoves(persistedSettings.suddenDeathMinMoves);
    setSuddenDeathStockfishElo(persistedSettings.suddenDeathStockfishElo);
    setSuddenDeathMaxThinkTimeSec(persistedSettings.suddenDeathMaxThinkTimeSec);
  }, []);

  const applyPersistedDatabaseState = useCallback((persisted: PersistedAppState | null) => {
    if (persisted) {
      setRepertoiresBySide(persisted.repertoiresBySide);
      setActiveRepertoireIdBySide({ white: null, black: null });
      const whiteActive = persisted.repertoiresBySide.white[0];
      const blackActive = persisted.repertoiresBySide.black[0];
      const whiteTree = whiteActive?.tree ?? createEmptyTree('white');
      const blackTree = blackActive?.tree ?? createEmptyTree('black');
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
    setSuddenDeathStartNodeId(null);
    setSuddenDeathCurrentFen(null);
    setSuddenDeathLastMove(null);
    setFindMissingSearchBaseNodeId(null);
    setFindMissingSearchCursorNodeId(null);
  }, []);

  useEffect(() => {
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

        if (persistedSettings) applyPersistedSettingsState(persistedSettings);
        applyPersistedDatabaseState(persisted);
        setTrainingStatsBySide(persistedTrainingStats ?? createEmptyTrainingStatsState());
        setTrainingLeafLastShownBySide(persistedTrainingLeafLastShown ?? createEmptyTrainingLeafLastShownState());
        setStatus('Ready');
      } catch {
        setStatus('Local storage load failed');
      } finally {
        setHasHydratedAppState(true);
      }
    };

    void hydrateAppState();
  }, []);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    setRepertoiresBySide((prev) => {
      let changed = false;
      const next = { ...prev };
      (['white', 'black'] as Side[]).forEach((side) => {
        const activeId = activeRepertoireIdBySide[side];
        if (!activeId) return;
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
  }, [hasHydratedAppState, trees, selectedNodeBySide, activeRepertoireIdBySide]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const payload: PersistedAppState = {
      version: 2,
      repertoiresBySide,
      activeRepertoireIdBySide,
    };

    const timeout = window.setTimeout(() => {
      void idbSet(APP_STATE_KEY, payload).catch(() => {
        setStatus('Local save failed');
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [hasHydratedAppState, repertoiresBySide, activeRepertoireIdBySide]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    const settingsPayload: PersistedSettingsState = {
      version: 1,
      themeMode,
      repertoireSide,
      isTempBoardFlipped,
      lichessSource,
      playerHandle,
      dateRange,
      lichessArrowThreshold,
      engineDepth,
      engineMultiPv,
      selectedSpeeds,
      selectedRatings,
      selectedModes,
      showLichessOnTreeMoves,
      showTreeArrows,
      showLichessArrows,
      showStockfishArrows,
      stockfishEvalSeconds,
      trainingStatsQueueLength,
      suddenDeathThreshold,
      suddenDeathMinMoves,
      suddenDeathStockfishElo,
      suddenDeathMaxThinkTimeSec,
      nextMissingMoveThreshold: lichessArrowThreshold,
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
    repertoireSide,
    isTempBoardFlipped,
    lichessSource,
    playerHandle,
    dateRange,
    lichessArrowThreshold,
    engineDepth,
    engineMultiPv,
    selectedSpeeds,
    selectedRatings,
    selectedModes,
    showLichessOnTreeMoves,
    showTreeArrows,
    showLichessArrows,
    showStockfishArrows,
    stockfishEvalSeconds,
    trainingStatsQueueLength,
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
      engineWhitePerspectiveMultiplierRef.current = whitePerspectiveMultiplierFromFen(pending.fen);
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
        if (suddenDeathAwaiterRef.current && text.includes(' multipv 1')) {
          const cpMatch = text.match(/ score cp (-?\d+)/);
          const mateMatch = text.match(/ score mate (-?\d+)/);
          if (cpMatch) {
            suddenDeathAwaiterRef.current.latestEvalCp =
              Number(cpMatch[1]) * suddenDeathAwaiterRef.current.perspectiveMultiplier;
            suddenDeathAwaiterRef.current.latestScoreText =
              formatSignedCp(suddenDeathAwaiterRef.current.latestEvalCp);
          } else if (mateMatch) {
            const matePly = Number(mateMatch[1]) * suddenDeathAwaiterRef.current.perspectiveMultiplier;
            suddenDeathAwaiterRef.current.latestEvalCp = matePly > 0 ? 100000 : -100000;
            suddenDeathAwaiterRef.current.latestScoreText = formatSignedMate(matePly);
          }
        }

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
        setEngineLines(Array.from(lineCacheRef.current.values()).sort((a, b) => a.multipv - b.multipv));
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
          awaiter.resolve({
            scoreText: awaiter.latestScoreText,
            evalCp: awaiter.latestEvalCp,
            bestMove,
          });
          return;
        }
        isSearchingRef.current = false;
        if (treeEvalAwaiterRef.current) {
          const { latestScore, resolve } = treeEvalAwaiterRef.current;
          treeEvalAwaiterRef.current = null;
          resolve(latestScore ?? null);
        }
        setEngineStatus('done');
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

  const waitForLichessRateSlot = useCallback(async () => {
    let release!: () => void;
    const previous = lichessRequestQueueRef.current;
    lichessRequestQueueRef.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const now = Date.now();
      if (now < lichessRateLimitedUntilRef.current) return false;
      const wait = Math.max(0, lichessNextRequestAtRef.current - now);
      if (wait > 0) await waitMs(wait);
      lichessNextRequestAtRef.current = Date.now() + LICHESS_API_MIN_INTERVAL_MS;
      return true;
    } finally {
      release();
    }
  }, []);

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
            if (entry.expiresAt <= now) continue;
            const data = (entry as LichessResponseCacheEntry).data;
            if (!data || typeof data !== 'object' || !Array.isArray(data.moves)) continue;
            nextMap.set(url, { expiresAt: entry.expiresAt, data });
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
      if (entry.expiresAt <= now) continue;
      serialized[url] = entry;
    }
    await idbSet(APP_LICHESS_RESPONSE_CACHE_KEY, serialized).catch(() => {
      // Keep cache write failures silent.
    });
  }, []);

  const getCachedLichessResponse = useCallback(
    async (url: string): Promise<LichessResponse | null> => {
      await ensureLichessResponseCacheLoaded();
      const now = Date.now();
      const cached = lichessResponseCacheRef.current.get(url);
      if (!cached) return null;
      if (cached.expiresAt <= now) {
        lichessResponseCacheRef.current.delete(url);
        void persistLichessResponseCache();
        return null;
      }
      return cached.data;
    },
    [ensureLichessResponseCacheLoaded, persistLichessResponseCache],
  );

  const setCachedLichessResponse = useCallback(
    async (url: string, data: LichessResponse, source: LichessSource) => {
      await ensureLichessResponseCacheLoaded();
      const ttlMs =
        source === 'player'
          ? LICHESS_CACHE_PLAYER_TTL_MS
          : LICHESS_CACHE_DEFAULT_TTL_MS + Math.floor(Math.random() * (LICHESS_CACHE_DEFAULT_JITTER_MS + 1));
      lichessResponseCacheRef.current.set(url, {
        expiresAt: Date.now() + ttlMs,
        data,
      });
      void persistLichessResponseCache();
    },
    [ensureLichessResponseCacheLoaded, persistLichessResponseCache],
  );

  const checkLichessApiAvailability = useCallback(async () => {
    const fen = START_POS_FEN;
    const params = new URLSearchParams({
      fen,
      variant: FIXED_VARIANT,
      color: 'white',
    });
    const url = `https://explorer.lichess.ovh/lichess?${params.toString()}`;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status === 429) {
        registerLichessRateLimit(response.headers.get('Retry-After'));
        return;
      }
      if (!response.ok) {
        setLichessApiIssueNote(`Lichess API health check failed: HTTP ${response.status}`);
        return;
      }
      setLichessApiIssueNote('');
    } catch {
      setLichessApiIssueNote((prev) => prev || 'Lichess API health check failed.');
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, [registerLichessRateLimit]);

  useEffect(() => {
    if (!hasHydratedAppState) return;
    void checkLichessApiAvailability();
    const intervalId = window.setInterval(() => {
      void checkLichessApiAvailability();
    }, LICHESS_API_HEALTHCHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasHydratedAppState, checkLichessApiAvailability]);

  useEffect(() => {
    const controller = new AbortController();
    const isPlayerWithoutHandle = lichessSource === 'player' && playerHandle.trim().length === 0;
    const isTrainingLocalPlay = Boolean(trainingSession?.side === activeSide);
    const isRateLimited = Date.now() < lichessRateLimitedUntilRef.current;

    if (isPlayerWithoutHandle) {
      setLichessData(null);
      setLichessDataFen(null);
      setLichessStatus('idle');
      return () => {
        controller.abort();
      };
    }

    if (isTrainingLocalPlay) {
      setLichessStatus('idle');
      return () => {
        controller.abort();
      };
    }

    setLichessStatus('loading');

    const run = async () => {
      const fenKey = selectedNode.fen;
      const fen = fenKey === START_FEN ? new Chess().fen() : fenKey;
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
            ? dateRange === '1m' ||
              dateRange === '2m' ||
              dateRange === '3m' ||
              dateRange === '6m' ||
              dateRange === '20y' ||
              dateRange === '30y' ||
              dateRange === '50y'
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

      const cachedResponse = await getCachedLichessResponse(url);
      if (cachedResponse) {
        setLichessData(cachedResponse);
        setLichessDataFen(fenKey);
        setLichessStatus(isRateLimited ? 'limited' : 'done');
        return;
      }

      setLichessData(null);
      setLichessDataFen(null);

      if (isRateLimited) {
        setLichessStatus('limited');
        return;
      }

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
        const allowed = await waitForLichessRateSlot();
        if (!allowed || controller.signal.aborted) return;
        const res = await fetch(url, {
          signal: controller.signal,
        });
        if (res.status === 429) {
          registerLichessRateLimit(res.headers.get('Retry-After'));
          return;
        }
        if (!res.ok) {
          setLichessApiIssueNote(`Lichess API error (${res.status})`);
          throw new Error('Lichess request failed');
        }
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
              setLichessDataFen(fenKey);
            }
          }

          buffer += decoder.decode();
          if (!latestData) {
            const data = parseLastJsonObject<LichessResponse>(buffer);
            if (data) {
              latestData = data;
              setLichessData(data);
              setLichessDataFen(fenKey);
            }
          }
        } else {
          const rawBody = await res.text();
          const data = parseLastJsonObject<LichessResponse>(rawBody);
          if (data) {
            latestData = data;
            setLichessData(data);
            setLichessDataFen(fenKey);
          }
        }

        if (!latestData) throw new Error('Invalid Lichess payload');
        void setCachedLichessResponse(url, latestData, lichessSource);
        setLichessApiIssueNote('');
        setLichessStatus('done');
      } catch {
        if (controller.signal.aborted && abortedByIdle && latestData) {
          setLichessStatus('done');
        } else if (!controller.signal.aborted) {
          setLichessApiIssueNote((prev) => prev || 'Lichess API error (?)');
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
    trainingSession?.side,
    lichessRateLimitedUntil,
    registerLichessRateLimit,
    waitForLichessRateSlot,
    getCachedLichessResponse,
    setCachedLichessResponse,
  ]);

  useEffect(() => {
    if (findMissingSearchAutoNavigationRef.current) {
      findMissingSearchAutoNavigationRef.current = false;
      return;
    }
    setFindMissingSearchBaseNodeId(selectedNode.id);
    setFindMissingSearchCursorNodeId(null);
  }, [selectedNode.id, activeSide]);

  useEffect(() => {
    if (!isTrainingStatsMenuOpen) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      const menu = trainingStatsMenuRef.current;
      if (!target || !menu) return;
      if (menu.contains(target)) return;
      setIsTrainingStatsMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isTrainingStatsMenuOpen]);

  const fetchLichessNodeData = useCallback(
    async (fenKey: string): Promise<LichessResponse | null> => {
      const normalizedFenKey = positionFenKey(fenKey);
      const cacheKey = JSON.stringify({
        fen: normalizedFenKey,
        side: activeSide,
        source: lichessSource,
        player: playerHandle.trim(),
        dateRange,
        speeds: [...selectedSpeeds].sort().join(','),
        ratings: [...selectedRatings].sort((a, b) => a - b).join(','),
        modes: [...selectedModes].sort().join(','),
      });
      const cached = lichessNodeLookupCacheRef.current.get(cacheKey);
      if (cached !== undefined) return cached;

      const fen = fenKey === START_FEN ? new Chess().fen() : fenKey;
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
            ? dateRange === '1m' ||
              dateRange === '2m' ||
              dateRange === '3m' ||
              dateRange === '6m' ||
              dateRange === '20y' ||
              dateRange === '30y' ||
              dateRange === '50y'
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

      if (normalizedDateRange) {
        const now = new Date();
        const sinceDate = new Date(now);
        if (normalizedDateRange === '1m') {
          sinceDate.setMonth(now.getMonth());
        } else if (normalizedDateRange === '2m') {
          sinceDate.setMonth(now.getMonth() - 1);
        } else if (normalizedDateRange === '3m') {
          sinceDate.setMonth(now.getMonth() - 2);
        } else if (normalizedDateRange === '6m') {
          sinceDate.setMonth(now.getMonth() - 5);
        } else if (normalizedDateRange === '1y') {
          sinceDate.setFullYear(now.getFullYear() - 1);
        } else if (normalizedDateRange === '5y') {
          sinceDate.setFullYear(now.getFullYear() - 5);
        } else if (normalizedDateRange === '10y') {
          sinceDate.setFullYear(now.getFullYear() - 10);
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

      const cachedResponse = await getCachedLichessResponse(url);
      if (cachedResponse) {
        lichessNodeLookupCacheRef.current.set(cacheKey, cachedResponse);
        return cachedResponse;
      }

      if (Date.now() < lichessRateLimitedUntilRef.current) {
        return null;
      }

      if (lichessSource === 'player' && playerHandle.trim().length === 0) {
        return null;
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      try {
        const allowed = await waitForLichessRateSlot();
        if (!allowed || controller.signal.aborted) {
          return null;
        }
        const response = await fetch(url, { signal: controller.signal });
        if (response.status === 429) {
          registerLichessRateLimit(response.headers.get('Retry-After'));
          return null;
        }
        if (!response.ok) {
          setLichessApiIssueNote(`Lichess API error (${response.status})`);
          throw new Error('Lichess request failed');
        }
        const rawBody = await response.text();
        const data = parseLastJsonObject<LichessResponse>(rawBody);
        lichessNodeLookupCacheRef.current.set(cacheKey, data ?? null);
        if (data) void setCachedLichessResponse(url, data, lichessSource);
        if (data) setLichessApiIssueNote('');
        return data ?? null;
      } catch {
        setLichessApiIssueNote((prev) => prev || 'Lichess API error (?)');
        return null;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [
      activeSide,
      lichessSource,
      playerHandle,
      dateRange,
      selectedSpeeds,
      selectedRatings,
      selectedModes,
      registerLichessRateLimit,
      waitForLichessRateSlot,
      getCachedLichessResponse,
      setCachedLichessResponse,
    ],
  );

  const clearTrainingHint = () => {
    setTrainingSession((prev) =>
      prev ? { ...prev, hintRequested: false, hintVisible: false, hintMoveUci: null } : prev,
    );
  };

  const getScopeIdsForTrainingPosition = (side: Side, fen: string) => {
    const fenKey = positionFenKey(fen);
    const repertoireScopeIds = repertoiresBySide[side]
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

  const runStockfishSingleQuery = async (params: {
    fen: string;
    depth: number;
    perspectiveSide: Side;
    multipv?: number;
    movetimeMs?: number;
    limitStrengthElo?: number | null;
  }): Promise<{ scoreText: string; evalCp: number; bestMove: string | null }> => {
    const { fen, depth, perspectiveSide, multipv = 1, movetimeMs, limitStrengthElo = null } = params;
    while (suddenDeathBusyRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    suddenDeathBusyRef.current = true;

    try {
      const worker = stockfishRef.current;
      if (!worker || !engineReadyRef.current) {
        return { scoreText: '+0.00', evalCp: 0, bestMove: null };
      }

      pendingAnalysisRef.current = null;
      worker.postMessage('stop');
      isSearchingRef.current = false;
      lineCacheRef.current = new Map();
      setEngineLines([]);

      const whitePerspectiveMultiplier = whitePerspectiveMultiplierFromFen(fen);
      const sidePerspectiveMultiplier = perspectiveSide === 'white' ? 1 : -1;
      const perspectiveMultiplier = whitePerspectiveMultiplier * sidePerspectiveMultiplier;
      engineWhitePerspectiveMultiplierRef.current = perspectiveMultiplier;

      const result = await new Promise<{ scoreText: string; evalCp: number; bestMove: string | null }>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          const awaiter = suddenDeathAwaiterRef.current;
          if (!awaiter) {
            resolve({ scoreText: '+0.00', evalCp: 0, bestMove: null });
            return;
          }
          suddenDeathAwaiterRef.current = null;
          resolve({
            scoreText: awaiter.latestScoreText,
            evalCp: awaiter.latestEvalCp,
            bestMove: null,
          });
        }, 12000);

        suddenDeathAwaiterRef.current = {
          perspectiveMultiplier,
          latestEvalCp: 0,
          latestScoreText: '+0.00',
          timeoutId,
          resolve,
        };

        worker.postMessage(`setoption name MultiPV value ${Math.max(1, multipv)}`);
        if (limitStrengthElo !== null) {
          worker.postMessage('setoption name UCI_LimitStrength value true');
          worker.postMessage(`setoption name UCI_Elo value ${limitStrengthElo}`);
        } else {
          worker.postMessage('setoption name UCI_LimitStrength value false');
        }
        worker.postMessage(`position fen ${fen}`);
        if (typeof movetimeMs === 'number' && Number.isFinite(movetimeMs) && movetimeMs > 0) {
          worker.postMessage(`go movetime ${Math.floor(movetimeMs)}`);
        } else {
          worker.postMessage(`go depth ${Math.max(8, depth)}`);
        }
      });

      return result;
    } finally {
      suddenDeathBusyRef.current = false;
    }
  };

  const getScopeSuccessRate = (side: Side, scopeId: string, fen: string) => {
    const recentAnswers = trainingStatsBySide[side]?.[scopeId]?.[positionFenKey(fen)]?.recentAnswers ?? [];
    if (recentAnswers.length === 0) return 0;
    const correct = recentAnswers.reduce((acc, value) => acc + (value ? 1 : 0), 0);
    return (correct / recentAnswers.length) * 100;
  };

  const collectBrowseChildFenKeys = (side: Side, fen: string) => {
    const targetFenKey = positionFenKey(fen);
    const childFenKeys = new Set<string>();
    for (const repertoire of repertoiresBySide[side]) {
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
        if (toTurnColor(node.fen) === side && node.children.length > 0) {
          candidateNodes.push(node);
        }
        for (const childId of node.children) stack.push(childId);
      }
      if (candidateNodes.length === 0) return;
      const preferred = candidateNodes.filter((node) => node.parentId !== selectedNode.id);
      const pool = preferred.length > 0 ? preferred : candidateNodes;
      const weights = pool.map((node) => {
        const successRate = getScopeSuccessRate(side, scopeId, node.fen);
        return Math.max(1, 101 - successRate);
      });
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
    for (const repertoire of repertoiresBySide[side]) {
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
          if (toTurnColor(node.fen) === side && node.children.length > 0) {
            const fenKey = positionFenKey(node.fen);
            if (!candidateByFen.has(fenKey)) candidateByFen.set(fenKey, node.fen);
          }
          for (const childId of node.children) stack.push(childId);
        }
      }
    }
    if (candidateByFen.size === 0) return;
    const childFenKeys = collectBrowseChildFenKeys(side, selectedNode.fen);
    const candidateFens = [...candidateByFen.values()];
    const preferred = candidateFens.filter((fen) => !childFenKeys.has(positionFenKey(fen)));
    const pool = preferred.length > 0 ? preferred : candidateFens;
    const weights = pool.map((fen) => {
      const successRate = getScopeSuccessRate(side, scopeId, fen);
      return Math.max(1, 101 - successRate);
    });
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
    const fixedStartFen = fixedStartNode.fen === START_FEN ? new Chess().fen() : fixedStartNode.fen;
    setSuddenDeathStartNodeId(fixedStartNodeId);
    setSuddenDeathCurrentFen(fixedStartFen);
    setSuddenDeathLastMove(null);
    setSelectedNodeBySide((prev) => ({ ...prev, [side]: fixedStartNodeId }));

    setSuddenDeathThinking(true);
    try {
      const openingReply = await runStockfishSingleQuery({
        fen: fixedStartFen,
        depth: Math.max(10, Math.min(18, engineDepth)),
        perspectiveSide: 'white',
        multipv: 1,
        movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
        limitStrengthElo: suddenDeathStockfishElo,
      });

      let promptFen = fixedStartFen;
      let promptLastMove: [Key, Key] | null = null;
      if (openingReply.bestMove) {
        const promptChess = fenToChess(fixedStartFen);
        const promotionChar = (openingReply.bestMove[4] ?? 'q').toLowerCase();
        const promotion: 'q' | 'r' | 'b' | 'n' = ['q', 'r', 'b', 'n'].includes(promotionChar)
          ? (promotionChar as 'q' | 'r' | 'b' | 'n')
          : 'q';
        const openingMove = promptChess.move({
          from: openingReply.bestMove.slice(0, 2),
          to: openingReply.bestMove.slice(2, 4),
          promotion,
        });
        if (openingMove) {
          promptFen = promptChess.fen();
          promptLastMove = parseUciMove(openingReply.bestMove) ?? null;
        }
      }
      setSuddenDeathCurrentFen(promptFen);
      setSuddenDeathLastMove(promptLastMove);

      const baseEval = await runStockfishSingleQuery({
        fen: promptFen,
        depth: engineDepth,
        perspectiveSide: 'white',
        multipv: 1,
        movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
      });
      const userPerspectiveMultiplier = side === 'white' ? 1 : -1;
      setTrainingSession((prev) =>
        prev && prev.side === side && prev.suddenDeathMode
          ? {
              ...prev,
              currentPromptFen: promptFen,
              suddenDeathPromptFen: promptFen,
              suddenDeathBaseEvalCp: baseEval.evalCp * userPerspectiveMultiplier,
              currentPromptHadError: false,
              currentPromptScopeIds: getScopeIdsForTrainingPosition(side, promptFen),
              hintRequested: false,
              hintVisible: false,
              hintMoveUci: null,
            }
          : prev,
      );
    } finally {
      setSuddenDeathThinking(false);
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
        const options = collectBrowseMoveOptionsAtFen(side, cursor.fen);
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
    const promptOptions = isBrowseMode
      ? collectBrowseMoveOptionsAtFen(side, promptNode.fen).map((option) => option.moveUci)
      : promptNode.children
          .map((childId) => sideTree.nodes[childId]?.moveUci)
          .filter((value): value is string => Boolean(value));
    if (promptTurnMatches && promptOptions.length > 0) {
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
    setSuddenDeathThinking(false);
    setSuddenDeathStartNodeId(null);
    setSuddenDeathCurrentFen(null);
    setSuddenDeathLastMove(null);
  };

  const closeSuddenDeathGameOverPopup = () => {
    if (!suddenDeathGameOver) return;
    const { side, startNodeId } = suddenDeathGameOver;
    restoreSuddenDeathStartPosition(side, startNodeId);
    setSuddenDeathGameOver(null);
    clearSuddenDeathRuntime();
    if (trainingSession && trainingSession.side === side && trainingSession.suddenDeathMode) {
      const nextSession: TrainingSession = {
        ...trainingSession,
        rootNodeId: startNodeId,
        entryNodeId: startNodeId,
        suddenDeathBaseEvalCp: null,
        suddenDeathPromptFen: null,
        currentPromptFen: null,
        currentPromptHadError: false,
        currentPromptScopeIds: [],
        hintRequested: false,
        hintVisible: false,
        hintMoveUci: null,
      };
      setTrainingSession(nextSession);
      void startSuddenDeathRound(nextSession);
    }
  };

  const startTraining = () => {
    const side = activeSide;
    if (!hasSideTrainingContent(side)) {
      setStatus('No lines to train on this side.');
      return;
    }
    const rootNodeId = selectedNode.id;
    clearSuddenDeathRuntime();
    setSuddenDeathGameOver(null);
    setTrainingSession({
      side,
      rootNodeId,
      entryNodeId: rootNodeId,
      flashcardMode: false,
      suddenDeathMode: false,
      suddenDeathBaseEvalCp: null,
      suddenDeathPromptFen: null,
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
    if (!hasSideTrainingContent(side)) {
      setStatus('No lines to train on this side.');
      return;
    }
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
      suddenDeathPromptFen: null,
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
            suddenDeathPromptFen: null,
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
      suddenDeathPromptFen: null,
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
            suddenDeathPromptFen: null,
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
    if (!hasSideTrainingContent(trainingSession.side)) {
      if (trainingSession.suddenDeathMode) clearSuddenDeathRuntime();
      setTrainingSession(null);
      setSuddenDeathGameOver(null);
      return;
    }
    if (!trees[trainingSession.side].nodes[trainingSession.rootNodeId]) {
      if (trainingSession.suddenDeathMode) clearSuddenDeathRuntime();
      setTrainingSession(null);
    }
  }, [repertoireSide, trainingSession, trees, hasSideTrainingContent]);

  const makeMove = (orig: Key, dest: Key, promotion: 'q' | 'r' | 'b' | 'n' = 'q') => {
    const currentTree = trees[activeSide];
    const currentSelectedId = selectedNodeBySide[activeSide] ?? currentTree.rootId;
    const currentNode = currentTree.nodes[currentSelectedId] ?? currentTree.nodes[currentTree.rootId];
    const moveSourceFen =
      trainingSession &&
      trainingSession.side === activeSide &&
      trainingSession.suddenDeathMode &&
      suddenDeathCurrentFen
        ? suddenDeathCurrentFen
        : currentNode.fen;
    const chess = fenToChess(moveSourceFen);
    const move = chess.move({ from: orig, to: dest, promotion });

    if (!move) return;

    const uci = uciFromMove(move);
    const existingChildId = currentNode.children.find((id) => currentTree.nodes[id].moveUci === uci);

    if (trainingSession && trainingSession.side === activeSide) {
      if (trainingSession.suddenDeathMode) {
        if (suddenDeathThinking || !suddenDeathCurrentFen) return;
        const userFen = chess.fen();
        setSuddenDeathCurrentFen(userFen);
        setSuddenDeathLastMove(parseUciMove(uci) ?? null);

        const promptFen = trainingSession.suddenDeathPromptFen ?? trainingSession.currentPromptFen ?? suddenDeathCurrentFen;
        const baseEvalCp = trainingSession.suddenDeathBaseEvalCp ?? 0;
        const promptScopeIds =
          trainingSession.currentPromptScopeIds.length > 0
            ? trainingSession.currentPromptScopeIds
            : getScopeIdsForTrainingPosition(activeSide, promptFen);

        void (async () => {
          setSuddenDeathThinking(true);
          try {
            const postUserEval = await runStockfishSingleQuery({
              fen: userFen,
              depth: engineDepth,
              perspectiveSide: 'white',
              multipv: 1,
              movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
            });
            const thresholdCp = Math.round(suddenDeathThreshold * 100);
            const userPerspectiveMultiplier = activeSide === 'white' ? 1 : -1;
            const postUserEvalCp = postUserEval.evalCp * userPerspectiveMultiplier;
            const failedAfterUserMove = postUserEvalCp <= baseEvalCp - thresholdCp;
            if (failedAfterUserMove) {
              setSuddenDeathGameOver({
                side: activeSide,
                startNodeId: suddenDeathStartNodeId ?? trainingSession.entryNodeId,
                baselineEvalCp: baseEvalCp,
                failedEvalCp: postUserEvalCp,
                thresholdCp,
              });
              appendTrainingAnswer(activeSide, promptFen, promptScopeIds, 0);
              return;
            }

            const engineReply = await runStockfishSingleQuery({
              fen: userFen,
              depth: Math.max(10, Math.min(18, engineDepth)),
              perspectiveSide: 'white',
              multipv: 1,
              movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
              limitStrengthElo: suddenDeathStockfishElo,
            });

            let evalFen = userFen;
            let evalLastMove: [Key, Key] | null = parseUciMove(uci) ?? null;
            if (engineReply.bestMove) {
              const engineChess = fenToChess(userFen);
              const promotionChar = (engineReply.bestMove[4] ?? 'q').toLowerCase();
              const promotion: 'q' | 'r' | 'b' | 'n' = ['q', 'r', 'b', 'n'].includes(promotionChar)
                ? (promotionChar as 'q' | 'r' | 'b' | 'n')
                : 'q';
              const engineMove = engineChess.move({
                from: engineReply.bestMove.slice(0, 2),
                to: engineReply.bestMove.slice(2, 4),
                promotion,
              });
              if (engineMove) {
                evalFen = engineChess.fen();
                evalLastMove = parseUciMove(engineReply.bestMove) ?? null;
              }
            }
            setSuddenDeathCurrentFen(evalFen);
            setSuddenDeathLastMove(evalLastMove);

            const evalResult = await runStockfishSingleQuery({
              fen: evalFen,
              depth: engineDepth,
              perspectiveSide: 'white',
              multipv: 1,
              movetimeMs: Math.max(100, Math.round(suddenDeathMaxThinkTimeSec * 1000)),
            });

            const evalResultUserCp = evalResult.evalCp * userPerspectiveMultiplier;
            const failed = evalResultUserCp <= baseEvalCp - thresholdCp;

            if (failed) {
              setSuddenDeathGameOver({
                side: activeSide,
                startNodeId: suddenDeathStartNodeId ?? trainingSession.entryNodeId,
                baselineEvalCp: baseEvalCp,
                failedEvalCp: evalResultUserCp,
                thresholdCp,
              });
              appendTrainingAnswer(activeSide, promptFen, promptScopeIds, 0);
            } else {
              appendTrainingAnswer(activeSide, promptFen, promptScopeIds, 1);
              setTrainingSession((prev) =>
                prev && prev.side === activeSide
                  ? {
                      ...prev,
                      correctCount: prev.correctCount + 1,
                      currentPromptFen: evalFen,
                      suddenDeathPromptFen: evalFen,
                      currentPromptScopeIds: getScopeIdsForTrainingPosition(activeSide, evalFen),
                      currentPromptHadError: false,
                    }
                  : prev,
              );
            }
          } finally {
            setSuddenDeathThinking(false);
          }
        })();
        return;
      }

      if (toTurnColor(currentNode.fen) !== activeSide) return;
      const trainingOptions = isBrowseMode
        ? collectBrowseMoveOptionsAtFen(activeSide, currentNode.fen).map((option) => option.moveUci)
        : currentNode.children
            .map((childId) => currentTree.nodes[childId]?.moveUci)
            .filter((value): value is string => Boolean(value));
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

  const jumpToNextMissingLichessMove = async () => {
    if (isTrainingActive || isSuddenDeathActive || isFindMissingSearchRunning) return;

    const sideTree = tree;
    const baseNodeId =
      findMissingSearchBaseNodeId && sideTree.nodes[findMissingSearchBaseNodeId]
        ? findMissingSearchBaseNodeId
        : selectedNode.id;
    const baseNode = sideTree.nodes[baseNodeId];
    if (!baseNode || baseNode.children.length === 0) return;

    const traversal: string[] = [];
    const stack = [baseNodeId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const nodeId = stack.pop() as string;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      traversal.push(nodeId);
      const node = sideTree.nodes[nodeId];
      if (!node) continue;
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i]);
      }
    }

    let startIndex = 0;
    if (findMissingSearchCursorNodeId) {
      const cursorIdx = traversal.indexOf(findMissingSearchCursorNodeId);
      if (cursorIdx >= 0) startIndex = cursorIdx + 1;
    }
    if (startIndex >= traversal.length) return;

    setIsFindMissingSearchRunning(true);
    try {
      let foundNodeId: string | null = null;
      const thresholdShare = lichessArrowThreshold / 100;
      for (let index = startIndex; index < traversal.length; index += 1) {
        const nodeId = traversal[index];
        const node = sideTree.nodes[nodeId];
        if (!node) continue;
        if (toTurnColor(node.fen) === activeSide) continue;

        const data = await fetchLichessNodeData(node.fen);
        if (!data?.moves || data.moves.length === 0) continue;
        const total = (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0);
        if (total <= 0) continue;

        const existingMoves = new Set(
          node.children
            .map((childId) => sideTree.nodes[childId]?.moveUci)
            .filter((uci): uci is string => Boolean(uci)),
        );
        const hasMissingCandidate = data.moves.some((move) => {
          const moveTotal = move.white + move.draws + move.black;
          return moveTotal / total >= thresholdShare && !existingMoves.has(move.uci);
        });
        if (hasMissingCandidate) {
          foundNodeId = node.id;
          break;
        }
      }

      setFindMissingSearchBaseNodeId(baseNodeId);
      if (foundNodeId) {
        setFindMissingSearchCursorNodeId(foundNodeId);
        findMissingSearchAutoNavigationRef.current = true;
        navigateToNode(activeSide, foundNodeId);
      } else {
        setFindMissingSearchCursorNodeId(traversal[traversal.length - 1] ?? baseNodeId);
      }
    } finally {
      setIsFindMissingSearchRunning(false);
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
      repertoireSide,
      isTempBoardFlipped,
      lichessSource,
      playerHandle,
      dateRange,
      lichessArrowThreshold,
      engineDepth,
      engineMultiPv,
      selectedSpeeds,
      selectedRatings,
      selectedModes,
      showLichessOnTreeMoves,
      showTreeArrows,
      showLichessArrows,
      showStockfishArrows,
      stockfishEvalSeconds,
      trainingStatsQueueLength,
      suddenDeathThreshold,
      suddenDeathMinMoves,
      suddenDeathStockfishElo,
      suddenDeathMaxThinkTimeSec,
      nextMissingMoveThreshold: lichessArrowThreshold,
    };
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      appState: {
        version: 2,
        repertoiresBySide,
        activeRepertoireIdBySide,
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

  const enterBrowseMode = (side: Side = activeSide) => {
    setActiveRepertoireIdBySide((prev) => ({
      ...prev,
      [side]: null,
    }));
    setIsOptionsOpen(false);
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

  const loadRepertoire = (repertoireId: string, side: Side = activeSide, preservePosition = false) => {
    const entry = repertoiresBySide[side].find((item) => item.id === repertoireId);
    if (!entry) return;
    const currentSideTree = trees[side];
    const currentSelectedId = selectedNodeBySide[side] ?? currentSideTree.rootId;
    const currentSelectedNode = currentSideTree.nodes[currentSelectedId] ?? currentSideTree.nodes[currentSideTree.rootId];
    const currentFenKey = positionFenKey(currentSelectedNode.fen);
    const preservedNodeId =
      preservePosition
        ? Object.values(entry.tree.nodes).find((node) => positionFenKey(node.fen) === currentFenKey)?.id ?? null
        : null;
    const nextSelectedId = preservedNodeId ?? (entry.tree.nodes[entry.selectedNodeId] ? entry.selectedNodeId : entry.tree.rootId);
    setActiveRepertoireIdBySide((prev) => ({
      ...prev,
      [side]: entry.id,
    }));
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

    const remaining = repertoiresBySide[side].filter((item) => item.id !== repertoireId);

    setRepertoiresBySide((prev) => ({
      ...prev,
      [side]: prev[side].filter((item) => item.id !== repertoireId),
    }));

    if (remaining.length === 0) {
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
      if (renamingRepertoireId === repertoireId) {
        cancelRenamingRepertoire();
      }
      setStatus(`Deleted repertoire "${entry.name}"`);
      return;
    }

    if (activeRepertoireIdBySide[side] === repertoireId) {
      const fallback = remaining[0];
      setActiveRepertoireIdBySide((prev) => ({
        ...prev,
        [side]: null,
      }));
      setTrees((prev) => ({
        ...prev,
        [side]: fallback.tree,
      }));
      setSelectedNodeBySide((prev) => ({
        ...prev,
        [side]: fallback.selectedNodeId,
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
      await importPgnFile(file, importMode);
    } catch {
      // Keep import flow silent on UI status.
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

  const lichessTotal = (lichessData?.white ?? 0) + (lichessData?.draws ?? 0) + (lichessData?.black ?? 0);
  const isSuddenDeathActive = Boolean(
    trainingSession && trainingSession.side === activeSide && trainingSession.suddenDeathMode,
  );
  const isTrainingActive = Boolean(
    trainingSession && trainingSession.side === activeSide && !trainingSession.suddenDeathMode,
  );
  const hasSuddenDeathBoardOverride = Boolean(
    suddenDeathCurrentFen &&
      ((trainingSession && trainingSession.side === activeSide && trainingSession.suddenDeathMode) ||
        (suddenDeathGameOver && suddenDeathGameOver.side === activeSide)),
  );
  const boardFen = hasSuddenDeathBoardOverride ? (suddenDeathCurrentFen as string) : selectedNode.fen;
  const boardLastMove = hasSuddenDeathBoardOverride ? suddenDeathLastMove ?? undefined : lastMove;
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
  const isTrainingLineEnd = Boolean(isTrainingActive && displayedChildNodes.length === 0);
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
  const canGoBack = Boolean(selectedNode.parentId);
  const visibleEngineStatus =
    engineStatus === 'done' || engineStatus === 'stopped' || engineStatus === 'analyzing' ? '' : engineStatus;
  const currentEngineEvalRaw = engineLines[0]?.scoreText ?? selectedNode.stockfishEval ?? null;
  const currentEngineEval = currentEngineEvalRaw ? normalizeEvalSignText(currentEngineEvalRaw) : null;
  const visibleEngineEval = currentEngineEval ? `(${currentEngineEval})` : '';
  const visibleLichessStatus = (() => {
    if (lichessStatus === 'limited') return '';
    if (lichessStatus === 'done' || lichessStatus === 'idle') return '';
    return lichessStatus;
  })();
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
    if (!lichessData?.moves || lichessTotal <= 0) return [];
    const thresholdShare = lichessArrowThreshold / 100;
    return lichessData.moves.filter((move) => {
      const total = move.white + move.draws + move.black;
      return total / lichessTotal >= thresholdShare;
    });
  }, [lichessData, lichessTotal, lichessArrowThreshold]);
  const activeFindMissingBaseNode =
    (findMissingSearchBaseNodeId ? tree.nodes[findMissingSearchBaseNodeId] : null) ?? selectedNode;
  const canRunFindMissingSearch =
    activeFindMissingBaseNode.children.length > 0 && !isFindMissingSearchRunning && !isSuddenDeathActive;
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

    return childNodes
      .map((node) => ({
        node,
        leaves: countLeaves(node.id),
      }))
      .map(({ node, leaves }) => ({ node, leaves }));
  }, [isBrowseMode, browseMoveOptions, selectedNode.id, selectedNode.fen, childNodes, tree.nodes]);

  const clearTreeOptionLongPress = () => {
    if (treeOptionLongPressTimeoutRef.current !== null) {
      window.clearTimeout(treeOptionLongPressTimeoutRef.current);
      treeOptionLongPressTimeoutRef.current = null;
    }
  };

  const getDeletePopupPosition = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    const paneRect = movePaneRef.current?.getBoundingClientRect();
    const rawX = rect.left + rect.width / 2;
    const rawY = rect.bottom + 8;
    if (!paneRect) return { x: rawX, y: rawY };
    const horizontalPadding = 74;
    const verticalPadding = 8;
    const popupApproxHeight = 50;
    const x = Math.max(paneRect.left + horizontalPadding, Math.min(rawX, paneRect.right - horizontalPadding));
    const y = Math.max(
      paneRect.top + verticalPadding,
      Math.min(rawY, paneRect.bottom - popupApproxHeight - verticalPadding),
    );
    return { x, y };
  };

  const handleTreeOptionPointerDown = (node: MoveNode, event: PointerEvent<HTMLButtonElement>) => {
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
      if (node.moveUci) playLichessMove(node.moveUci);
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

  const handleInlineMoveClick = (moveId: string, event: MouseEvent<HTMLButtonElement>) => {
    if (inlineMoveLongPressHandledNodeRef.current === moveId) {
      event.preventDefault();
      inlineMoveLongPressHandledNodeRef.current = null;
      return;
    }
    navigateToNode(activeSide, moveId);
  };

  const deleteTreeOptionBranch = () => {
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
      const value =
        node.children.length === 0
          ? 1
          : node.children.reduce((acc, childId) => acc + countLeavesInTree(treeToCount, childId, memo), 0);
      memo.set(nodeId, value);
      return value;
    };

    if (!isBrowseMode) {
      return countLeavesInTree(sideTree, root.id, new Map<string, number>());
    }

    const rootFenKey = positionFenKey(root.fen);
    return repertoiresBySide[trainingSession.side]
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
  }, [trainingSession, activeSide, trees, isBrowseMode, repertoiresBySide]);

  const trainingAnsweredLines = useMemo(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return 0;
    return new Set(trainingSession.completedLeafNodeIds).size;
  }, [trainingSession, activeSide]);
  const hasTrainingContent = useMemo(() => {
    if (!trainingSession || trainingSession.side !== activeSide) return false;
    return hasSideTrainingContent(trainingSession.side);
  }, [trainingSession, activeSide, hasSideTrainingContent]);
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
    if (!currentNode || currentNode.children.length !== 0) return;
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
      return repertoiresBySide[activeSide].flatMap((repertoire) =>
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
    if (isTreeEvalRunning) return;
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
      if (engineReadyRef.current) return true;
      for (let i = 0; i < 100; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        if (engineReadyRef.current) return true;
      }
      return false;
    };

    if (!treeEvalCancelRef.current && localTotal > 0) {
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
        scoreText = await new Promise<string | null>((resolve) => {
          treeEvalAwaiterRef.current = { latestScore: null, resolve };
          engineWhitePerspectiveMultiplierRef.current = whitePerspectiveMultiplierFromFen(normalizedFen);
          worker.postMessage('setoption name MultiPV value 1');
          worker.postMessage(`position fen ${normalizedFen}`);
          worker.postMessage(`go movetime ${stockfishEvalSeconds * 1000}`);
        });
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
      const nodes = repertoiresBySide[activeSide].flatMap((entry) => Object.values(entry.tree.nodes));
      const missing = nodes.reduce((acc, node) => acc + (hasEval(node) ? 0 : 1), 0);
      return { total: nodes.length, missing };
    }
    const nodes = Object.values(trees[activeSide].nodes);
    const missing = nodes.reduce((acc, node) => acc + (hasEval(node) ? 0 : 1), 0);
    return { total: nodes.length, missing };
  }, [isBrowseMode, repertoiresBySide, trees, activeSide]);

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
    if (isBrowseMode) return;
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
  }, [activeSide, isBrowseMode, lichessData, lichessStatus, selectedNodeBySide]);

  const goBackOneMove = () => {
    if (isTrainingActive || isSuddenDeathActive) return;
    const parentId = selectedNode.parentId;
    if (!parentId) return;
    navigateToNode(activeSide, parentId);
  };

  const goBackToPreviousBranchMove = () => {
    if (isTrainingActive || isSuddenDeathActive) return;
    let cursorId = selectedNode.parentId;
    while (cursorId) {
      const node = tree.nodes[cursorId];
      if (!node) break;
      if (node.children.length > 1) {
        navigateToNode(activeSide, node.id);
        return;
      }
      cursorId = node.parentId;
    }
    if (selectedNode.id !== tree.rootId) {
      navigateToNode(activeSide, tree.rootId);
    }
  };

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
        goBackToPreviousBranchMove();
        scheduleBackLongPressStage();
      }, 450);
      return;
    }
    if (backLongPressStageRef.current === 1) {
      backLongPressTimeoutRef.current = window.setTimeout(() => {
        if (!backLongPressIsDownRef.current) return;
        backLongPressHandledRef.current = true;
        backLongPressStageRef.current = 2;
        if (selectedNode.id !== tree.rootId) {
          navigateToNode(activeSide, tree.rootId);
        }
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

  const clearTrainButtonLongPress = () => {
    if (trainButtonLongPressTimeoutRef.current !== null) {
      window.clearTimeout(trainButtonLongPressTimeoutRef.current);
      trainButtonLongPressTimeoutRef.current = null;
    }
  };

  const handleTrainButtonPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (isTrainingActive) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearTrainButtonLongPress();
    trainButtonLongPressHandledRef.current = false;
    trainButtonLongPressTimeoutRef.current = window.setTimeout(() => {
      trainButtonLongPressHandledRef.current = true;
      setPortraitTab('moves');
      setIsTrainingStatsMenuOpen(true);
      setIsMoveToolsOpen(false);
    }, 420);
  };

  const handleTrainButtonPointerEnd = () => {
    clearTrainButtonLongPress();
  };

  const handleTrainButtonClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (trainButtonLongPressHandledRef.current) {
      event.preventDefault();
      trainButtonLongPressHandledRef.current = false;
      return;
    }
    if (isTrainingActive) {
      stopTraining();
      return;
    }
    startTraining();
  };

  const clearSuddenDeathButtonLongPress = () => {
    if (suddenDeathButtonLongPressTimeoutRef.current !== null) {
      window.clearTimeout(suddenDeathButtonLongPressTimeoutRef.current);
      suddenDeathButtonLongPressTimeoutRef.current = null;
    }
  };

  const handleSuddenDeathButtonPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearSuddenDeathButtonLongPress();
    suddenDeathButtonLongPressHandledRef.current = false;
    suddenDeathButtonLongPressTimeoutRef.current = window.setTimeout(() => {
      suddenDeathButtonLongPressHandledRef.current = true;
      setPortraitTab('moves');
      setIsSuddenDeathSettingsOpen(true);
      setIsTrainingStatsMenuOpen(false);
      setIsMoveToolsOpen(false);
    }, 420);
  };

  const handleSuddenDeathButtonPointerEnd = () => {
    clearSuddenDeathButtonLongPress();
  };

  const handleSuddenDeathButtonClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (suddenDeathButtonLongPressHandledRef.current) {
      event.preventDefault();
      suddenDeathButtonLongPressHandledRef.current = false;
      return;
    }
    toggleSuddenDeathMode();
  };

  const clearMovesButtonLongPress = () => {
    if (movesButtonLongPressTimeoutRef.current !== null) {
      window.clearTimeout(movesButtonLongPressTimeoutRef.current);
      movesButtonLongPressTimeoutRef.current = null;
    }
  };

  const handlePortraitMovesPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearMovesButtonLongPress();
    movesButtonLongPressHandledRef.current = false;
    movesButtonLongPressTimeoutRef.current = window.setTimeout(() => {
      movesButtonLongPressHandledRef.current = true;
      setPortraitTab('moves');
      setIsMoveToolsOpen(true);
      setIsTrainingStatsMenuOpen(false);
    }, 420);
  };

  const handlePortraitMovesPointerEnd = () => {
    clearMovesButtonLongPress();
  };

  const handlePortraitMovesClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (movesButtonLongPressHandledRef.current) {
      event.preventDefault();
      movesButtonLongPressHandledRef.current = false;
      return;
    }
    setPortraitTab('moves');
  };

  const clearDbButtonLongPress = () => {
    if (dbButtonLongPressTimeoutRef.current !== null) {
      window.clearTimeout(dbButtonLongPressTimeoutRef.current);
      dbButtonLongPressTimeoutRef.current = null;
    }
  };

  const handlePortraitDbPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearDbButtonLongPress();
    dbButtonLongPressHandledRef.current = false;
    dbButtonLongPressTimeoutRef.current = window.setTimeout(() => {
      dbButtonLongPressHandledRef.current = true;
      setIsLichessFilterOpen(true);
    }, 420);
  };

  const handlePortraitDbPointerEnd = () => {
    clearDbButtonLongPress();
  };

  const handlePortraitDbClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (dbButtonLongPressHandledRef.current) {
      event.preventDefault();
      dbButtonLongPressHandledRef.current = false;
      return;
    }
    setPortraitTab('lichess');
  };

  const clearStockfishButtonLongPress = () => {
    if (stockfishButtonLongPressTimeoutRef.current !== null) {
      window.clearTimeout(stockfishButtonLongPressTimeoutRef.current);
      stockfishButtonLongPressTimeoutRef.current = null;
    }
  };

  const handlePortraitStockfishPointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearStockfishButtonLongPress();
    stockfishButtonLongPressHandledRef.current = false;
    stockfishButtonLongPressTimeoutRef.current = window.setTimeout(() => {
      stockfishButtonLongPressHandledRef.current = true;
      setIsStockfishQuickOpen(true);
    }, 420);
  };

  const handlePortraitStockfishPointerEnd = () => {
    clearStockfishButtonLongPress();
  };

  const handlePortraitStockfishClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (stockfishButtonLongPressHandledRef.current) {
      event.preventDefault();
      stockfishButtonLongPressHandledRef.current = false;
      return;
    }
    setPortraitTab('stockfish');
  };

  useEffect(
    () => () => {
      clearBackLongPress();
      clearTreeOptionLongPress();
      clearInlineMoveLongPress();
      clearDbButtonLongPress();
      clearStockfishButtonLongPress();
      clearTrainButtonLongPress();
      clearSuddenDeathButtonLongPress();
      clearMovesButtonLongPress();
    },
    [],
  );

  const deleteLastMove = () => {
    if (isTrainingActive || isSuddenDeathActive) return;
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
            {!isTrainingActive && <aside className={`lichess-panel card portrait-pane ${portraitTab === 'lichess' ? 'active' : ''}`}>
              {(visibleLichessStatus || lichessStatus === 'loading') && (
                <div className="status lichess-status-row">
                  {lichessStatus === 'loading' && <span className="spinner" aria-hidden="true" />}
                  <span>{visibleLichessStatus || 'loading'}</span>
                </div>
              )}
              {lichessStatus === 'limited' && !lichessData && (
                <div className="status lichess-rate-limit-note">
                  {`Lichess API error (429), ${lichessData ? 'showing cached data' : 'no cached data'}`}
                </div>
              )}
              {lichessApiIssueNote && !lichessData && (
                <div className="status lichess-rate-limit-note">{lichessApiIssueNote}</div>
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
                  <div className="lichess-table-actions desktop-only">
                    <button
                      className="gear-btn"
                      type="button"
                      aria-label="Filters"
                      title="Filters"
                      onClick={() => setIsLichessFilterOpen(true)}
                    >
                      ⚙
                    </button>
                  </div>
                  <div className="stockfish-inline desktop-only">
                    <div className="controls-row stockfish-controls-row">
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
                      <button
                        type="button"
                        className="stockfish-settings-btn"
                        aria-label="Stockfish options"
                        title="Stockfish options"
                        onClick={() => setIsStockfishQuickOpen(true)}
                      >
                        ⚙
                      </button>
                      <div className="stockfish-controls-right">
                        <span className="inline-stepper">
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
                        {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
                      </div>
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
                  <span className="games-total">
                    {formatGamesCount(lichessTotal)}
                    {visibleEngineEval && <span className="games-eval-inline">{` ${visibleEngineEval}`}</span>}
                  </span>
                </div>
              </div>
              <Board
                fen={boardFen}
                orientation={boardOrientation}
                lastMove={boardLastMove}
                arrows={trainingForActive ? trainingHintArrow : autoArrows}
                onMove={makeMove}
              />
              <div className="portrait-tabbar">
                {!isTrainingActive && (
                  <>
                    <button
                      type="button"
                      className={`long-pressable-btn ${portraitTab === 'lichess' ? 'active' : ''}`}
                      onClick={handlePortraitDbClick}
                      onPointerDown={handlePortraitDbPointerDown}
                      onPointerUp={handlePortraitDbPointerEnd}
                      onPointerCancel={handlePortraitDbPointerEnd}
                      onPointerLeave={handlePortraitDbPointerEnd}
                      aria-label="Lichess"
                      title="Lichess (long press: filters)"
                    >
                      <DbIcon />
                    </button>
                    <button
                      type="button"
                      className={`long-pressable-btn ${portraitTab === 'stockfish' ? 'active' : ''}`}
                      onClick={handlePortraitStockfishClick}
                      onPointerDown={handlePortraitStockfishPointerDown}
                      onPointerUp={handlePortraitStockfishPointerEnd}
                      onPointerCancel={handlePortraitStockfishPointerEnd}
                      onPointerLeave={handlePortraitStockfishPointerEnd}
                      aria-label="Stockfish"
                      title="Stockfish (long press: quick settings)"
                    >
                      <ComputerIcon />
                    </button>
                    <button
                      type="button"
                      className={`long-pressable-btn ${portraitTab === 'moves' ? 'active' : ''}`}
                      onClick={handlePortraitMovesClick}
                      onPointerDown={handlePortraitMovesPointerDown}
                      onPointerUp={handlePortraitMovesPointerEnd}
                      onPointerCancel={handlePortraitMovesPointerEnd}
                      onPointerLeave={handlePortraitMovesPointerEnd}
                      aria-label="Moves"
                      title="Moves (long press: options)"
                    >
                      <MoveIcon />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`${isTrainingActive ? 'active training-stop-btn' : ''} long-pressable-btn`}
                  onClick={handleTrainButtonClick}
                  onPointerDown={handleTrainButtonPointerDown}
                  onPointerUp={handleTrainButtonPointerEnd}
                  onPointerCancel={handleTrainButtonPointerEnd}
                  onPointerLeave={handleTrainButtonPointerEnd}
                  aria-label={isTrainingActive ? 'Stop training' : 'Train'}
                  title={isTrainingActive ? 'Stop training' : 'Train (long press: options)'}
                  disabled={!isTrainingActive && !canStartTrainingForActiveSide}
                >
                  {isTrainingActive ? 'Stop training' : <TrainIcon />}
                </button>
                {!isTrainingActive && (
                  <button
                    type="button"
                    className={
                      trainingSession?.suddenDeathMode
                        ? 'active sudden-death-toggle-btn mode-icon-btn has-submenu-dot'
                        : 'sudden-death-toggle-btn mode-icon-btn has-submenu-dot'
                    }
                    onClick={handleSuddenDeathButtonClick}
                    onPointerDown={handleSuddenDeathButtonPointerDown}
                    onPointerUp={handleSuddenDeathButtonPointerEnd}
                    onPointerCancel={handleSuddenDeathButtonPointerEnd}
                    onPointerLeave={handleSuddenDeathButtonPointerEnd}
                    aria-label={isSuddenDeathActive ? 'Restart sudden death round' : 'Start sudden death training'}
                    title={isSuddenDeathActive ? 'Restart sudden death round (long press: options)' : 'Start sudden death training (long press: options)'}
                    disabled={suddenDeathThinking}
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
                {isTrainingActive &&
                  isTrainingLineEnd &&
                  hasTrainingContent &&
                  trainingAnsweredLines < trainingTotalLines &&
                  !trainingSession?.flashcardMode &&
                  !trainingSession?.suddenDeathMode && (
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
                {!isTrainingActive && (
                  <button
                    type="button"
                    className="portrait-back-btn long-pressable-btn"
                    onClick={handleBackClick}
                    onPointerDown={handleBackPointerDown}
                    onPointerUp={handleBackPointerEnd}
                    onPointerCancel={handleBackPointerEnd}
                    onPointerLeave={handleBackPointerEnd}
                    disabled={!canGoBack}
                    aria-label="Back 1 move"
                    title="Back 1 move (long press: previous branch)"
                  >
                    <BackIcon />
                  </button>
                )}
              </div>
            </div>
            {!isTrainingActive && <aside className={`stockfish-panel card portrait-only portrait-pane ${portraitTab === 'stockfish' ? 'active' : ''}`}>
              <div className="controls-row stockfish-controls-row">
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
                <button
                  type="button"
                  className="stockfish-settings-btn"
                  aria-label="Stockfish options"
                  title="Stockfish options"
                  onClick={() => setIsStockfishQuickOpen(true)}
                >
                  ⚙
                </button>
                <div className="stockfish-controls-right">
                  <span className="inline-stepper">
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
                  {visibleEngineStatus && <span className="status">{visibleEngineStatus}</span>}
                </div>
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

            <aside
              ref={(element) => {
                movePaneRef.current = element;
              }}
              className={`move-list card portrait-pane ${portraitTab === 'moves' ? 'active' : ''} ${isTrainingActive ? 'training-pane' : ''}`}
            >
              {isTrainingActive ? (
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
                  {isTrainingStatsMenuOpen && (
                    <div
                      ref={(element) => {
                        trainingStatsMenuRef.current = element;
                      }}
                      className="training-stats-dropdown"
                    >
                      <div className="training-stats-menu-actions">
                        <button
                          type="button"
                          onClick={() => {
                            clearActiveTrainingStatistics();
                          }}
                        >
                          Clear current repertoire stats
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            clearAllTrainingStatistics();
                          }}
                        >
                          Clear all stats
                        </button>
                      </div>
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
                              onChange={(e) => {
                                const next = Number.parseInt(e.target.value, 10);
                                if (Number.isFinite(next)) {
                                  setTrainingStatsQueueLength(
                                    Math.min(TRAINING_STATS_QUEUE_MAX, Math.max(TRAINING_STATS_QUEUE_MIN, next)),
                                  );
                                }
                              }}
                            />
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                  <div className="training-repertoire-name" title={isBrowseMode ? `${activeSide}: whole db` : activeRepertoireName}>
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
                      <span className="status">Stockfish thinking...</span>
                    </div>
                  )}
                  <div className="controls-row training-position-stats">
                    <span className="status">{`This position success rate: ${trainingPositionSuccessPct}%`}</span>
                  </div>
                  {suddenDeathGameOver && (
                    <div className="controls-row training-position-stats training-game-over-row">
                      <span className="status">{`Sudden death over (${suddenDeathGameOver.side}): ${formatSignedCp(
                        suddenDeathGameOver.baselineEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1),
                      )} -> ${formatSignedCp(
                        suddenDeathGameOver.failedEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1),
                      )} (threshold ${(
                        suddenDeathGameOver.thresholdCp / 100
                      ).toFixed(2)})`}</span>
                    </div>
                  )}
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
                  <div className="controls-row">
                    {isTrainingLineEnd &&
                      hasTrainingContent &&
                      trainingAnsweredLines < trainingTotalLines &&
                      !trainingSession?.flashcardMode &&
                      !trainingSession?.suddenDeathMode && (
                      <button type="button" className="continue-training-btn desktop-only" onClick={restartTrainingLine}>
                        Continue
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {isTrainingStatsMenuOpen && (
                    <div
                      ref={(element) => {
                        trainingStatsMenuRef.current = element;
                      }}
                      className="training-stats-dropdown"
                    >
                      <div className="training-stats-menu-actions">
                        <button
                          type="button"
                          onClick={() => {
                            clearActiveTrainingStatistics();
                          }}
                        >
                          Clear current repertoire stats
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            clearAllTrainingStatistics();
                          }}
                        >
                          Clear all stats
                        </button>
                      </div>
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
                              onChange={(e) => {
                                const next = Number.parseInt(e.target.value, 10);
                                if (Number.isFinite(next)) {
                                  setTrainingStatsQueueLength(
                                    Math.min(TRAINING_STATS_QUEUE_MAX, Math.max(TRAINING_STATS_QUEUE_MIN, next)),
                                  );
                                }
                              }}
                            />
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                  <div className="controls-row">
                    <button
                      className="desktop-only back-btn"
                      onClick={handleBackClick}
                      onPointerDown={handleBackPointerDown}
                      onPointerUp={handleBackPointerEnd}
                      onPointerCancel={handleBackPointerEnd}
                      onPointerLeave={handleBackPointerEnd}
                      disabled={!canGoBack}
                      aria-label="Back 1 move"
                      title="Back 1 move"
                    >
                      <BackIcon />
                    </button>
                    <button
                      className="danger"
                      onClick={deleteLastMove}
                      disabled={!canGoBack || isBrowseMode}
                      aria-label="Delete last move"
                      title="Delete last move"
                    >
                      ✕
                    </button>
                    <button onClick={undoNavigation} disabled={undoStackBySide[activeSide].length === 0}>
                      Undo
                    </button>
                    <button
                      className="desktop-only"
                      type="button"
                      onClick={handleTrainButtonClick}
                      title="Train"
                      disabled={!canStartTrainingForActiveSide}
                    >
                      Train
                    </button>
                    <button
                      type="button"
                      className="sudden-death-toggle-btn mode-icon-btn desktop-only"
                      onClick={handleSuddenDeathButtonClick}
                      aria-label={isSuddenDeathActive ? 'Restart sudden death round' : 'Start sudden death training'}
                      title={isSuddenDeathActive ? 'Restart sudden death round' : 'Start sudden death training'}
                      disabled={suddenDeathThinking}
                    >
                      <SuddenDeathIcon />
                    </button>
                    <span className="controls-row-break" aria-hidden="true" />
                    <button
                      type="button"
                      className="next-missing-btn"
                      onClick={jumpToNextMissingLichessMove}
                      disabled={!canRunFindMissingSearch}
                      aria-label="Find missing popular opponent move"
                      title={`Find missing popular opponent move (${lichessArrowThreshold}%+)`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <circle cx="12" cy="12" r="4.2" />
                        <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
                        <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2" />
                      </svg>
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
                  {suddenDeathGameOver && (
                    <div className="controls-row training-position-stats training-game-over-row">
                      <span className="status">{`Sudden death over (${suddenDeathGameOver.side}): ${formatSignedCp(
                        suddenDeathGameOver.baselineEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1),
                      )} -> ${formatSignedCp(
                        suddenDeathGameOver.failedEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1),
                      )} (threshold ${(
                        suddenDeathGameOver.thresholdCp / 100
                      ).toFixed(2)})`}</span>
                    </div>
                  )}
                  <div className="move-notation-line">
                    <div className="move-inline-wrap">
                      {inlineMoves.map((move) => (
                        <button
                          key={move.id}
                          type="button"
                          className={`move-inline-item ${move.hasAlternatives ? 'has-alternatives' : ''}`}
                          onClick={(event) => handleInlineMoveClick(move.id, event)}
                          onPointerDown={(event) => handleInlineMovePointerDown(move.id, event)}
                          onPointerUp={handleInlineMovePointerEnd}
                          onPointerCancel={handleInlineMovePointerEnd}
                          onPointerLeave={handleInlineMovePointerEnd}
                        >
                          {move.prefix ? <span className="move-inline-prefix">{move.prefix}</span> : null}
                          <span>{move.san}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {optionRows.length > 0 && (
                    <div className="tree-options-wrap">
                      {optionRows.map(({ node, leaves }) => (
                        <div key={node.id} className="tree-option">
                          <button
                            type="button"
                            className="tree-option-btn"
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
                            {toFigurineSan(node.moveSan ?? '')}
                          </button>
                          <span className="tree-option-leaves">
                            {node.stockfishEval ? `SF ${node.stockfishEval} | ${leaves}` : leaves}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {repertoiresAtPosition.length === 0 && (
                    <div className="repertoire-hit-block move-tools-only desktop-only">
                      <div className="repertoire-hit-head">
                        <span />
                        <button
                          type="button"
                          className={`gear-btn ${isMoveToolsOpen ? 'active' : ''}`}
                          aria-label="Move tools"
                          title="Move tools"
                          onClick={() => {
                            setIsMoveToolsOpen((prev) => !prev);
                            setIsTrainingStatsMenuOpen(false);
                          }}
                        >
                          ⚙
                        </button>
                      </div>
                    </div>
                  )}
                  {repertoiresAtPosition.length > 0 && (
                    <div className="repertoire-hit-block">
                      <div className="repertoire-hit-head">
                        <strong>Repertoires with this position</strong>
                        <button
                          type="button"
                          className={`gear-btn desktop-only ${isMoveToolsOpen ? 'active' : ''}`}
                          aria-label="Move tools"
                          title="Move tools"
                          onClick={() => {
                            setIsMoveToolsOpen((prev) => !prev);
                            setIsTrainingStatsMenuOpen(false);
                          }}
                        >
                          ⚙
                        </button>
                      </div>
                      <div className="repertoire-hit-list">
                        {repertoiresAtPosition.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={`repertoire-hit-item ${item.isActive ? 'active' : ''}`}
                            onClick={() => {
                              if (item.isActive) {
                                enterBrowseMode(activeSide);
                                return;
                              }
                              loadRepertoire(item.id, activeSide, true);
                            }}
                          >
                            {item.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </aside>
          </div>

        </section>
      </main>

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
            style={{ left: `${treeOptionDeletePopup.x}px`, top: `${treeOptionDeletePopup.y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="danger" onClick={deleteTreeOptionBranch}>
              Delete branch
            </button>
          </div>
        </>
      )}

      {isStockfishQuickOpen && (
        <div className="modal-backdrop" onClick={() => setIsStockfishQuickOpen(false)}>
          <div className="modal-card stockfish-quick-modal" onClick={(e) => e.stopPropagation()}>
            <div className="slider-stack single-column">
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

      {isMoveToolsOpen && (
        <div className="modal-backdrop" onClick={() => setIsMoveToolsOpen(false)}>
          <div className="modal-card stockfish-quick-modal move-tools-modal" onClick={(e) => e.stopPropagation()}>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={showLichessOnTreeMoves}
                onChange={(e) => setShowLichessOnTreeMoves(e.target.checked)}
              />
              Show Lichess arrows for tree moves
            </label>
            <div className="desktop-only">
              <h3 className="eval-manager-title">Sudden death settings</h3>
              <div className="slider-stack single-column">
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
                <label>
                  {`Stockfish: ${suddenDeathStockfishElo >= SUDDEN_DEATH_STOCKFISH_ELO_MAX ? 'Max' : suddenDeathStockfishElo}`}
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
              </div>
            </div>
          </div>
        </div>
      )}

      {isSuddenDeathSettingsOpen && (
        <div className="modal-backdrop" onClick={() => setIsSuddenDeathSettingsOpen(false)}>
          <div className="modal-card stockfish-quick-modal sudden-death-settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">Sudden death settings</h3>
            <div className="slider-stack single-column">
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
              <label>
                {`Stockfish: ${suddenDeathStockfishElo >= SUDDEN_DEATH_STOCKFISH_ELO_MAX ? 'Max' : suddenDeathStockfishElo}`}
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
            </div>
          </div>
        </div>
      )}

      {isEvalManagerOpen && (
        <div className="modal-backdrop" onClick={() => { if (!isTreeEvalRunning) setIsEvalManagerOpen(false); }}>
          <div className="modal-card stockfish-quick-modal eval-manager-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">Stockfish evals</h3>
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

      {suddenDeathGameOver && (
        <div className="modal-backdrop" onClick={closeSuddenDeathGameOverPopup}>
          <div className="modal-card stockfish-quick-modal eval-manager-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="eval-manager-title">Sudden death over</h3>
            <div className="status">{`${suddenDeathGameOver.side}: ${formatSignedCp(
              suddenDeathGameOver.baselineEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1),
            )} -> ${formatSignedCp(suddenDeathGameOver.failedEvalCp * (suddenDeathGameOver.side === 'white' ? 1 : -1))}`}</div>
            <div className="status">{`Drop threshold: ${(suddenDeathGameOver.thresholdCp / 100).toFixed(2)}`}</div>
            <div className="eval-manager-actions">
              <button type="button" onClick={closeSuddenDeathGameOverPopup}>
                Close
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
              className={`current-repertoire ${!isBrowseMode ? 'active-repertoire' : ''}`}
              title={activeRepertoireName}
            >
              {isBrowseMode ? activeRepertoireName : `${activeSide}: ${activeRepertoireName}`}
            </div>
            <div className="options-grid">
              <button
                disabled={isTreeEvalRunning}
                onClick={() => {
                  if (isBrowseMode) {
                    setRepertoireSide((prev) => (prev === 'white' ? 'black' : 'white'));
                    setIsTempBoardFlipped(false);
                  } else {
                    setIsTempBoardFlipped((prev) => !prev);
                  }
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
                disabled={isTreeEvalRunning}
                onClick={() => enterBrowseMode(activeSide)}
              >
                Review mode
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
                Add Stockfish evals
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
                        <button
                          type="button"
                          className={entry.id === activeRepertoireIdBySide[loadRepertoireSide] ? 'active' : ''}
                          onClick={() => loadRepertoire(entry.id, loadRepertoireSide)}
                        >
                          {entry.name}
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
        <div className="modal-backdrop" onClick={() => setIsLichessFilterOpen(false)}>
          <div className="modal-card filters-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filters-modal-main">
              <div className="filters-grid">
                <label>
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
                  {`Min frequency: ${lichessArrowThreshold}%`}
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
    </div>
  );
}

export default App;







