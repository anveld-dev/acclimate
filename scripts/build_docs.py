#!/usr/bin/env python3
"""Build an offline HTML docs set from the repository's Markdown sources."""
from pathlib import Path
import html
import hashlib
import json
import os
import re
import shutil
from urllib.parse import unquote, urlsplit

try:
    from markdown_it import MarkdownIt
except ImportError:
    raise SystemExit('Install the docs build dependency: python3 -m pip install -r scripts/docs-requirements.txt')

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/site'
ASSETS = ROOT / 'docs/site-src'
PAGES = [
    ('CONTEXT.md', 'glossary.html', 'Start here', 'Glossary', 'Acclimate’s public vocabulary and service terminology.'),
    ('docs/design/README.md', 'index.html', 'Start here', 'Design guide', 'A small service for improving and delivering harness files.'),
    ('docs/design/overview.md', 'overview.html', 'Start here', 'Overview and ownership', 'The service delivers content; the application runs its native agent SDK.'),
    ('docs/design/bundles-and-cache.md', 'bundles.html', 'Service design', 'Bundles and local cache', 'Immutable files, scoped caching, freshness, and job-local preparation.'),
    ('docs/design/sdk-and-plugins.md', 'sdk.html', 'Service design', 'SDKs and plugins', 'A small application-side mapping to native SDK inputs.'),
    ('docs/design/improvement.md', 'improvement.html', 'Service design', 'How improvement works', 'Propose a file change, compare in the app, and promote deliberately.'),
    ('docs/design/service.md', 'service.html', 'Service design', 'Service interface', 'The Rust server records and HTTP operations.'),
    ('docs/design/roadmap.md', 'roadmap.html', 'Start here', 'Build roadmap', 'Deliver useful content before adding more machinery.'),
    ('docs/development.md', 'development.html', 'Start here', 'Production setup', 'Configure PostgreSQL, verified identity and the service before testing SDK integrations.'),
    ('docs/architecture/README.md', 'architecture/index.html', 'Architecture', 'Code architecture', 'Planned code layout, module interfaces, and implementation reading path.'),
    ('docs/architecture/production-only/plan.md', 'production/plan.html', 'Production app', 'Production plan', 'One PostgreSQL-backed application with verified identity and explicit configuration.'),
    ('docs/architecture/production-only/review.md', 'production/review.html', 'Production app', 'Review decisions', 'Resolved scope, compatibility, identity and acceptance objections.'),
    ('docs/architecture/production-only/parallel-work.md', 'production/parallel.html', 'Production app', 'Parallel work paths', 'Sole file owners, frozen interfaces and integration gates.'),
    ('docs/architecture/production-only/evidence.md', 'production/evidence.html', 'Production app', 'Production evidence', 'Executed isolated checks and external deployment qualification limits.'),
    ('docs/architecture/contracts.md', 'architecture/contracts.html', 'Architecture', 'Shared contracts', 'The schema, types, and fixtures that unblock parallel coding.'),
    ('docs/architecture/server.md', 'architecture/server.html', 'Architecture', 'Rust server modules', 'Feature ownership, database transactions, and bounded proposal jobs.'),
    ('docs/architecture/sdk.md', 'architecture/sdk.html', 'Architecture', 'SDK and native plugins', 'Application-side client/cache/preparation code and native SDK packages.'),
    ('docs/architecture/parallel-work.md', 'architecture/parallel-work.html', 'Architecture', 'Parallel agent work', 'Owned streams, dependencies, task briefs, and integration gates.'),
    ('docs/implementation/next-milestone.md', 'implementation/next-milestone.html', 'Architecture', 'SDK release milestone', 'Parallel paths and acceptance gates for usable SDKs and a real improvement loop.'),
    ('docs/implementation/full-roadmap.md', 'implementation/full-roadmap.html', 'Start here', 'Whole roadmap status', 'All five product stages, their acceptance evidence and qualification limits.'),
    ('docs/architecture/productization/README.md', 'productization/index.html', 'Productization', 'Implementation plan', 'Proposed slices, shared contracts and parallel implementation ownership.'),
    ('docs/architecture/productization/drafts-and-content.md', 'productization/drafts.html', 'Productization', 'Durable drafts and content', 'Saved drafts, imports, immutable snapshots and conflict-safe publication.'),
    ('docs/architecture/productization/improvement-and-evaluation.md', 'productization/improvement.html', 'Productization', 'Improvement and evaluation', 'Real proposal, app-run evaluation, evidence review and deliberate release.'),
    ('docs/architecture/productization/workspaces-and-access.md', 'productization/access.html', 'Productization', 'Workspaces and access', 'Scoped selection, browser identity, membership and verified attribution.'),
    ('docs/architecture/productization/integrations-and-delivery.md', 'productization/delivery.html', 'Productization', 'Integrations and delivery', 'Opt-in SDK delivery reports with precise evidence limits.'),
    ('docs/architecture/productization/onboarding-and-status.md', 'productization/onboarding.html', 'Productization', 'Onboarding and status', 'Explicit examples, stored provenance and truthful observed connection state.'),
    ('docs/architecture/productization/acceptance.md', 'productization/acceptance.html', 'Productization', 'Acceptance and release gates', 'Deterministic, PostgreSQL, browser and optional native qualification.'),
    ('docs/architecture/productization/remediation/README.md', 'productization/remediation/index.html', 'Implementation work', 'Implementation work', 'Reviewed remediation plan and parallel work paths.'),
    ('docs/architecture/productization/remediation/plan.md', 'productization/remediation/plan.html', 'Implementation work', 'Fix plan', 'Concrete user behavior, minimal contracts and audit coverage.'),
    ('docs/architecture/productization/remediation/review.md', 'productization/remediation/review.html', 'Implementation work', 'Plan review decisions', 'Independent review objections and the resulting corrections.'),
    ('docs/architecture/productization/remediation/parallel-work.md', 'productization/remediation/parallel.html', 'Implementation work', 'Parallel implementation', 'Sole owners, contract seams, work waves and acceptance gates.'),
    ('docs/architecture/productization/remediation/shipping-evidence.md', 'productization/remediation/shipping.html', 'Implementation work', 'Shipping evidence', 'Executed local checks, retained artifact evidence and honest external qualification gates.'),
    ('docs/architecture/productization/current-audit.md', 'productization/current-audit.html', 'Productization', 'Current product audit', 'Concrete recovery, compatibility and workflow gaps found by five reviewers.'),
    ('docs/architecture/productization/review.md', 'productization/review.html', 'Productization', 'Plan review findings', 'Sol validation of the Terra findings: actual bugs, acceptable behavior and scope cuts.'),
    ('docs/architecture/productization/navigation.md', 'productization/navigation.html', 'Productization', 'Console navigation review', 'Proposed page hierarchy, action ownership, scope fixes and migration checks.'),
    ('docs/architecture/productization/ui-improvements.md', 'productization/ui-improvements.html', 'Productization', 'UI improvement plan', 'Four-agent review of task clarity, compact layout, navigation and app setup.'),
    ('apps/console/README.md', 'operate/console.html', 'Operate', 'Web console', 'Configure the authenticated TanStack Start console for content and release history.'),
    ('tools/operator/README.md', 'operate/review.html', 'Operate', 'Review and release', 'Verified reviews, proposal requests, history, explicit promotion and rollback.'),
    ('deploy/README.md', 'operate/deploy.html', 'Operate', 'Deploy and restore', 'One-process deployment recipes and private PostgreSQL backup/restore.'),
    ('docs/evaluator-operations.md', 'operate/evaluators.html', 'Operate', 'Evaluator operations', 'Provision application evaluators and serve connected learning assignments.'),
    ('deploy/sign-in.md', 'operate/sign-in.html', 'Operate', 'Production sign-in', 'Keycloak decision, realm issuer, callback and application authority.'),
    ('deploy/keycloak/README.md', 'operate/keycloak.html', 'Operate', 'Keycloak setup', 'PostgreSQL identity deployment, confidential client, bootstrap and qualification.'),
    ('scripts/full-roadmap/README.md', 'operate/qualification.html', 'Operate', 'Full qualification', 'Repeat the central proposer, app evaluation and fixture release flow.'),
    ('docs/research/README.md', 'research/index.html', 'Research', 'Research guide', 'Current SDK evidence, scope decisions, and original reference research.'),
    ('docs/research/auth-setups.md', 'research/auth-setups.html', 'Research', 'Authentication setups', 'Social login, Rust libraries, app-level auth and self-hosted identity with PostgreSQL.'),
    ('docs/research/sdk-file-delivery.md', 'research/sdk-file-delivery.html', 'Research', 'Native SDK file delivery', 'Verified Claude, Codex, Cursor, and Pi content delivery routes.'),
    ('docs/research/service-scope-audit.md', 'research/service-scope-audit.html', 'Research', 'Scope audit', 'What was cut from the earlier runtime-platform proposal.'),
    ('docs/research/agentrun.md', 'research/agentrun.html', 'Research', 'AgentRun', 'Upstream runtime and learning observations, with their limits.'),
    ('docs/research/rrsi.md', 'research/rrsi.html', 'Research', 'RRSI', 'Research inspiration, not the default service implementation.'),
    ('docs/research/source-audit.md', 'research/source-audit.html', 'Research', 'Source audit', 'Detailed evidence from the original read-only research.'),
    ('docs/research/archive/README.md', 'research/archive.html', 'History', 'Earlier proposal', 'Superseded runtime-platform Markdown snapshots.'),
]
ROUTES = {(ROOT / src).resolve(): route for src, route, *_ in PAGES}
ROUTES[(ROOT / 'docs/README.md').resolve()] = 'index.html'
ROUTES[(ROOT / 'README.md').resolve()] = 'index.html'
SOURCE_EXPORTS = {}
GROUPS = [(name, [i for i, page in enumerate(PAGES) if page[2] == name]) for name in ('Start here', 'Service design', 'Architecture', 'Production app', 'Productization', 'Implementation work', 'Operate', 'Research', 'History')]



