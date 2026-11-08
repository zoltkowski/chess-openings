import { useEffect, useRef, type ComponentProps } from 'react';

export function isTouchContextMenu(event: MouseEvent) {
  return 'pointerType' in event && event.pointerType === 'touch';
}

export function useLongPressAction(action: () => void, click: () => void, delay = 500, enabled = true): ComponentProps<'button'> {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const runAction = () => {
    clearPress();
    if (!enabled) return;
    suppressClick.current = true;
    action();
  };
  useEffect(() => clearPress, [enabled]);

  return {
    'aria-keyshortcuts': 'Shift+F10',
    onPointerDown: (event) => {
      if (!enabled || !event.isPrimary || event.button !== 0) return;
      clearPress();
      suppressClick.current = false;
      const button = event.currentTarget;
      press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
        if (button.isConnected && button.getClientRects().length) runAction();
      }, delay) };
    },
    onPointerMove: (event) => {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
        clearPress();
        suppressClick.current = true;
      }
    },
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onPointerLeave: clearPress,
    onContextMenu: (event) => {
      event.preventDefault();
      // Touch can emit a native context menu during the same hold. Let the timer handle it once.
      if (!isTouchContextMenu(event.nativeEvent)) runAction();
    },
    onKeyDown: (event) => {
      if (event.shiftKey && event.key === 'F10') {
        event.preventDefault();
        if (!event.repeat) runAction();
      }
    },
    onClick: (event) => {
      const skip = suppressClick.current && event.detail > 0;
      suppressClick.current = false;
      if (enabled && !skip) click();
    },
  };
}

export function useLongPressMenu(open: () => void, click: () => void, delay?: number): ComponentProps<'button'> {
  return { ...useLongPressAction(open, click, delay), 'aria-haspopup': 'dialog' };
}
