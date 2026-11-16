#!/usr/bin/env python3
"""Check every built page, local link, fragment, search target and diagram."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import hashlib
import sys

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'docs/site'

class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.ids = []
        self.links = []
        self.assets = []
        self.h1 = 0
        self.current = 0
        self.figures = 0
        self.captions = 0
        self.pending = 0
        self.title = False
        self.lang = None
        self.script_id = None
        self.search_json = ''
        self.feed(path.read_text())
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get('id'): self.ids.append(a['id'])
        if tag == 'html': self.lang = a.get('lang')
        if tag == 'title': self.title = True
        if tag == 'h1': self.h1 += 1
        if tag == 'a' and a.get('href'): self.links.append(a['href'])
        if a.get('aria-current') == 'page': self.current += 1
        if tag == 'figure': self.figures += 1
        if tag == 'figcaption': self.captions += 1
        if 'diagram-pending' in a.get('class', '').split(): self.pending += 1
        if tag == 'script': self.script_id = a.get('id')
        if tag in ('script', 'img', 'iframe', 'source') and a.get('src'): self.assets.append(a['src'])
        if tag == 'link' and a.get('rel') in ('stylesheet', 'preload'): self.assets.append(a.get('href', ''))
    def handle_endtag(self, tag):
        if tag == 'script': self.script_id = None
    def handle_data(self, data):
        if self.script_id == 'search-data': self.search_json += data


def main():
    allow_pending = '--allow-pending' in sys.argv
    manifest = json.loads((SITE / 'site-manifest.json').read_text())
    paths = [SITE / item['route'] for item in manifest]
    errors = []
    fingerprints = json.loads((SITE / 'build-info.json').read_text())['inputs']
    for name, expected_digest in fingerprints.items():
        source = ROOT / name
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != expected_digest:
            errors.append('HTML is stale; rebuild after changing ' + name)
    pages = {p.resolve(): Page(p) for p in paths}
    checked = 0
    search_checked = 0
    for path, page in pages.items():
        rel = path.relative_to(SITE)
        duplicate_ids = [key for key, count in Counter(page.ids).items() if count > 1]
        if duplicate_ids: errors.append(f'{rel}: duplicate IDs {duplicate_ids}')
        if page.h1 != 1 or not page.title or page.lang != 'en': errors.append(f'{rel}: missing or invalid document landmarks/title')
        if page.current != 1: errors.append(f'{rel}: expected exactly one active sidebar page')
        if page.figures != page.captions: errors.append(f'{rel}: figures need captions')
        if page.pending and not allow_pending: errors.append(f'{rel}: {page.pending} diagrams not rendered')
        for url in page.links + page.assets:
            parsed = urlsplit(url)
            if parsed.scheme or parsed.netloc: continue
            target = (path.parent / unquote(parsed.path)).resolve() if parsed.path else path
            checked += 1
            if not target.is_relative_to(SITE): errors.append(f'{rel}: link escapes site {url}')
            elif not target.is_file(): errors.append(f'{rel}: missing local file {url}')
            elif parsed.fragment and target.suffix == '.html':
                if target not in pages: errors.append(f'{rel}: unchecked HTML target {url}')
                elif unquote(parsed.fragment) not in pages[target].ids: errors.append(f'{rel}: missing fragment {url}')
        if page.assets: errors.append(f'{rel}: self-contained page loads assets: {page.assets}')
        try:
            index = json.loads(page.search_json)
            if not index: errors.append(f'{rel}: empty search data')
            for entry in index:
                url = urlsplit(entry['url'])
                target = (SITE / url.path).resolve()
                search_checked += 1
                if target not in pages or (url.fragment and url.fragment not in pages[target].ids): errors.append(f'{rel}: invalid search target {entry["url"]}')
        except Exception as exc: errors.append(f'{rel}: search JSON {exc}')
    extras = sorted(p.relative_to(SITE).as_posix() for p in SITE.rglob('*.html') if p.resolve() not in pages)
    if extras: errors.append(f'Unexpected HTML pages: {extras}')
    coverage = {str((ROOT / item['source']).resolve()) for item in manifest}
    expected = {str(p.resolve()) for p in (ROOT / 'docs/design').rglob('*.md')}
    expected |= {str(p.resolve()) for p in (ROOT / 'docs/architecture').rglob('*.md')}
    expected |= {str(p.resolve()) for p in (ROOT / 'docs/implementation').rglob('*.md')}
    expected |= {str(p.resolve()) for p in (ROOT / 'docs/research').glob('*.md')}
    expected.add(str((ROOT / 'docs/research/archive/README.md').resolve()))
    expected.add(str((ROOT / 'docs/development.md').resolve()))
    expected |= {str((ROOT / name).resolve()) for name in ('apps/console/README.md', 'tools/operator/README.md','deploy/README.md','deploy/sign-in.md','deploy/keycloak/README.md','scripts/full-roadmap/README.md')}
    for archived in (ROOT / 'docs/research/archive/runtime-platform').rglob('*.md'):
        copy = SITE / 'source' / archived.relative_to(ROOT / 'docs')
        if not copy.is_file() or copy.read_bytes() != archived.read_bytes():
            errors.append('Missing/stale archived source copy: ' + str(archived.relative_to(ROOT)))
    if coverage != expected: errors.append(f'Source coverage mismatch: {sorted(coverage ^ expected)}')
    print(json.dumps({'pages': len(pages), 'local_links_and_fragments': checked, 'search_targets': search_checked, 'figures': sum(p.figures for p in pages.values()), 'pending_diagrams': sum(p.pending for p in pages.values()), 'errors': errors}, indent=2))
    return bool(errors)

if __name__ == '__main__':
    raise SystemExit(main())