def source_export(src):
    path = Path(src)
    return path.relative_to('docs') if path.parts[0] == 'docs' else Path('repository') / path


def esc(value):
    return html.escape(str(value), quote=True)


def slug(value):
    value = re.sub(r'<[^>]+>', '', value)
    return re.sub(r'[^\w\- ]', '', html.unescape(value).lower()).replace(' ', '-')


def relative(route, current):
    return os.path.relpath(OUT / route, (OUT / current).parent).replace(os.sep, '/')


def rewrite_url(url, source, current):
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return url
    target = (source.parent / unquote(parsed.path)).resolve()
    if target in ROUTES:
        dest = relative(ROUTES[target], current)
    elif (target.is_file() and target.is_relative_to(ROOT)
          and target.relative_to(ROOT).parts[0] in {'src', 'tests', 'migrations', 'packages', 'apps', 'examples', 'scripts', 'contracts', 'deploy', '.github', 'features', 'python'}
          and target.suffix in {'.rs', '.ts', '.tsx', '.py', '.sql', '.json', '.toml', '.yaml', '.yml', '.md', '.mdx', '.feature'}
          and not any(part in {'node_modules', '.local', '.repos', 'target', 'dist', '.output'} or part.startswith('.env') for part in target.relative_to(ROOT).parts)):
        exported = 'source/repository/' + target.relative_to(ROOT).as_posix()
        SOURCE_EXPORTS[target] = exported
        dest = relative(exported, current)
    elif target == (ROOT / '.repos.json').resolve():
        dest = relative('source/repositories.json', current)
    elif target == (ROOT / 'docs/visuals/acclimate-walkthrough.html').resolve():
        # The web overview replaces the older standalone storyboard in this reading path.
        dest = relative('overview.html', current)
    elif target.is_file() and target.suffix == '.md' and target.is_relative_to(ROOT / 'docs'):
        exported = 'source/' + target.relative_to(ROOT / 'docs').as_posix()
        SOURCE_EXPORTS[target] = exported
        dest = relative(exported, current)
    elif target.is_file() and target.suffix == '.html' and target.is_relative_to(ROOT / 'docs/design'):
        # Standalone visual studies are repository attachments, not docs-shell pages.
        return 'https://github.com/anveld-dev/acclimate/blob/main/' + target.relative_to(ROOT).as_posix()
    else:
        raise ValueError('Unmapped local link in {}: {}'.format(source.relative_to(ROOT), url))
    return dest + ('?' + parsed.query if parsed.query else '') + ('#' + parsed.fragment if parsed.fragment else '')


