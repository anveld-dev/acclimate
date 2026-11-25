(() => {
  'use strict';
  const root = document.documentElement;
  const shortcutLabel = document.querySelector('.search-open kbd');
  if (shortcutLabel && !/Mac|iPhone|iPad/.test(navigator.platform)) shortcutLabel.textContent = 'Ctrl K';
  const themeButton = document.querySelector('.theme-toggle');
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function themeLabel() { themeButton.setAttribute('aria-label', `Switch to ${isDark() ? 'light' : 'dark'} theme`); }
  themeLabel();
  themeButton.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('acclimate-docs-theme', root.dataset.theme); } catch (_) { /* file URLs may deny storage */ }
    themeLabel();
  });
  const sidebar = document.getElementById('docs-sidebar');
  const menu = document.querySelector('.menu-toggle');
  const closeMenu = () => { sidebar.dataset.open = 'false'; menu.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('click', () => { const open = sidebar.dataset.open !== 'true'; sidebar.dataset.open = String(open); menu.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && sidebar.dataset.open === 'true') { closeMenu(); menu.focus(); } });
  const dialog = document.querySelector('.search-dialog');
  const input = document.getElementById('docs-search');
  const list = document.querySelector('.search-results');
  const status = document.querySelector('.search-status');
  const data = JSON.parse(document.getElementById('search-data').textContent);
  const base = document.body.dataset.root || '';
  let previousFocus = null;
  function search() {
    list.replaceChildren();
    const query = input.value.trim().toLowerCase();
    if (!query) { status.textContent = 'Type to search all pages.'; return; }
    const terms = query.split(/\s+/).filter(Boolean);
    const results = data.map(item => {
      const title = item.title.toLowerCase(), section = item.section.toLowerCase(), body = item.text.toLowerCase();
      const haystack = `${title} ${section} ${body}`;
      if (!terms.every(term => haystack.includes(term))) return null;
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 8 : 0) + (section.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { item, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    const shown = results.slice(0, 12);
    status.textContent = results.length ? `${results.length} matching ${results.length === 1 ? 'result' : 'results'}${results.length > 12 ? ' · showing 12' : ''}` : 'No matches. Try a shorter or different term.';
    shown.forEach(({item}) => {
      const li = document.createElement('li'), a = document.createElement('a'), title = document.createElement('strong'), detail = document.createElement('span');
      a.href = base + item.url;
      title.textContent = item.title;
      detail.textContent = item.section === 'Page' ? item.summary : item.section;
      a.append(title, detail); li.append(a); list.append(li);
    });
  }
  function openSearch() {
    previousFocus = document.activeElement;
    dialog.showModal();
    input.focus();
    search();
  }
  document.querySelector('[data-search-open]').addEventListener('click', openSearch);
  document.querySelector('.search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (previousFocus) previousFocus.focus(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } });
  input.addEventListener('input', search);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { const first = list.querySelector('a'); if (first) { event.preventDefault(); first.focus(); } }
    if (event.key === 'Enter') { const first = list.querySelector('a'); if (first) first.click(); }
  });
  document.addEventListener('keydown', event => {
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !editing)) { event.preventDefault(); if (!dialog.open) openSearch(); }
  });
  // Native anchor links still work without JS. This only marks the section in view.
  const headings = [...document.querySelectorAll('article h2[id],article h3[id]')];
  const links = [...document.querySelectorAll('.page-toc a,.mobile-toc a')];
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const active = '#' + visible[0].target.id;
      links.forEach(link => { if (link.getAttribute('href') === active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    }, {rootMargin: '-75px 0px -55% 0px'});
    headings.forEach(heading => observer.observe(heading));
  }
})();
