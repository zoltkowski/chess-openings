import { useEffect, useState } from 'react';
import { evaluateMaiaPosition, type MaiaEvaluation } from './maiaEngine';

type Sample = { elo: number; moves: MaiaEvaluation['moves'] };
export type MaiaPopularityProfile = { key: string; samples: Sample[]; pending: boolean; error?: string };

export function popularityLevels(elo: number) {
  return [-400, -200, 0, 200, 400].map(offset => elo + offset).filter(level => level >= 1100 && level <= 3000);
}

export function useMaiaPopularity(fen: string, elo: number, enabled: boolean) {
  const key = `${fen}|${elo}`;
  const [profile, setProfile] = useState<MaiaPopularityProfile | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const samples: Sample[] = [];
      // The selected level shares the interactive engine's cached evaluation.
      for (const level of [elo, ...popularityLevels(elo).filter(level => level !== elo)]) {
        if (cancelled) return;
        try {
          const result = await evaluateMaiaPosition({ fen, eloSelf: level, eloOppo: level, topK: 256 });
          if (cancelled) return;
          samples.push({ elo: level, moves: result.moves });
          setProfile({ key, samples: [...samples].sort((a, b) => a.elo - b.elo), pending: samples.length < popularityLevels(elo).length });
        } catch (error) {
          if (!cancelled) setProfile({ key, samples, pending: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [fen, elo, enabled, key]);
  return profile?.key === key ? profile : null;
}