def source_text(source):
    text = source.read_text()
    text = re.sub(r'^# .+\n', '', text, count=1)
    # Only the standalone guide breadcrumb is redundant with the shell. Keep
    # source status/audience text: it can contain substantive qualification context.
    text = re.sub(r'^\[Design guide\]\([^\n]+\)\s*\n', '', text, flags=re.M)
    return text.strip() + '\n'


def article(source, current, diagrams):
    text = source_text(source)
    source_key = source.relative_to(ROOT).as_posix()

    def drawing(match):
        key = match.group(1)
        if key not in diagrams:
            raise ValueError('Unregistered diagram: ' + key)
        record = diagrams[key]
        if record['source'] != source_key:
            raise ValueError('Diagram {} belongs to {}, not {}'.format(key, record['source'], source_key))
        fragment = (ASSETS / 'diagrams' / record['file']).resolve()
        if not fragment.is_relative_to((ASSETS / 'diagrams').resolve()) or not fragment.is_file():
            raise ValueError('Invalid diagram fragment: ' + record['file'])
        return '\n' + fragment.read_text() + '\n'

    # An explicit identifier binds each drawing to this source page. When a
    # marker precedes a Mermaid fallback, consume that fallback too; a marker
    # without one simply inserts an additional HTML drawing.
    text = re.sub(r'<!-- diagram:([a-z0-9-]+) -->\s*(?:```mermaid\n.*?```\s*)?', drawing, text, flags=re.S)
    if re.search(r'```mermaid\b', text):
        raise ValueError('Mermaid block needs an explicit diagram marker in ' + source_key)
    md = MarkdownIt('commonmark', {'html': True}).enable('table')
    tokens = md.parse(text)
    headings = []
    counts = {}
    for i, token in enumerate(tokens):
        if token.type == 'heading_open':
            title = tokens[i + 1].content
            base = slug(title)
            n = counts.get(base, 0)
            counts[base] = n + 1
            anchor = base + ('-' + str(n) if n else '')
            token.attrSet('id', anchor)
            if token.tag in ('h2', 'h3'):
                headings.append((token.tag, title, anchor))
        for child in token.children or []:
            if child.type == 'link_open':
                child.attrSet('href', rewrite_url(child.attrGet('href') or '', source, current))
    rendered = md.renderer.render(tokens, md.options, {})
    rendered = rendered.replace('<table>', '<div class="table-scroll" role="region" aria-label="Reference table" tabindex="0"><table>').replace('</table>', '</table></div>')
    # Keep leading scope metadata visible, with the first explanatory paragraph
    # as the introduction. Never discard a paragraph based on its wording.
    if text.lstrip().startswith(('**For:**', '**Draft ·', '**Proposed order ·', '**Implementation reference.**')):
        rendered = rendered.replace('<p>', '<p class="scope-note">', 1)
    rendered = rendered.replace('<p>', '<p class="lead">', 1)
    rendered = re.sub(r'<pre><code class="language-([^\"]+)"', r'<pre data-language="\1"><code class="language-\1"', rendered)
    plain = re.sub(r'<[^>]+>', ' ', rendered)
    plain = re.sub(r'\s+', ' ', html.unescape(plain)).strip()
    return rendered, headings, plain


