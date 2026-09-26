/** Experimental, uncalibrated performance signal from Maia rating profiles. */

export type MaiaRatingSample = { rating: number; probability: number };
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
    (!oneSided && (!below || !above))) return {
    direction: 'insufficient', strength: 0, confidence: 0, decisionWeight: 0, significant: false, logOddsDelta: 0,
  };
  const relevant = distinctPoints;
  const delta = logit(relevant.at(-1)!.p) - logit(relevant[0].p);
  const probDelta = relevant.at(-1)!.p - relevant[0].p;
  const logits = relevant.map(p => logit(p.p));
  const diffs = logits.slice(1).map((v, i) => v - logits[i]);
  const monotoneUp = diffs.every(d => d >= -0.12);
  const monotoneDown = diffs.every(d => d <= 0.12);
  const isInvariant = Math.abs(points.at(-1)!.p - points[0].p) < 0.10 && Math.abs(delta) < 0.35;
  const significant = Math.abs(delta) >= 0.35 && Math.abs(probDelta) >= 0.10;
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
  winChanceLoss?: number | null;
  drawChanceLoss?: number | null;
  lossChanceIncrease?: number | null;
};
export type PerformanceEstimate = {
  side: 'white' | 'black';
  anchor: number;
  rating: number | null;
  interval: [number, number] | null;
  confidence: number;
  informativeDecisions: number;
  signals: RatingSignal[];
  experimental: true;
  reason?: string;
};

/** Aggregate decision evidence around a known player Elo or explicit benchmark. */
export function analyzePerformance(results: PerformanceDecision[], side: 'white' | 'black', anchor: number): PerformanceEstimate {
  const eligible = results.filter(r => (r.mover ?? r.side) === side && r.informative !== false &&
    r.status === 'complete' && r.maiaStatus === 'complete' && !r.forced && !r.book && !r.obvious &&
    Number.isFinite(r.decisionWeight) && Number.isFinite(r.significanceScore));
  const signals: RatingSignal[] = [];
  for (const row of eligible) {
    const samples = row.profileProbabilities ?? row.samples ?? [];
    const signal = classifyRatingSignal(samples, anchor);
    const loss = row.lossPoints ?? row.decisionLoss;
    // Missing quality is not evidence. Downward evidence also requires an actual objective miss.
    if (loss === null || loss === undefined || !Number.isFinite(loss) ||
      (signal.direction === 'upward' && loss >= 5)) {
      signals.push({ ...signal, direction: 'invariant', decisionWeight: 0, significant: false });
    } else {
      const decisionWeight = clamp(row.decisionWeight!, 0, 1);
      const significance = clamp(row.significanceScore!, 0, 1);
      signals.push({ ...signal, decisionWeight: signal.decisionWeight * decisionWeight * significance });
    }
  }
  const usable = signals.filter(s => s.significant && s.decisionWeight > 0 &&
    (s.direction === 'upward' || s.direction === 'downward'));
  const evidenceMass = usable.reduce((sum, s) => sum + s.decisionWeight * s.confidence, 0);
  if (usable.length < 3 || evidenceMass <= 0) return {
    side, anchor, rating: null, interval: null, confidence: 0, informativeDecisions: usable.length,
    signals, experimental: true, reason: 'Insufficient weighted evidence: at least three informative decisions with meaningful combined weight are required; this heuristic is not calibrated.',
  };

  const net = usable.reduce((sum, s) => sum + (s.direction === 'upward' ? 1 : -1) * s.strength * s.decisionWeight * s.confidence, 0) /
    usable.reduce((sum, s) => sum + s.decisionWeight * s.confidence, 0);
  // Saturate the heuristic adjustment and keep it bounded to ±500 points.
  const shift = 500 * Math.tanh(net / 0.55);
  const rating = Math.round((anchor + shift) / 50) * 50;
  const meanConfidence = usable.reduce((sum, s) => sum + s.confidence, 0) / usable.length;
  const meanWeight = evidenceMass / usable.reduce((sum, s) => sum + s.confidence, 0);
  const confidence = clamp(meanConfidence * Math.min(1, evidenceMass / 5) * meanWeight, 0.05, 0.75);
  // Deliberately broad, especially at the minimum sample count; not a calibrated CI.
  const weightPenalty = 1 / Math.sqrt(Math.max(0.15, meanWeight));
  const halfWidth = Math.round(clamp(500 * (1 - confidence) * weightPenalty / Math.sqrt(Math.min(usable.length, 8) / 3), 180, 500));
  return { side, anchor, rating, interval: [rating - halfWidth, rating + halfWidth], confidence,
    informativeDecisions: usable.length, signals, experimental: true,
    reason: 'Experimental Maia heuristic; interval is a broad uncertainty range, not a calibrated confidence interval.' };
}
