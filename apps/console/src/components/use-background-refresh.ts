import { useEffect, useRef } from 'react';

/** Read-only screens update quietly; editing and open overlays always take priority. */
export function useBackgroundRefresh(
  refresh: () => Promise<unknown>,
  {
    enabled,
    interval = 15_000,
    allowButtonFocus = false,
    allowScroll = false,
  }: {
    enabled: boolean;
    interval?: number;
    allowButtonFocus?: boolean;
    allowScroll?: boolean;
  },
) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const running = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function update() {
      if (!active || running.current || document.hidden || (!allowScroll && window.scrollY > 0))
        return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (
        document.activeElement?.closest(
          `input, textarea, select, ${allowButtonFocus ? '' : 'button,'} [contenteditable="true"], [role="combobox"]`,
        )
      )
        return;
      running.current = true;
      try {
        await latest.current();
      } catch {
        // Keep the current screen; the next interval or focus retries the read.
      } finally {
        running.current = false;
      }
    }
    const timer = setInterval(() => void update(), interval);
    const onFocus = () => void update();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [enabled, interval, allowButtonFocus, allowScroll]);
}
