import type { MaiaRatingSample } from './performanceModel';

export type HumanAlternative = { uci: string; probability: number; lossPoints: number | null; pv?: string };
export type HumanReviewDetails = {
  beforeFen?: string;
  playedMoveUci?: string;
  maiaEligible?: boolean;
  humanAlternatives?: HumanAlternative[];
  bestMoveMaiaProbability?: number;
  profileProbabilities?: MaiaRatingSample[];
  ratingSignal?: 'above' | 'below' | 'neutral' | 'style';
  opportunitySourceNodeId?: string;
  opportunityAvailable?: number;
  opportunityTaken?: boolean;
  opportunityMissed?: boolean;
};

type OpportunityMove = HumanReviewDetails & {
  nodeId: string; mover: 'white' | 'black'; status: string; lossPoints: number | null;
  bestPv?: string; opponentMissedPunishment?: boolean;
};

/** Link consecutive decisions; do not add the same swing twice to impact totals. */
export function linkOpportunities<T extends OpportunityMove>(moves: T[]) {
  // Recompute links when a report is partial, reanalysed or has lost a neighbor.
  for (const move of moves) {
    delete move.opportunitySourceNodeId;
    delete move.opportunityAvailable;
    delete move.opportunityTaken;
    delete move.opportunityMissed;
    delete move.opponentMissedPunishment;
  }
  for (let i = 1; i < moves.length; i++) {
    const source = moves[i - 1], reply = moves[i];
    if (source.status !== 'complete' || reply.status !== 'complete' || source.mover === reply.mover ||
        source.lossPoints === null || !Number.isFinite(source.lossPoints) || source.lossPoints < 5 ||
        reply.lossPoints === null || !Number.isFinite(reply.lossPoints)) continue;
    reply.opportunitySourceNodeId = source.nodeId;
    reply.opportunityAvailable = source.lossPoints;
    reply.opportunityTaken = reply.lossPoints < 2;
    reply.opportunityMissed = reply.lossPoints >= Math.max(5, source.lossPoints * 0.5);
    source.opponentMissedPunishment = reply.opportunityMissed;
  }
}
