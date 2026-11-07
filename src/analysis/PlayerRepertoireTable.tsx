export type PlayerMoveRow = {
  uci: string;
  san: string;
  note?: string;
  score?: string;
  provisional?: boolean;
  results?: { wins: number; draws: number; losses: number };
};

export function PlayerRepertoireTable({ rows, complete, onMove }: {
  rows: PlayerMoveRow[];
  complete: boolean;
  onMove: (uci: string) => void;
}) {
  return (
    <div className="player-repertoire-table" aria-label="Player moves">
      <div className="player-repertoire-row player-repertoire-head">
        <span>Move</span><span>Games</span><span>Win / Draw / Loss</span>
      </div>
      {rows.map(row => {
        const { wins, draws, losses } = row.results ?? { wins: 0, draws: 0, losses: 0 };
        const total = wins + draws + losses;
        const percentage = (count: number) => `${Math.round(count / total * 100)}%`;
        return (
          <button type="button" className="player-repertoire-row" key={row.uci} onClick={() => onMove(row.uci)}>
            <span className="player-repertoire-move">
              <strong>{row.san}</strong>
              {row.score && <span title={row.provisional ? 'Provisional Stockfish evaluation' : undefined}>
                {row.provisional && '≈'}{row.score}
              </span>}
              {row.note && <small>{row.note}</small>}
            </span>
            <span>{total || (complete ? '0' : '—')}</span>
            <span>{total ? `${percentage(wins)} / ${percentage(draws)} / ${percentage(losses)}` : '—'}</span>
          </button>
        );
      })}
    </div>
  );
}
