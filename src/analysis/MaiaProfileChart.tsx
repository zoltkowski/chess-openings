type Props = { levels: { rating: number; fit: number }[]; anchor: number };

export function MaiaProfileChart({ levels, anchor }: Props) {
  if (levels.length < 3) return null;
  const min = levels[0].rating, max = levels.at(-1)!.rating;
  const x = (rating: number) => 25 + 280 * (rating - min) / Math.max(1, max - min);
  const y = (fit: number) => 55 - fit * 43;
  return <svg className="gr-profile-chart" viewBox="0 0 330 83" role="img" aria-label={`Relative Maia profile fit: ${levels.map(l => `${l.rating}: ${l.fit.toFixed(2)}`).join(', ')}. Reference level ${anchor}.`}>
    <title>Relative fit among tested Maia levels; not a rating probability or confidence interval.</title>
    <path d="M25 55H305" className="gr-zero-axis" />
    {anchor >= min && anchor <= max && <path d={`M${x(anchor)} 10V55`} className="gr-zero-axis" />}
    <polyline points={levels.map(l => `${x(l.rating)},${y(l.fit)}`).join(' ')} className="gr-advantage-line" />
    {levels.map(l => <g key={l.rating}>
      <circle cx={x(l.rating)} cy={y(l.fit)} r={l.fit === 1 ? 4 : 2.5} className="gr-profile-point"><title>{l.rating} · relative fit {l.fit.toFixed(2)}</title></circle>
      <text x={x(l.rating)} y="73" textAnchor="middle" className="gr-axis-label">{l.rating}</text>
    </g>)}
  </svg>;
}
