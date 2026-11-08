import { useLongPressAction } from './useLongPressMenu';

type Props = {
  stockfish: boolean;
  maia: boolean;
  combined: boolean;
  disabled: boolean;
  onCycle: () => void;
  onSwitchMode: () => void;
};

export function CompactEngineArrowsButton({ stockfish, maia, combined, disabled, onCycle, onSwitchMode }: Props) {
  const gestures = useLongPressAction(onSwitchMode, onCycle, 500, !disabled);

  const active = stockfish || maia;
  const state = stockfish && maia ? 'Stockfish and Maia' : stockfish ? 'Stockfish' : maia ? 'Maia' : 'off';
  const label = `Engine arrows: ${state} (${combined ? 'two states' : 'three states'})`;

  return (
    <button
      type="button"
      className={`icon-toggle-btn arrow-options-dot compact-engine-arrows ${active && !disabled ? 'active' : ''}`}
      aria-label={label}
      title={`${label}. Hold to switch modes.`}
      disabled={disabled}
      {...gestures}
    >
      {stockfish && <span className="compact-arrow stockfish" aria-hidden="true">➚</span>}
      {maia && <span className="compact-arrow maia" aria-hidden="true">➚</span>}
      {!active && <span className="compact-arrow" aria-hidden="true">➚</span>}
    </button>
  );
}
