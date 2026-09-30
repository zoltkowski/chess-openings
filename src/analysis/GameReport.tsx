import { useMemo, useState } from 'react';
import { buildReport, type ReportMove } from './reportModel';
import { MaiaProfileChart } from './MaiaProfileChart';
import './GameReport.css';

type Props = {
  results: ReportMove[];
  positions: Record<string, string>;
  onSelect: (nodeId: string) => void;
  mode?: 'quick' | 'deep';
};

const clampScore = (value: number) => Math.tanh(value / 40);

export function GameReport({ results, positions, onSelect, mode }: Props) {
  const report = useMemo(() => buildReport(results, positions), [results, positions]);
  const [requestedNodeId, setSelectedNodeId] = useState('');
  const selectedNodeId = report.points.some(point => point.nodeId === requestedNodeId)
    ? requestedNodeId : report.points[0]?.nodeId ?? '';
  const plotted = report.points.map((point, index) => ({
    ...point,
    x: report.points.length <= 1 ? 50 : 36 + (index / (report.points.length - 1)) * 928,
    y: 110 - clampScore(point.value ?? 0) * 82,
  }));
  const selectedPoint = plotted.find((point) => point.nodeId === selectedNodeId);
  const phases = report.phases.map((phase) => {
    const phasePoints = plotted.filter((point) => point.phase === phase.name);
    return { ...phase, x1: phasePoints[0]?.x ?? 36, x2: phasePoints.at(-1)?.x ?? 36 };
  });
  const segments: typeof plotted[] = [];
  for (const point of plotted) {
    if (point.value === null || (segments.at(-1)?.length && segments.at(-1)!.at(-1)!.source !== point.source)) {
      if (segments.at(-1)?.length) segments.push([]);
      if (point.value === null) continue;
    }
    if (!segments.length) segments.push([]);
    segments.at(-1)!.push(point);
  }

  return (
    <div className="game-report">
      <header className="gr-hero">
        <div>
          <span className="gr-kicker">GAME STORY</span>
          <h2>{report.headline}</h2>
          <p>{mode === 'quick' ? 'The balance of the game, key opportunities and a human perspective from Maia on selected decisions.' : 'Engine evaluations show who stood better. Maia compares choices with human play at different ratings; its profile is experimental, not a calibrated Elo rating.'}</p>
        </div>
      </header>

      <section className="gr-player-grid" aria-label="Player performance">
        {report.players.map((player) => (
          <article className={`gr-player-card ${player.side}`} key={player.side}>
            <div className="gr-player-top"><span>{player.side === 'white' ? 'WHITE' : 'BLACK'}</span><span className="gr-profile-rating">Maia reference · {player.profile.anchor}</span></div>
            <div className="gr-rating-main">{player.qualityScore === null ? '—' : player.qualityScore.toFixed(0)}<small>/100 decision quality · Stockfish index</small></div>
            {mode === 'quick' ? <>
              <div className="gr-rating-main">{player.sound}/{player.count}<small> sound decisions · Stockfish</small></div>
              <p className="gr-profile-reason">Anchor: {player.profile.anchorSource === 'pgn' ? 'raw PGN player rating' : 'chosen benchmark'} ({player.profile.anchor}). Maia model queries use levels 1100–3000{player.profile.anchor < 1100 || player.profile.anchor > 3000 ? `; this anchor is outside that range, so the model uses ${Math.max(1100, Math.min(3000, player.profile.anchor))} and no performance estimate is available` : ''}. {player.maiaCount} selected decisions; this is not an estimated player rating.</p>
            </> : <>
              <div className="gr-model-match">{player.profile.rating === null ? 'Strength profile: not enough evidence' : `Closest Maia level: ${player.profile.rating}${player.profile.atBoundary ? ' · edge of tested range' : ''}`}</div>
              <MaiaProfileChart levels={player.profile.levels} anchor={player.profile.anchor} />
              <p className="gr-profile-reason">{player.profile.reason} {player.profile.count} profiled decisions. Reference: {player.profile.anchor} ({player.profile.anchorSource === 'pgn' ? 'PGN rating' : player.profile.anchorSource === 'manual' ? 'chosen player rating' : 'benchmark'}).</p>
              <p className="gr-profile-reason">{player.profile.signalCounts.upward} accurate choices associated with higher levels · {player.profile.signalCounts.downward} errors associated with lower levels. {player.profile.signalCounts.style} other choice patterns; these alone do not establish strength.</p>
            </>}
            <div className="gr-impact">{player.averageLoss === null ? '—' : player.averageLoss.toFixed(1)}<small> average impact</small></div>
            <div className="gr-stats">
              <span><b>{player.errors}</b> serious errors</span>
              <span><b>{player.missed}</b> missed chances</span>
              <span><b>{player.held}</b> strong defenses</span>
              <span><b>{player.count}</b> moves assessed</span>
              {mode !== 'quick' && <span><b>{player.profileCount}</b> decisions compared across Elo</span>}
              <span><b>{player.sound}/{player.count}</b> sound decisions</span>
              <span><b>{player.maiaCount}/{player.maiaEligible || player.maiaCount}</b> Maia coverage</span>
            </div>
            <div className="gr-opponent-context">
              <b>What the opponent gave you</b>
              <p>{player.opportunities.available} opportunities after opponent errors: {player.opportunities.taken} exploited, {player.opportunities.missed} substantially missed.</p>
              <p>{player.pressure.faced} demanding replies faced; {player.pressure.held} handled accurately. Maia predicts at most 30% sound-response mass for these positions, including unassessed alternatives.</p>
              <p>You offered {player.opportunities.offered} opportunities; the opponent missed {player.opportunities.escaped} of them.</p>
            </div>
            {[...player.strengths, ...player.weaknesses].map(insight => <button type="button" className="gr-insight" key={insight.text} onClick={() => onSelect(insight.nodeId)}>{insight.text} ↗</button>)}
          </article>
        ))}
      </section>

      <section className="gr-section gr-timeline-section">
        <div className="gr-section-heading"><div><span className="gr-kicker">THE SWING OF THE GAME</span><h3>Who had the advantage?</h3></div><div className="gr-legend"><span>White advantage ↑</span><span>Black advantage ↓</span></div></div>
        <div className="gr-chart-scroll">
          <svg className="gr-timeline" viewBox="0 0 1000 240" preserveAspectRatio="none" role="group" aria-label="Advantage over the game. Positive is better for White, negative is better for Black.">
            {phases.map((phase, index) => <rect key={phase.name} x={phase.x1} y="14" width={Math.max(0, phase.x2 - phase.x1)} height="191" className={`gr-phase-band ${index % 2 ? 'alternate' : ''}`} />)}
            <line x1="30" x2="970" y1="110" y2="110" className="gr-zero-axis" />
            <text x="3" y="30" className="gr-axis-label">White</text><text x="10" y="114" className="gr-axis-label">Even</text><text x="3" y="199" className="gr-axis-label">Black</text>
            {segments.filter((s) => s.length > 1).map((segment, index) => <polyline key={index} className="gr-advantage-line" points={segment.map((p) => `${p.x},${p.y}`).join(' ')} />)}
            {plotted.filter(point => point.mateSide).map(point => <text key={`mate-${point.nodeId}`} x={point.x} y={point.mateSide === 'white' ? 25 : 200} textAnchor="middle" className="gr-mate-marker"><title>{point.label}: {point.outcome}</title>M</text>)}
            {plotted.filter((p) => p.value !== null).map((point) => <circle key={point.nodeId} cx={point.x} cy={point.y} r="4" className="gr-point" tabIndex={0} role="button" aria-label={`${point.label}, ${point.value! >= 0 ? 'White' : 'Black'} advantage, ${Math.abs(point.value!).toFixed(1)} percentage points from even. Open position.`} onClick={() => onSelect(point.nodeId)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.nodeId); } }} />)}
            {phases.map((phase) => <text key={phase.name} x={(phase.x1 + phase.x2) / 2} y="225" textAnchor="middle" className="gr-phase-label">{phase.name}</text>)}
          </svg>
        </div>
        <p className="gr-chart-note">White’s edge uses Stockfish WDL where available. Points based on centipawns use a separate comparison index; the chart breaks at those source changes, so their scales are not treated as calibrated equivalents. Click a point to inspect it; missing evaluations create gaps.</p>
        <div className="gr-explorer">
          <label htmlFor="gr-explore-position">Explore position</label>
          <select id="gr-explore-position" value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.target.value)}>
            {plotted.map((point) => <option key={point.nodeId} value={point.nodeId}>{point.label} · {point.value === null ? point.outcome ?? 'evaluation unavailable' : `${point.value > 0 ? '+' : ''}${point.value.toFixed(1)} percentage points from even (White)`}</option>)}
          </select>
          <button type="button" disabled={!selectedPoint} onClick={() => selectedPoint && onSelect(selectedPoint.nodeId)}>Open position</button>
        </div>
      </section>

      <section className="gr-section">
        <div className="gr-section-heading"><div><span className="gr-kicker">BY PHASE</span><h3>How the game changed</h3></div><span className="gr-small-note">Lower average impact means steadier play.</span></div>
        <div className="gr-phase-grid">{report.phases.map((phase) => <article className="gr-phase-card" key={phase.name}>
          <div className="gr-phase-card-top"><h4>{phase.name}</h4><span>{phase.start} – {phase.end}</span></div>
          <p className="gr-phase-advantage">{phase.advantage}</p>
          <p className="gr-small-note">{phase.transition}</p>
          <p className="gr-phase-advantage">Decision quality · White: {phase.decisionQuality === null ? '—' : `${phase.decisionQuality.toFixed(0)}/100`} · Black: {phase.blackDecisionQuality === null ? '—' : `${phase.blackDecisionQuality.toFixed(0)}/100`}</p>
          <p className="gr-small-note">Evidence: {phase.qualityEvidence} meaningful decisions · {phase.confidence} confidence</p>
          <div className="gr-phase-loss"><span>White <b>{phase.whiteLoss === null ? '—' : phase.whiteLoss.toFixed(1)}</b></span><span>Black <b>{phase.blackLoss === null ? '—' : phase.blackLoss.toFixed(1)}</b></span></div>
          <p className="gr-small-note">{phase.activity}</p>
        </article>)}</div>
      </section>

      <section className="gr-section">
        <div className="gr-section-heading"><div><span className="gr-kicker">MOMENTS THAT MATTERED</span><h3>Best finds, saves and turning points</h3></div></div>
        {report.moments.length ? <div className="gr-moment-list">{report.moments.map((moment) => <button className={`gr-moment ${moment.kind}`} key={`${moment.nodeId}-${moment.kind}`} type="button" onClick={() => onSelect(moment.nodeId)}>
          <span className="gr-moment-label">{moment.label}</span><span className="gr-moment-copy"><b>{moment.title}</b><span>{moment.description}</span></span><span className="gr-moment-arrow" aria-hidden="true">↗</span>
        </button>)}</div> : <p className="gr-empty">No standout moments were confirmed by the available engine analysis.</p>}
      </section>
      {(report.opening || report.tablebase) && <section className="gr-section gr-evidence">
        <div className="gr-section-heading"><div><span className="gr-kicker">POSITION EVIDENCE</span><h3>Opening and tablebase context</h3></div></div>
        {report.opening && <p><b>{report.opening.name ?? 'Opening Explorer'}</b> · played move frequency: {report.opening.frequency === undefined ? 'unknown' : `${(report.opening.frequency * 100).toFixed(1)}%`} · sample: {report.opening.playedGames === undefined ? 'unknown' : report.opening.playedGames} / {report.opening.totalGames === undefined ? 'unknown' : report.opening.totalGames} games <button type="button" onClick={() => onSelect(report.opening!.nodeId)}>Open position ↗</button></p>}
        {report.tablebase && <p><b>Tablebase</b> · {report.tablebase.category === 'cursed-win' ? 'the position is a win except for the 50-move rule; practical result is a draw' : report.tablebase.category === 'blessed-loss' ? 'the position is a loss except that the 50-move rule permits a draw' : report.tablebase.category} <button type="button" onClick={() => onSelect(report.tablebase!.nodeId)}>Open position ↗</button></p>}
      </section>}
      <details className="gr-method"><summary>How to read this report</summary>
        <p>Impact uses the difference in Stockfish expected score (WDL, percentage points) when available; otherwise it uses the bounded cp-based comparison index. It is not calibrated against game outcomes. Sound decisions lose fewer than 5 impact points; serious errors lose at least 10. Uncertain and unavailable evaluations are excluded from quality averages. Quick review also skips repertoire moves; detailed review checks them.</p>
        <p>Decision quality is our own 0–100 index: the importance-weighted mean of max(0, 1 − impact/35), excluding obvious and already decided positions. It is not Lichess accuracy or Elo. Phases are estimated from material and development.</p>
        <p>Detailed review compares up to seven Maia levels over ±600 points with the opponent’s rating fixed. The closest level uses weighted move likelihoods on all usable profiles, including mistakes and style patterns, without a rating prior. It requires at least eight profiled decisions, three quality-supported signals and separation between levels. Style alone does not establish strength. This is an experimental model resemblance, not a calibrated Elo estimate; no confidence interval is claimed. Budget limits and missing samples reduce coverage.</p>
        <p>An opportunity is linked to the immediately preceding opponent error. Accurate replies exploit it; losses of at least half the benefit (and five impact points) count as substantially missed. These events are not added a second time to quality loss. Demanding replies require a conservative Maia upper bound of 30% for sound responses.</p>
      </details>
    </div>
  );
}

export default GameReport;
