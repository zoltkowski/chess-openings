export function LichessStatsBar({ white, draws, black, label }: {
  white: number;
  draws: number;
  black: number;
  label?: string;
}) {
  const total = white + draws + black;
  const segments = [
    ['white', white],
    ['draw', draws],
    ['black', black],
  ] as const;
  return (
    <span className="stats-bar" role="img" aria-label={label ?? 'Lichess outcome distribution'} title={label}>
      {segments.map(([kind, count]) => {
        const percentage = total > 0 ? count / total * 100 : 0;
        return (
          <span key={kind} className={`seg seg-${kind}`} style={{ flexGrow: percentage, flexBasis: 0 }}>
            {percentage >= 8 ? `${Math.round(percentage)}%` : ''}
          </span>
        );
      })}
    </span>
  );
}
