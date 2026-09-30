import type { GameAnalysisMoveResult } from '../App';

type Props = { result: GameAnalysisMoveResult; formatMove: (uci: string) => string };

export function HumanMoveDetails({ result, formatMove }: Props) {
  return <>
    {result.goodMassLower !== undefined && result.goodMassUpper !== undefined && <span>
      Sound choices at {result.maiaElo} Elo: Maia estimate {(result.goodMassLower * 100).toFixed(0)}–{(result.goodMassUpper * 100).toFixed(0)}%.
      {result.goodMassUpper <= 0.15 ? ' Difficult decision even allowing for unassessed alternatives.' : result.goodMassLower >= 0.7 ? ' Many accessible good choices.' : ''}
    </span>}
    {result.ratingSignal === 'above' && <span>An accurate choice that becomes more likely at higher Maia levels: a decision above the reference profile.</span>}
    {result.ratingSignal === 'below' && <span>An objective miss that Maia favors more at lower levels. Compare the stronger continuation.</span>}
    {result.ratingSignal === 'style' && <span>Maia’s preferences vary with Elo here, but the pattern and Stockfish quality do not establish a clear strength signal.</span>}
    {result.opportunitySourceNodeId && <span>
      The preceding opponent move offered an opportunity.
      {result.opportunityTaken ? ' You preserved the benefit with an accurate reply.' : result.opportunityMissed ? ' This reply gave back a substantial part of that benefit.' : ' Some of the benefit remained; the reply was not a full exploitation.'}
    </span>}
    {result.practicalGoodMassLower !== undefined && result.practicalGoodMassUpper !== undefined && <span>
      Sound replies for the opponent: Maia estimate {(result.practicalGoodMassLower * 100).toFixed(0)}–{(result.practicalGoodMassUpper * 100).toFixed(0)}%.
      {result.opponentMissedPunishment === true ? ' The opponent did not fully exploit the opportunity.' : result.opponentMissedPunishment === false ? ' The opponent retained most of the benefit.' : ''}
    </span>}
    {!!result.profileProbabilities?.length && <details className="human-move-details">
      <summary>Compare Elo and human alternatives</summary>
      <div className="human-rating-grid">
        {result.profileProbabilities.map(sample => <span key={sample.rating} className={sample.rating === result.maiaElo ? 'selected' : ''}>
          <b>{sample.rating} Elo</b>{(sample.probability * 100).toFixed(1)}%
        </span>)}
      </div>
      <span>Maia’s estimate for the played move; opponent level stays fixed.</span>
      <div className="human-alternatives">
        {result.humanAlternatives?.map(move => <span key={move.uci}>
          <b>{formatMove(move.uci)}</b> {(move.probability * 100).toFixed(1)}% · {move.lossPoints === null ? 'not verified' : move.lossPoints < 2 ? 'sound · SF19' : `${move.lossPoints.toFixed(1)} impact · SF19`}
        </span>)}
      </div>
    </details>}
  </>;
}