def toc_markup(headings, current=False):
    return '<ol>' + ''.join('<li class="toc-{}"><a href="#{}">{}</a></li>'.format(level, esc(anchor), esc(title)) for level, title, anchor in headings) + '</ol>'


def sidebar(current):
    result = []
    for group, indices in GROUPS:
        links = []
        for i in indices:
            _, route, _, title, _ = PAGES[i]
            state = ' aria-current="page"' if route == current else ''
            links.append('<li><a href="{}"{}>{}</a></li>'.format(esc(relative(route, current)), state, esc(title)))
        result.append('<section class="nav-group"><h2>{}</h2><ul>{}</ul></section>'.format(esc(group), ''.join(links)))
    return ''.join(result)


def page_kind(group):
    return {
        'Productization': 'Product implementation · local qualification',
        'Operate': 'Operations · local qualification',
        'Architecture': 'Code architecture · first implementation',
        'History': 'Archived proposal · superseded',
        'Research': 'Source notes · November 2026',
    }.get(group, 'Content service design')


def page_footer(group):
    if group == 'Productization':
        return 'Implemented code; see acceptance evidence for local and hosted qualification limits.'
    if group == 'Architecture':
        return 'First implementation. See Run locally for checks and qualification limits.'
    if group in ('Research', 'History'):
        return 'Source inspection notes; see each page for later integration checks.'
    return 'See Run locally for implementation checks and current limits.'


