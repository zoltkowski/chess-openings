import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnalysisContextEditor, type AnalysisContext } from './AnalysisContextEditor';
import './AnalysisButton.css';

type Props = {
  onQuick: () => void;
  onDeep: () => void;
  benchmark: number;
  onBenchmarkChange: (value: number) => void;
  context?: AnalysisContext;
  onContextChange?: (value: AnalysisContext) => void;
  running: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
};

export function AnalysisButton({ onQuick, onDeep, benchmark, onBenchmarkChange, context, onContextChange, running, disabled, className, children }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const longPressRef = useRef(false);
  const suppressClickRef = useRef(false);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const cancelPress = () => {
    if (pressRef.current) suppressClickRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pressRef.current = null;
  };
  const finishPress = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pressRef.current = null;
  };
  const startPress = (event: PointerEvent<HTMLButtonElement>) => {
    if (running || disabled || event.button !== 0) return;
    longPressRef.current = false;
    suppressClickRef.current = false;
    pressRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    timerRef.current = setTimeout(() => {
      if (!pressRef.current) return;
      longPressRef.current = true;
      pressRef.current = null;
      setOpen(true);
    }, 500);
  };
  const movePress = (event: PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (press && press.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      longPressRef.current = false;
      suppressClickRef.current = false;
    }
    if (event.shiftKey && event.key === 'F10') {
      event.preventDefault();
      if (!running && !disabled) { longPressRef.current = false; suppressClickRef.current = false; setOpen(true); }
    }
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.analysis-button-dialog');
      const items = dialog ? [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled')) : [];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const choose = (action: () => void) => { longPressRef.current = false; suppressClickRef.current = false; setOpen(false); action(); requestAnimationFrame(() => triggerRef.current?.focus()); };
  const triggerClassName = ['analysis-button-trigger', className].filter(Boolean).join(' ');
  const isDark = triggerRef.current?.closest('.app')?.classList.contains('theme-dark') ?? false;
  return <>
    <button ref={triggerRef} type="button" className={triggerClassName} title={running ? 'Stop analysis' : 'Quick analysis; hold for options'} aria-label={running ? 'Stop analysis' : 'Quick analysis; hold for options'} aria-haspopup="dialog" disabled={disabled} onPointerDown={startPress} onPointerMove={movePress} onPointerUp={finishPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress} onContextMenu={(event) => { event.preventDefault(); if (!running && !disabled) { longPressRef.current = true; suppressClickRef.current = true; setOpen(true); } }} onKeyDown={handleKeyDown} onClick={(event) => { if (longPressRef.current || suppressClickRef.current) { longPressRef.current = false; suppressClickRef.current = false; event.preventDefault(); return; } onQuick(); }}>{children}</button>
    {open && createPortal(<div className={`modal-backdrop analysis-button-backdrop${isDark ? ' analysis-button-dark' : ''}`} onClick={close}>
      <section className="modal-card analysis-button-dialog" role="dialog" aria-modal="true" aria-labelledby="analysis-button-title" onClick={(event) => event.stopPropagation()}>
        <header className="analysis-button-header"><h2 id="analysis-button-title">Analyze game</h2><button ref={closeRef} type="button" className="analysis-button-close" aria-label="Close" onClick={close}>×</button></header>
        <div className="analysis-button-benchmark"><label htmlFor="analysis-benchmark">Maia benchmark <output>{benchmark}</output></label><input id="analysis-benchmark" type="range" min="1100" max="3000" step="100" value={benchmark} onChange={(event) => onBenchmarkChange(Number(event.currentTarget.value))} /><p>Reference strength used to compare human choices; not estimated Elo</p></div>
        {context && onContextChange && <AnalysisContextEditor value={context} onChange={onContextChange} />}
        <div className="analysis-button-actions"><button type="button" onClick={() => choose(onQuick)}>Quick<span>Faster review of key decisions</span></button><button type="button" onClick={() => choose(onDeep)}>More detail<span>Deeper review with Maia comparisons</span></button></div>
      </section>
    </div>, document.body)}
  </>;
}
