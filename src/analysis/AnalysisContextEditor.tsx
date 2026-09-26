import type { ChangeEvent } from 'react';
import './AnalysisContextEditor.css';

export type AnalysisContext = {
  whiteRating?: number;
  blackRating?: number;
  ratingSystem?: 'lichess' | 'chesscom' | 'fide' | 'other';
  ratingPool?: 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
  timeControl?: string;
};

type Props = { value: AnalysisContext; onChange: (value: AnalysisContext) => void };

export function AnalysisContextEditor({ value, onChange }: Props) {
  const setRating = (side: 'whiteRating' | 'blackRating') => (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    const rating = raw === '' ? undefined : Number(raw);
    onChange({ ...value, [side]: rating !== undefined && Number.isFinite(rating) && rating > 0 && rating <= 4000 ? rating : undefined });
  };
  const setField = (field: 'ratingSystem' | 'ratingPool' | 'timeControl', next: string) =>
    onChange({ ...value, [field]: next || undefined });

  return <fieldset className="analysis-context-editor">
    <legend>Game context <span>optional</span></legend>
    <div className="ace-ratings">
      <label>White rating<input type="number" min="0" max="4000" inputMode="numeric" value={value.whiteRating ?? ''} onChange={setRating('whiteRating')} placeholder="Unknown" /></label>
      <label>Black rating<input type="number" min="0" max="4000" inputMode="numeric" value={value.blackRating ?? ''} onChange={setRating('blackRating')} placeholder="Unknown" /></label>
    </div>
    <div className="ace-meta">
      <label>Rating source<select value={value.ratingSystem ?? ''} onChange={e => setField('ratingSystem', e.target.value)}>
        <option value="">Unknown</option><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option><option value="fide">FIDE</option><option value="other">Other</option>
      </select></label>
      <label>Time control pool<select value={value.ratingPool ?? ''} onChange={e => setField('ratingPool', e.target.value)}>
        <option value="">Unknown</option><option value="bullet">Bullet</option><option value="blitz">Blitz</option><option value="rapid">Rapid</option><option value="classical">Classical</option><option value="unknown">Unclassified</option>
      </select></label>
      <label className="ace-time-control">Time control<input type="text" value={value.timeControl ?? ''} onChange={e => setField('timeControl', e.target.value)} placeholder="e.g. 10+5" /></label>
    </div>
  </fieldset>;
}

export default AnalysisContextEditor;
