import { subscribeMaiaProgress, type MaiaEvaluateParams, type MaiaEvaluation, type MaiaLoadingStatus } from './maiaInference';

const MAIA_MODEL_URL = '/maia/maia3/maia3-79m.fp16.onnx';
const MAIA_MODEL_VERSION = MAIA_MODEL_URL.match(/\/maia(\d+)\//i)?.[1];
export const MAIA_ENGINE_LABEL = `Maia${MAIA_MODEL_VERSION ?? ''}`;

type WorkerRequest = { id: number; params: MaiaEvaluateParams };
type WorkerResponse = { id: number; result?: MaiaEvaluation; error?: string; phase?: 'evaluating'; loading?: MaiaLoadingStatus };
export type MaiaEngineStatus = { phase: 'loading' | 'evaluating' | 'ready' | 'error'; detail?: MaiaLoadingStatus | string };
type PendingRequest = {
  resolve: (evaluation: MaiaEvaluation) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  evaluationTimeoutMs: number;
};

export type { MaiaLoadingStatus };
const statusListeners = new Set<(status: MaiaEngineStatus) => void>();
function reportStatus(status: MaiaEngineStatus) {
  for (const listener of statusListeners) listener(status);
}
subscribeMaiaProgress((detail) => reportStatus({ phase: 'loading', detail }));
export function subscribeMaiaStatus(listener: (status: MaiaEngineStatus) => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_CACHED_EVALUATIONS = 256;
let worker: Worker | null = null;
let nextRequestId = 1;
let ready = false;
const pending = new Map<number, PendingRequest>();
const evaluationCache = new Map<string, MaiaEvaluation>();

function rejectPending(error: Error) {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pending.clear();
}

function stopWorker(error: Error, notify = true) {
  const current = worker;
  worker = null;
  ready = false;
  current?.terminate();
  rejectPending(error);
  if (notify) reportStatus({ phase: 'error', detail: error.message });
}

function handleMessage(event: MessageEvent<WorkerResponse>) {
  const response = event.data;
  if (response.loading) { reportStatus({ phase: 'loading', detail: response.loading }); return; }
  const request = pending.get(response.id);
  if (!request) return;
  if (response.phase === 'evaluating') {
    ready = true;
    reportStatus({ phase: 'evaluating' });
    clearTimeout(request.timeout);
    request.timeout = setTimeout(() => {
      if (pending.has(response.id)) stopWorker(new Error(`Maia evaluation timed out after ${request.evaluationTimeoutMs} ms`));
    }, request.evaluationTimeoutMs);
    return;
  }
  pending.delete(response.id);
  clearTimeout(request.timeout);
  if (response.error !== undefined) {
    reportStatus({ phase: 'error', detail: response.error });
    request.reject(new Error(response.error));
  } else if (response.result !== undefined) {
    ready = true;
    reportStatus({ phase: 'ready' });
    request.resolve(response.result);
  } else {
    reportStatus({ phase: 'error', detail: 'Maia worker returned an empty response' });
    request.reject(new Error('Maia worker returned an empty response'));
  }
}

function getWorker() {
  if (!worker) {
    const instance = new Worker(new URL('./maiaWorker.ts', import.meta.url), { type: 'module' });
    worker = instance;
    instance.addEventListener('message', handleMessage);
    instance.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === instance) stopWorker(new Error(event.message || 'Maia worker failed'));
    });
    instance.addEventListener('messageerror', () => {
      if (worker === instance) stopWorker(new Error('Maia worker sent an unreadable response'));
    });
  }
  return worker;
}

export function evaluateMaiaPosition(
  params: MaiaEvaluateParams,
  options: { timeoutMs?: number; initializationTimeoutMs?: number } = {},
): Promise<MaiaEvaluation> {
  const key = JSON.stringify(params);
  const cached = evaluationCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const initializationTimeoutMs = options.initializationTimeoutMs ?? timeoutMs;
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    if (!ready) {
      reportStatus({ phase: 'loading', detail: { phase: 'downloading', loadedBytes: 0, totalBytes: 0 } });
    } else {
      reportStatus({ phase: 'evaluating' });
    }
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;
      stopWorker(new Error(`Maia loading or queue wait timed out after ${initializationTimeoutMs} ms`));
    }, initializationTimeoutMs);
    pending.set(id, {
      resolve: (evaluation) => {
        evaluationCache.set(key, evaluation);
        if (evaluationCache.size > MAX_CACHED_EVALUATIONS) {
          const oldestKey = evaluationCache.keys().next().value;
          if (oldestKey !== undefined) evaluationCache.delete(oldestKey);
        }
        resolve(evaluation);
      },
      reject,
      timeout,
      evaluationTimeoutMs: timeoutMs,
    });
    try {
      const request: WorkerRequest = { id, params };
      getWorker().postMessage(request);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timeout);
      const failure = error instanceof Error ? error : new Error(String(error));
      reportStatus({ phase: 'error', detail: failure.message });
      reject(failure);
    }
  });
}

export function isMaiaReady() { return ready; }

export function cancelMaiaEvaluations() {
  stopWorker(new Error('Maia analysis cancelled'), false);
}

export type { MaiaEvaluateParams, MaiaEvaluation } from './maiaInference';
