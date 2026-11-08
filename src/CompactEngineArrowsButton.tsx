import { useEffect, useRef } from 'react';

type Props = {
  stockfish: boolean;
  maia: boolean;
  combined: boolean;
  disabled: boolean;
  onCycle: () => void;
  onSwitchMode: () => void;
};

export function CompactEngineArrowsButton({ stockfish, maia, combined, disabled, onCycle, onSwitchMode }: Props) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const held = useRef(false);

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancelPress, [disabled]);

  const active = stockfish || maia;
  const state = stockfish && maia ? 'Stockfish and Maia' : stockfish ? 'Stockfish' : maia ? 'Maia' : 'off';
  const label = `Engine arrows: ${state} (${combined ? 'two states' : 'three states'})`;

  return (
    <button
      type="button"
      className={`icon-toggle-btn arrow-options-dot compact-engine-arrows ${active && !disabled ? 'active' : ''}`}
      aria-label={label}
      aria-keyshortcuts="Shift+F10"
      title={`${label}. Hold to switch modes.`}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        cancelPress();
        held.current = false;
        const button = event.currentTarget;
        const timer = window.setTimeout(() => {
          press.current = null;
          if (button.disabled || !button.getClientRects().length) return;
          held.current = true;
          onSwitchMode();
        }, 500);
        press.current = { timer, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.shiftKey && event.key === 'F10' && !event.repeat) {
          event.preventDefault();
          onSwitchMode();
        }
      }}
      onClick={(event) => {
        const skip = held.current && event.detail > 0;
        held.current = false;
        if (!skip) onCycle();
      }}
    >
      {stockfish && <span className="compact-arrow stockfish" aria-hidden="true">➚</span>}
      {maia && <span className="compact-arrow maia" aria-hidden="true">➚</span>}
      {!active && <span className="compact-arrow" aria-hidden="true">➚</span>}
    </button>
  );
}
