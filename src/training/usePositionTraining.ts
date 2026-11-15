import { useCallback, useEffect, useMemo, useState } from 'react';
import { emptyOpeningFeed, finishOpeningAssessment, intakeOpeningGames, nextOpeningAssessment, openingTrainingEvidence,
  openingRepertoireSignature, recentOpeningGames, verifyOpeningMove, type OpeningFeed } from './openingFeed';
import type { PlayerGame } from '../analysis/playerGameHistory';
import { recordPositionReview, type PositionReview, type ActiveTrainingRepertoires, type ReviewOutcome } from './schedule';

export type PositionTrainingData = {
  version: 1;
  reviews: Record<string, PositionReview>;
  feed: OpeningFeed;
};
type Scope = { key: string; data: PositionTrainingData };
const emptyData: PositionTrainingData = { version: 1, reviews: {}, feed: emptyOpeningFeed };
const noGames: readonly PlayerGame[] = [];
export const POSITION_TRAINING_KEY_PREFIX = 'position-training-v1:';
const MAX_REVIEWS = 10_000;
const saveTails = new Map<string, Promise<void>>();

export function isPositionTrainingData(value: unknown): value is PositionTrainingData {
  const record = (item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!record(value)) return false;
  const { version, reviews, feed } = value as PositionTrainingData;
  return version === 1 && record(reviews) && Object.values(reviews).every(review =>
    record(review) && Number.isFinite(review.dueAt) && Number.isFinite(review.reviewedAt) &&
    Number.isInteger(review.stage) && ['first', 'assisted', 'corrected', 'missed'].includes(review.outcome)
  ) && record(feed) && feed.version === 1 &&
    Array.isArray(feed.seenGames) && feed.seenGames.every(id => typeof id === 'string') &&
    [feed.pending, feed.checked, feed.missing].every(entries => record(entries) &&
      Object.values(entries).every(lead => record(lead) && Array.isArray(lead.games)));
}

export function waitForPositionTrainingWrites() {
  return Promise.all(saveTails.values());
}

type Options = {
  identity: string;
  loaded: boolean;
  games?: readonly PlayerGame[];
  active: ActiveTrainingRepertoires;
  idle: boolean;
  read: <T>(key: string) => Promise<T | null>;
  write: <T>(key: string, value: T) => Promise<void>;
  query: Parameters<typeof verifyOpeningMove>[1];
};

export function usePositionTraining({ identity, loaded, games, active, idle, read, write, query }: Options) {
  const key = `${POSITION_TRAINING_KEY_PREFIX}${identity ? JSON.stringify(identity) : 'local'}`;
  const [scope, setScope] = useState<Scope | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const data = scope?.key === key ? scope.data : null;
  const signature = useMemo(() => openingRepertoireSignature(active), [active]);
  const day = Math.floor(clock / 86_400_000);
  const recentGames = useMemo(() => recentOpeningGames(games ?? noGames, day * 86_400_000), [games, day]);

  useEffect(() => {
    const update = () => {
      setPageVisible(!document.hidden);
      setClock(Date.now());
    };
    const timer = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let stale = false;
    const restore = async () => {
      await saveTails.get(key);
      const saved = await read<unknown>(key);
      if (saved !== null && !isPositionTrainingData(saved)) throw new Error('Invalid stored training progress.');
      if (!stale) {
        setScope({ key, data: saved ?? emptyData });
        setError(null);
      }
    };
    void restore().catch(() => {
      if (!stale) {
        setError({ key, message: 'Could not read saved training progress.' });
      }
    });
    return () => { stale = true; };
  }, [key, loaded, read, readAttempt]);

  useEffect(() => {
    if (!data || data === emptyData) return;
    const saving = (saveTails.get(key) ?? Promise.resolve()).then(() => write(key, data))
      .then(() => { setError(previous => previous?.key === key ? null : previous); })
      .catch(() => setError(previous => previous && previous.key !== key ? previous : { key, message: 'Could not save training progress.' }));
    saveTails.set(key, saving);
    void saving.finally(() => { if (saveTails.get(key) === saving) saveTails.delete(key); });
  }, [key, data, write]);

  const update = useCallback((change: (previous: PositionTrainingData) => PositionTrainingData) => setScope(previous => {
    if (previous?.key !== key) return previous;
    const next = change(previous.data);
    return next === previous.data ? previous : { key, data: next };
  }), [key]);

  useEffect(() => {
    if (!data || !idle || !pageVisible || !recentGames.length) return;
    const controller = new AbortController();
    const pass = () => {
      const starting = data.feed.repertoireSignature === signature ? data.feed : { ...emptyOpeningFeed, repertoireSignature: signature };
      const imported = intakeOpeningGames(starting, recentGames, active);
      if (imported !== data.feed) {
        update(previous => previous.feed === data.feed ? { ...previous, feed: imported } : previous);
        return;
      }
      const job = nextOpeningAssessment(data.feed, active, Date.now());
      if (!job) return;
      const [id, candidate] = job;
      void verifyOpeningMove(candidate, query, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        update(previous => ({ ...previous, feed: finishOpeningAssessment(previous.feed, id, result, Date.now()) }));
      }).catch(() => {
        if (!controller.signal.aborted) {
          update(previous => ({ ...previous, feed: finishOpeningAssessment(previous.feed, id, null, Date.now()) }));
        }
      });
    };
    const timer = window.setTimeout(pass, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [data, idle, pageVisible, recentGames, active, query, update, clock, signature]);

  const reviews = data?.reviews ?? emptyData.reviews;
  const feed = data?.feed.repertoireSignature === signature ? data.feed : emptyOpeningFeed;
  const evidence = useMemo(() => openingTrainingEvidence(feed, active, clock), [feed, active, clock]);
  const record = useCallback((position: string, outcome: ReviewOutcome, latestMistakeAt = 0) => {
    const now = Date.now();
    setClock(now);
    update(previous => {
      const old = previous.reviews[position];
      const reset = old && old.reviewedAt < latestMistakeAt;
      const reviews = { ...previous.reviews, [position]: recordPositionReview(reset ? undefined : old, outcome, now) };
      if (Object.keys(reviews).length > MAX_REVIEWS) {
        const oldest = Object.keys(reviews).reduce((a, b) => reviews[a].reviewedAt < reviews[b].reviewedAt ? a : b);
        delete reviews[oldest];
      }
      return { ...previous, reviews };
    });
  }, [update]);

  const clear = useCallback((positions?: Iterable<string>) => {
    update(previous => {
      const reviews = { ...previous.reviews };
      if (!positions) return { ...previous, reviews: {} };
      for (const position of positions) delete reviews[position];
      return { ...previous, reviews };
    });
  }, [update]);

  const seen = useMemo(() => new Set(feed.seenGames), [feed.seenGames]);
  const pendingGames = recentGames.filter(game => active[game.color].size && !seen.has(game.id)).length;
  const pendingMoves = Object.values(feed.pending).filter(move => active[move.side].size).length;
  return { ready: Boolean(data), backupScope: data && data !== emptyData ? { key, data } : null,
    storageError: error?.key === key ? error.message : '',
    retryStorage: () => setReadAttempt(attempt => attempt + 1),
    clock, evidence, reviews, record, clear, pendingGames, pendingMoves };
}


