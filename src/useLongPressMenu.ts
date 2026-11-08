import { useEffect, useRef, type ComponentProps } from 'react';

export function useLongPressMenu(open: () => void, click: () => void): ComponentProps<'button'> {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const openMenu = () => {
    clearPress();
    suppressClick.current = true;
    open();
  };
  useEffect(() => clearPress, []);

  return {
    'aria-haspopup': 'dialog',
    'aria-keyshortcuts': 'Shift+F10',
    onPointerDown: (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      clearPress();
      suppressClick.current = false;
      const button = event.currentTarget;
      press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
        if (button.isConnected && button.getClientRects().length) openMenu();
      }, 500) };
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
      openMenu();
    },
    onKeyDown: (event) => {
      if (event.shiftKey && event.key === 'F10') {
        event.preventDefault();
        if (!event.repeat) openMenu();
      }
    },
    onClick: (event) => {
      const skip = suppressClick.current && event.detail > 0;
      suppressClick.current = false;
      if (!skip) click();
    },
  };
}