def build():
    SOURCE_EXPORTS.clear()
    OUT.mkdir(parents=True, exist_ok=True)
    prior_manifest = json.loads((OUT / 'site-manifest.json').read_text()) if (OUT / 'site-manifest.json').exists() else []
    css = (ASSETS / 'styles.css').read_text()
    if (ASSETS / 'diagrams.css').exists():
        css += '\n' + (ASSETS / 'diagrams.css').read_text()
    js = (ASSETS / 'app.js').read_text()
    diagrams = json.loads((ASSETS / 'diagrams.json').read_text()) if (ASSETS / 'diagrams.json').exists() else {}
    uses = {}
    for src, *_ in PAGES:
        for key in re.findall(r'<!-- diagram:([a-z0-9-]+) -->', (ROOT / src).read_text()):
            uses.setdefault(key, []).append(src)
    if set(uses) != set(diagrams):
        raise ValueError('Unused or unregistered diagrams: ' + str(sorted(set(uses) ^ set(diagrams))))
    for key, record in diagrams.items():
        if uses[key] != [record['source']]:
            raise ValueError('Diagram must appear exactly once in its registered page: ' + key)
    registered_files = {record['file'] for record in diagrams.values()}
    actual_files = {p.name for p in (ASSETS / 'diagrams').glob('*.html')}
    if registered_files != actual_files:
        raise ValueError('Unregistered or missing diagram files: ' + str(sorted(registered_files ^ actual_files)))
    articles = []
    search = []
    for src, route, group, label, description in PAGES:
        source = ROOT / src
        title = re.search(r'^# (.+)', source.read_text()).group(1)
        body, headings, plain = article(source, route, diagrams)
        articles.append((title, body, headings, plain))
        # Include all body text in matching; only a short excerpt is displayed.
        search.append({'title': title, 'section': 'Page', 'url': route, 'text': plain, 'summary': description})
        for level, heading, anchor in headings:
            search.append({'title': title, 'section': heading, 'url': route + '#' + anchor, 'text': heading, 'summary': description})
    source_dir = OUT / 'source'
    if source_dir.is_symlink():
        raise ValueError('Generated source directory must not be a symlink')
    if source_dir.exists():
        shutil.rmtree(source_dir)
    for i, (src, route, group, label, description) in enumerate(PAGES):
        title, body, headings, plain = articles[i]
        research = group in ('Research', 'History')
        def pager(index, direction):
            if index < 0 or index >= len(PAGES):
                return '<span></span>'
            item = PAGES[index]
            return '<a class="page-turn" href="{}"><span>{}</span><strong>{}</strong></a>'.format(esc(relative(item[1], route)), direction, esc(item[3]))
        toc = toc_markup(headings)
        source_href = relative('source/' + source_export(src).as_posix(), route)
        search_json = json.dumps(search, ensure_ascii=False).replace('<', '\\u003c')
        prefix = relative('index.html', route).removesuffix('index.html')
        page = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{description}">
