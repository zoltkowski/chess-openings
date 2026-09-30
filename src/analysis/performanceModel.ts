/** Experimental, uncalibrated performance signal from Maia rating profiles. */

export type MaiaRatingSample = { rating: number; probability: number; goodMassLower?: number; goodMassUpper?: number };
export type PerformanceDirection = 'upward' | 'downward' | 'invariant' | 'non-monotonic' | 'insufficient';
export type RatingSignal = {
  direction: PerformanceDirection;
  strength: number;
  confidence: number;
  /** Relative contribution to the aggregate; zero means not informative. */
  decisionWeight: number;
  significant: boolean;
  logOddsDelta: number;
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const logit = (p: number) => {
  const q = clamp(p, 0.0001, 0.9999);
  return Math.log(q / (1 - q));
};

/** Compare likelihood of the played decision across available Maia ratings. */
export function classifyRatingSignal(samples: MaiaRatingSample[], anchor: number): RatingSignal {
  const points = samples.filter(s => Number.isFinite(s.rating) && Number.isFinite(s.probability))
    .map(s => ({ rating: s.rating, p: clamp(s.probability, 0, 1) }))
    .sort((a, b) => a.rating - b.rating);
  const distinctPoints = points.filter((point, index) => index === 0 || point.rating !== points[index - 1].rating);
  if (distinctPoints.length < 3 || !Number.isFinite(anchor) || anchor < 1100 || anchor > 3000) return {
    direction: 'insufficient', strength: 0, confidence: 0, decisionWeight: 0, significant: false, logOddsDelta: 0,
  };

  const below = distinctPoints.filter(p => p.rating < anchor).length;
  const above = distinctPoints.filter(p => p.rating > anchor).length;
  const hasAnchorSample = distinctPoints.some(p => p.rating === anchor);
  const oneSided = anchor === 1100 || anchor === 3000;
  if ((oneSided && (!hasAnchorSample || (anchor === 1100 ? below !== 0 || above < 2 : above !== 0 || below < 2))) ||
    (!oneSided && (!hasAnchorSample || !below || !above))) return {
    direction: 'insufficient', strength: 0, confidence: 0, decisionWeight: 0, significant: false, logOddsDelta: 0,
  };
  const relevant = distinctPoints;
  const delta = logit(relevant.at(-1)!.p) - logit(relevant[0].p);
  const probDelta = relevant.at(-1)!.p - relevant[0].p;
  const logits = relevant.map(p => logit(p.p));
  const diffs = logits.slice(1).map((v, i) => v - logits[i]);
  const monotoneUp = diffs.every(d => d >= -0.12);
  const monotoneDown = diffs.every(d => d <= 0.12);
  const probabilityRange = Math.max(...relevant.map(p => p.p)) - Math.min(...relevant.map(p => p.p));
  const isInvariant = probabilityRange < 0.04 && Math.max(...logits) - Math.min(...logits) < 0.35;
  const significant = Math.abs(delta) >= 0.5 && (Math.abs(probDelta) >= 0.06 ||
    Math.abs(probDelta) >= 0.025 && Math.max(relevant[0].p, relevant.at(-1)!.p) >= 0.03);
  let direction: PerformanceDirection;
  if (isInvariant) direction = 'invariant';
  else if (monotoneUp && significant) direction = 'upward';
  else if (monotoneDown && significant) direction = 'downward';
  else if (!monotoneUp && !monotoneDown) direction = 'non-monotonic';
  else direction = 'invariant';

  const strength = clamp(Math.abs(delta) / 1.5, 0, 1);
  const consistency = direction === 'upward' || direction === 'downward'
    ? diffs.filter(d => direction === 'upward' ? d >= 0 : d <= 0).length / diffs.length : 0;
  const confidence = significant ? clamp((relevant.length - 2) / 4, 0.25, 0.8) * consistency * (oneSided ? 0.5 : 1) : 0;
  return { direction, strength, confidence, decisionWeight: significant ? 1 : 0, significant, logOddsDelta: delta };
}

export type PerformanceDecision = {
  mover?: 'white' | 'black';
  side?: 'white' | 'black';
  profileProbabilities?: MaiaRatingSample[];
  samples?: MaiaRatingSample[];
  lossPoints?: number | null;
  decisionLoss?: number | null;
  forced?: boolean;
  book?: boolean;
  obvious?: boolean;
  status?: string;
  maiaStatus?: string;
  informative?: boolean;
  decisionWeight?: number;
  significanceScore?: number;
  difficultyScore?: number;
  bestVsSecondGap?: number | null;
  goodMoveCount?: number;
  candidateCount?: number;
  legalMoveCount?: number;
  stableWin?: boolean;
  winChanceLoss?: number | null;
  drawChanceLoss?: number | null;
  lossChanceIncrease?: number | null;
};
/** Relative fit to tested Maia levels, without a rating prior or a fabricated confidence interval. */
export function compareMaiaLevels(results: PerformanceDecision[], side: 'white' | 'black', anchor: number) {
  const counts = { upward: 0, downward: 0, invariant: 0, style: 0 };
  const evidence: { samples: MaiaRatingSample[]; weight: number }[] = [];
  for (const row of results) {
    if ((row.mover ?? row.side) !== side || row.status !== 'complete' || row.maiaStatus !== 'complete' ||
        row.obvious || row.forced || row.book || row.stableWin) continue;
    const samples = (row.profileProbabilities ?? row.samples ?? [])
      .filter(s => Number.isFinite(s.rating) && Number.isFinite(s.probability))
      .map(s => ({ ...s, probability: clamp(s.probability, 0, 1) }));
    const signal = classifyRatingSignal(samples, anchor);
    const loss = row.lossPoints ?? row.decisionLoss;
    if (loss === null || loss === undefined || !Number.isFinite(loss)) continue;
    const aligned = signal.direction === 'upward' && loss < 2 || signal.direction === 'downward' && loss >= 5;
    if (aligned) {
      counts[signal.direction === 'upward' ? 'upward' : 'downward']++;
    } else if (signal.direction === 'invariant') counts.invariant++;
    else if (signal.direction !== 'insufficient') counts.style++;
    // Fit all usable choices, including mistakes and style patterns. Selecting only
    // quality-aligned monotone signals would systematically favor the grid edges.
    const weight = clamp(row.decisionWeight ?? 0, 0, 1) * clamp(row.significanceScore ?? 0, 0, 1);
    if (signal.direction !== 'insufficient' && Number.isFinite(weight) && weight > 0)
      evidence.push({ samples, weight });
  }
  const levels = evidence.length ? evidence[0].samples.map(s => s.rating)
    .filter((rating, index, all) => all.indexOf(rating) === index && evidence.every(e => e.samples.some(s => s.rating === rating)))
    .sort((a, b) => a - b) : [];
  const totalWeight = evidence.reduce((sum, e) => sum + e.weight, 0);
  const logFits = levels.map(rating => ({ rating, value: evidence.reduce((sum, e) => {
    const p = e.samples.find(s => s.rating === rating)!.probability;
    return sum + e.weight * Math.log(Math.max(0.0001, p));
  }, 0) / Math.max(0.0001, totalWeight) }));
  const best = [...logFits].sort((a, b) => b.value - a.value)[0];
  const spread = best ? best.value - Math.min(...logFits.map(s => s.value)) : 0;
  const enough = evidence.length >= 8 && counts.upward + counts.downward >= 3 && totalWeight >= 1 && levels.length >= 3 && spread >= 0.15;
  return {
    rating: enough ? best.rating : null,
    levels: logFits.map(point => ({ rating: point.rating, fit: Math.exp(point.value - best!.value) })),
    count: evidence.length, signalCounts: counts,
    atBoundary: enough && (best.rating === levels[0] || best.rating === levels.at(-1)),
    reason: enough ? 'Closest tested Maia choice profile across assessed decisions, including mistakes and style patterns. This is not a calibrated Elo estimate.'
      : 'Too few profiled decisions, quality-supported signals or too little separation between tested levels for a strength estimate.',
  };
}
