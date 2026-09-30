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
const ratingLevels = Array.from({ length: 13 }, (_, index) => 1200 + index * 100);

export function AnalysisContextEditor({ value, onChange }: Props) {
  const setRating = (side: 'whiteRating' | 'blackRating') => (event: ChangeEvent<HTMLSelectElement>) => {
    const raw = event.target.value;
    const rating = raw === '' ? undefined : Number(raw);
    onChange({ ...value, [side]: rating !== undefined && Number.isFinite(rating) && rating > 0 && rating <= 4000 ? rating : undefined });
  };
  const ratingOptions = (rating?: number) => <>
    <option value="">Unknown</option>
    {rating !== undefined && !ratingLevels.includes(rating) && <option value={rating}>{rating}</option>}
    {ratingLevels.map(level => <option key={level} value={level}>{level}</option>)}
  </>;

  return <fieldset className="analysis-context-editor">
    <legend>Game context <span>optional</span></legend>
    <div className="ace-ratings">
      <label>White rating<select value={value.whiteRating ?? ''} onChange={setRating('whiteRating')}>{ratingOptions(value.whiteRating)}</select></label>
      <label>Black rating<select value={value.blackRating ?? ''} onChange={setRating('blackRating')}>{ratingOptions(value.blackRating)}</select></label>
    </div>
  </fieldset>;
}

export default AnalysisContextEditor;