<title>{title} · Acclimate docs</title>
<script>try{{document.documentElement.dataset.theme=localStorage.getItem('acclimate-docs-theme')||''}}catch(e){{}}</script>
<style>{css}</style>
</head>
<body data-root="{prefix}">
<noscript><style>.sidebar{{display:block!important;position:static}}.search-open,.theme-toggle,.menu-toggle{{display:none!important}}</style></noscript>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><a class="brand" href="{home}" aria-label="Acclimate documentation home"><span class="brand-mark" aria-hidden="true">a</span>Acclimate<span class="brand-subtitle">/ docs</span></a><div class="header-actions"><span class="draft-label">{scope_label}</span><button type="button" class="search-open" data-search-open>Search <kbd>⌘ K</kbd></button><button type="button" class="theme-toggle" aria-label="Switch color theme">Theme</button><button type="button" class="menu-toggle" aria-controls="docs-sidebar" aria-expanded="false">Menu</button></div></header>
<div class="docs-layout">
<aside class="sidebar" id="docs-sidebar" data-open="false"><nav aria-label="Documentation">{nav}</nav><p class="sidebar-note">Small content service. The application runs its agents.</p></aside>
<main id="main" tabindex="-1"><div class="page-heading"><nav class="breadcrumb" aria-label="Breadcrumb"><a href="{home}">Docs</a><span aria-hidden="true">/</span><span>{group}</span></nav><p class="eyebrow">{kind}</p><h1>{title}</h1><div class="page-meta"><span>{minutes} min read</span><a href="{source}">Markdown source</a></div></div>
<details class="mobile-toc"{toc_hidden}><summary>On this page</summary><nav aria-label="On this page">{toc}</nav></details>
<article>{body}</article>
<nav class="page-pagination" aria-label="Reading order">{prev}{next}</nav>
<footer class="page-footer"><span>{footer}</span><a href="#main">Back to top ↑</a></footer>
</main>
<aside class="page-toc"{toc_hidden}><p>On this page</p><nav aria-label="Page sections">{toc}</nav></aside>
</div>
<dialog class="search-dialog" aria-labelledby="search-title"><div class="search-heading"><h2 id="search-title">Search the docs</h2><button type="button" class="search-close" aria-label="Close search">Close</button></div><label class="sr-only" for="docs-search">Search pages and sections</label><input id="docs-search" type="search" placeholder="Try cache, skills, or promotion…" autocomplete="off"><p class="search-status" role="status">Type to search all pages.</p><ul class="search-results"></ul></dialog>
<script id="search-data" type="application/json">{search_json}</script>
<script>{js}</script>
</body></html>'''.format(description=esc(description), scope_label='Local implementation', title=esc(title), css=css, prefix=esc(prefix), home=esc(relative('index.html', route)), nav=sidebar(route), group=esc(group), kind=page_kind(group), minutes=max(1, round(len(plain.split()) / 220)), source=esc(source_href), toc=toc, toc_hidden=' hidden' if not headings else '', body=body, prev=pager(i - 1, 'Previous'), next=pager(i + 1, 'Next'), footer=page_footer(group), search_json=search_json, js=js)
        dest = OUT / route
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(page)
        source_dest = OUT / 'source' / source_export(src)
        source_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / src, source_dest)
    # Keep implementation/review notes downloadable without adding every historical
    # experiment to the primary reading path or duplicating it into global search.
    source_notes = set((ROOT / 'docs/design').rglob('*.md'))
    source_notes |= set((ROOT / 'docs/architecture').rglob('*.md'))
    source_notes |= set((ROOT / 'docs/implementation').rglob('*.md'))
    source_notes |= set((ROOT / 'docs/research').glob('*.md'))
    source_notes |= set((ROOT / 'docs/research/continuous-harness-review').rglob('*.md'))
    source_notes |= set((ROOT / 'docs/research/real-app-learning-experiment').rglob('*.md'))
    published_sources = {ROOT / src for src, *_ in PAGES}
    note_manifest = []
    for source_path in sorted(source_notes - published_sources):
        exported = 'source/' + source_export(source_path.relative_to(ROOT)).as_posix()
        SOURCE_EXPORTS[source_path] = exported
        note_manifest.append({'source': source_path.relative_to(ROOT).as_posix(), 'route': exported, 'kind': 'source'})
    for source_path, exported in SOURCE_EXPORTS.items():
        destination = OUT / exported
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, destination)
    for archived in sorted((ROOT / 'docs/research/archive/runtime-platform').rglob('*.md')):
        archived_dest = OUT / 'source' / archived.relative_to(ROOT / 'docs')
        archived_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(archived, archived_dest)
    current_routes = {page[1] for page in PAGES}
    for previous in prior_manifest:
        if previous.get('kind') == 'source':
            continue  # The source directory was replaced above.
        if previous['route'] not in current_routes:
            stale = (OUT / previous['route']).resolve()
            if not stale.is_relative_to(OUT.resolve()) or stale.suffix != '.html':
                raise ValueError('Unsafe previous generated route')
            if stale.exists():
                stale.unlink()
    (OUT / 'source').mkdir(exist_ok=True)
    shutil.copyfile(ROOT / '.repos.json', OUT / 'source/repositories.json')
    (OUT / 'site-manifest.json').write_text(json.dumps([{'source': src, 'route': route, 'group': group, 'title': title} for src, route, group, title, _ in PAGES] + note_manifest, indent=2) + '\n')
    inputs = [ROOT / src for src, *_ in PAGES] + [ROOT / '.repos.json', ROOT / 'scripts/build_docs.py', ROOT / 'scripts/docs-requirements.txt']
    inputs += [ASSETS / name for name in ('styles.css', 'app.js', 'diagrams.css', 'diagrams.json')]
    inputs += sorted((ASSETS / 'diagrams').glob('*.html'))
    inputs += sorted((ROOT / 'docs/research/archive/runtime-platform').rglob('*.md'))
    inputs += sorted(SOURCE_EXPORTS)
    fingerprints = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    (OUT / 'build-info.json').write_text(json.dumps({'inputs': fingerprints}, indent=2) + '\n')
    print('Built {} standalone HTML pages in {}'.format(len(PAGES), OUT))

if __name__ == '__main__':
    build()
