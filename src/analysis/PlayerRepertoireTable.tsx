import { LichessStatsBar } from './LichessStatsBar';

export type PlayerMoveRow = {
  uci: string;
  san: string;
  note?: string;
  score?: string;
  provisional?: boolean;
  kind?: 'repertoire' | 'mistake';
  frequency?: string;
  detail?: string;
  results?: { wins: number; draws: number; losses: number };
};

export function PlayerRepertoireTable({ rows, complete, side, positionGames, onMove }: {
  rows: PlayerMoveRow[];
  complete: boolean;
  side: 'white' | 'black';
  positionGames?: number;
  onMove: (uci: string) => void;
}) {
  return (
    <div className="player-repertoire-table" aria-label="Player moves">
      {rows.map(row => {
        const { wins, draws, losses } = row.results ?? { wins: 0, draws: 0, losses: 0 };
        const total = wins + draws + losses;
        const percentage = (count: number, games: number) => `${Math.round(count / games * 100)}%`;
        const frequency = row.frequency ?? (total && positionGames
          ? `${total.toLocaleString()} (${percentage(total, positionGames)})`
          : total.toLocaleString());
        return (
          <button type="button" className="player-repertoire-row lichess-clickable-row" data-kind={row.kind} key={row.uci} onClick={() => onMove(row.uci)}>
            <span className="player-repertoire-move">
              <strong>{row.san}</strong>
              {row.score && <span title={row.provisional ? 'Provisional Stockfish evaluation' : undefined}>
                {row.provisional && '≈'}{row.score}
              </span>}
              {row.note && <small>{row.note}</small>}
            </span>
            <span>{total || complete ? frequency : '—'}</span>
            {total ? <LichessStatsBar white={side === 'white' ? wins : losses} draws={draws}
              black={side === 'black' ? wins : losses}
              label={`Win ${percentage(wins, total)}, draw ${percentage(draws, total)}, loss ${percentage(losses, total)}`} /> : <span>—</span>}
            {row.detail && <small className="player-repertoire-row-detail">{row.detail}</small>}
          </button>
        );
      })}
    </div>
  );
}
