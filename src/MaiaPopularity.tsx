import { popularityLevels, type MaiaPopularityProfile } from './useMaiaPopularity';
import './MaiaPopularity.css';

export function MaiaPopularityChart({ uci, elo, profile }: { uci: string; elo: number; profile: MaiaPopularityProfile | null }) {
  if (!profile?.samples.length) return <span className="maia-popularity-pending">Obliczanie wykresu…</span>;
  const levels = popularityLevels(elo);
  const min = levels[0], max = levels[levels.length - 1];
  const x = (level: number) => 24 + ((level - min) / Math.max(1, max - min)) * 146;
  const y = (probability: number) => 46 - probability * 38;
  const points = profile.samples.map(sample => ({
    elo: sample.elo,
    probability: sample.moves.find(move => move.uci === uci)?.probability ?? 0,
  }));
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.elo)},${y(point.probability)}`).join(' ');
  const description = points.map(point => `${point.elo} Elo: ${(point.probability * 100).toFixed(1)}%`).join(', ');
  return <svg className="maia-popularity-chart" viewBox="0 0 180 70" role="img" aria-label={`Popularność ${uci}: ${description}. Wybrane Elo: ${elo}.`}>
    <title>{description}. Elo gracza i przeciwnika zmieniają się razem.</title>
    <text x="2" y="11" className="maia-chart-label">100%</text>
    <text x="9" y="48" className="maia-chart-label">0%</text>
    <path d="M24 8H170M24 46H170" className="maia-chart-grid" />
    <path d={`M${x(elo)} 8V46`} className="maia-chart-selected" />
    <path d={path} className="maia-chart-line" />
    {points.map(point => <circle key={point.elo} cx={x(point.elo)} cy={y(point.probability)} r={point.elo === elo ? 3.2 : 2} className={point.elo === elo ? 'maia-chart-dot selected' : 'maia-chart-dot'}>
      <title>{point.elo} Elo: {(point.probability * 100).toFixed(1)}%</title>
    </circle>)}
    {levels.map(level => <text key={level} x={x(level)} y="62" textAnchor="middle" className={level === elo ? 'maia-chart-label selected' : 'maia-chart-label'}>{level}</text>)}
  </svg>;
}

export function MaiaPopularityControls({ checked, onChange, profile }: { checked: boolean; onChange: (checked: boolean) => void; profile: MaiaPopularityProfile | null }) {
  return <div className="maia-popularity-controls">
    <label><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />Popularność wg Elo</label>
    {checked && <span className="maia-popularity-note">±400 Elo · co 200 · oba gracze</span>}
    {checked && profile?.pending && <span className="maia-popularity-note" role="status">Obliczanie pozostałych punktów…</span>}
    {checked && profile?.error && <span className="maia-load-error" role="alert">Wykres niedostępny: {profile.error}</span>}
  </div>;
}
