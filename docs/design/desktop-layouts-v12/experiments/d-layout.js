/* EXPERIMENT D. Evaluate after d.css. Only read geometry and set CSS variables.
 * Returns a cleanup function on window.__desktopExperimentDCleanup.
 * --d-files-available is a measurement, not a claim of sufficient usable space.
 */
(() => {
  window.__desktopExperimentDCleanup?.();
  const root = document.documentElement;
  const media = window.matchMedia('(min-width: 1001px)');
  const properties = ['--d-scope-top', '--d-files-top', '--d-footer-height', '--d-files-available'];
  let frame = 0;
  let observed = [];
  const set = (name, value) => {
    const next = `${Math.round(value)}px`;
    if (root.style.getPropertyValue(name) !== next) root.style.setProperty(name, next);
  };
  const update = () => {
    frame = 0;
    if (!media.matches) {
      properties.forEach((name) => root.style.removeProperty(name));
      return;
    }
    const header = document.querySelector('.workspace-desktop-header');
    const switcher = header?.querySelector('.workspace-header-switcher');
    const nav = header?.querySelector('.workspace-header-navigation');
    const account = header?.querySelector('.workspace-header-account');
    const scope = document.querySelector('.bundle-scope-header');
    const nodes = [header, switcher, nav, account, scope].filter(Boolean);
    if (nodes.some((node, index) => node !== observed[index]) || nodes.length !== observed.length) {
      sizes.disconnect();
      nodes.forEach((node) => sizes.observe(node));
      observed = nodes;
    }
    const top = (switcher?.getBoundingClientRect().bottom ?? header?.querySelector('.workspace-brand')?.getBoundingClientRect().bottom ?? 104) + 10;
    set('--d-scope-top', top);
    const footerTop = Math.min(nav?.getBoundingClientRect().top ?? innerHeight, account?.getBoundingClientRect().top ?? innerHeight);
    const footerHeight = innerHeight - footerTop + 8;
    const filesTop = (scope?.getBoundingClientRect().bottom ?? top) + 8;
    set('--d-footer-height', footerHeight);
    set('--d-files-top', filesTop);
    set('--d-files-available', Math.max(0, innerHeight - footerHeight - filesTop));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const sizes = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  media.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
  window.__desktopExperimentDCleanup = () => {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
    media.removeEventListener('change', schedule);
    properties.forEach((name) => root.style.removeProperty(name));
    delete window.__desktopExperimentDCleanup;
  };
})();
