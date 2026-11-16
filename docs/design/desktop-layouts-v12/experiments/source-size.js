/* C/D geometry experiment only. Recover source height using its actual document
 * top and existing utility-footer height. No DOM nodes, content or focus move. */
(() => {
  window.__desktopExperimentSourceCleanup?.();
  const root = document.documentElement;
  const media = matchMedia('(min-width: 1001px)');
  let frame = 0;
  const update = () => {
    frame = 0;
    const source = document.querySelector('.entry-textarea, .draft-source-textarea, .read-only-content');
    if (!media.matches || !source) {
      root.style.removeProperty('--experiment-source-height');
      return;
    }
    const top = source.getBoundingClientRect().top + scrollY;
    const footer = document.querySelector('.draft-utility-footer')?.getBoundingClientRect().height || 0;
    const next = `${Math.round(Math.max(360, innerHeight - top - footer))}px`;
    if (root.style.getPropertyValue('--experiment-source-height') !== next)
      root.style.setProperty('--experiment-source-height', next);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', schedule);
  media.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
  window.__desktopExperimentSourceCleanup = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    removeEventListener('resize', schedule);
    media.removeEventListener('change', schedule);
    root.style.removeProperty('--experiment-source-height');
    delete window.__desktopExperimentSourceCleanup;
  };
})();
