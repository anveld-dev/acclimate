#!/usr/bin/env python3
"""Exercise the built docs over file:// in an isolated headless Chrome context.

Optional QA dependencies: playwright. Uses installed Chrome by default; --channel
can select another installed channel. No browser downloads or server needed.
"""
from pathlib import Path
import argparse
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'docs/site'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', default='chrome')
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    pages = [item for item in json.loads((SITE / 'site-manifest.json').read_text())
             if item.get('kind') != 'source']
    errors = []
    network = []
    layouts = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel, headless=True)
        context = browser.new_context()
        context.route('http://**/*', lambda route: route.abort())
        context.route('https://**/*', lambda route: route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: network.append(request.url) if request.url.startswith(('https://', 'http://')) else None)
        for appearance in ('light', 'dark'):
            page.emulate_media(color_scheme=appearance)
            for width in (1440, 1024, 768, 390, 320):
                page.set_viewport_size({'width': width, 'height': 950})
                for item in pages:
                    page.goto((SITE / item['route']).as_uri())
                    layouts += 1
                    failures = page.evaluate('''() => {
                      const failures = [];
                      if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('page overflow');
                      for (const figure of document.querySelectorAll('figure.diagram')) {
                        const frame = figure.getBoundingClientRect();
                        for (const item of figure.querySelectorAll('b,strong,code,span,small,figcaption')) {
                          const box = item.getBoundingClientRect();
                          if (box.width && (box.right > frame.right + 2 || box.left < frame.left - 2)) failures.push('diagram overflow: ' + item.textContent.slice(0, 40));
                        }
                      }
                      return failures;
                    }''')
                    errors.extend(f"{item['route']} {width}/{appearance}: {failure}" for failure in failures)
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.goto((SITE / 'sdk.html').as_uri())
        page.locator('[data-search-open]').click()
        page.locator('#docs-search').fill('cache')
        assert page.locator('.search-results li').count() > 0, 'Search returned no cache results'
        page.keyboard.press('Escape')
        assert not page.locator('.search-dialog').is_visible(), 'Escape did not close search'
        assert page.locator('[data-search-open]').evaluate('(el) => el === document.activeElement'), 'Search did not return focus'
        page.keyboard.press('Control+k')
        assert page.locator('.search-dialog').is_visible(), 'Search shortcut failed'
        page.locator('#docs-search').fill('no-such-topic-384928')
        assert page.locator('.search-results li').count() == 0, 'No-results state failed'
        page.locator('#docs-search').fill('How improvement works')
        search_target = page.locator('.search-results a').first
        href = search_target.get_attribute('href')
        search_target.click()
        assert 'improvement.html' in page.url, 'Nested search result resolved incorrectly: ' + str(href)
        page.get_by_role('button', name='Switch to', exact=False).click()
        selected_theme = page.locator('html').get_attribute('data-theme')
        page.reload()
        assert page.locator('html').get_attribute('data-theme') == selected_theme, 'Theme did not persist'
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('.menu-toggle').click()
        assert page.locator('.sidebar').is_visible(), 'Mobile menu failed to open'
        assert page.locator('.menu-toggle').get_attribute('aria-expanded') == 'true'
        page.keyboard.press('Escape')
        assert not page.locator('.sidebar').is_visible(), 'Mobile menu failed to close'
        page.locator('.menu-toggle').click()
        page.locator('.sidebar a').filter(has_text='SDKs and plugins').click()
        assert 'sdk.html' in page.url, 'Mobile navigation failed'
        assert page.locator('.sidebar a[aria-current=page]').inner_text() == 'SDKs and plugins'
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.goto((SITE / 'index.html').as_uri())
        page.keyboard.press('Tab')
        assert page.locator('.skip-link').evaluate('(el) => el === document.activeElement'), 'Skip link is not first'
        page.keyboard.press('Enter')
        assert page.locator('main').evaluate('(el) => el === document.activeElement'), 'Skip link did not focus main'
        page.locator('.page-pagination a').last.click()
        assert page.url.endswith('/overview.html'), 'Reading order failed'
        page.locator('.page-toc a').filter(has_text='One improvement').click()
        assert '#one-improvement' in page.url
        assert page.locator('#one-improvement').bounding_box()['y'] >= 65, 'Anchor is hidden behind the header'
        if args.screenshots:
            args.screenshots.mkdir(parents=True, exist_ok=True)
            for item in pages:
                route = item['route']
                for appearance, width in (('light', 1440), ('dark', 390)):
                    page.emulate_media(color_scheme=appearance)
                    page.set_viewport_size({'width': width, 'height': 1000})
                    page.goto((SITE / route).as_uri())
                    page.evaluate("document.documentElement.dataset.theme = '" + appearance + "'")
                    slug = route.replace('/', '-').replace('.html', '')
                    page.screenshot(path=str(args.screenshots / f'{slug}-{appearance}-{width}.png'), full_page=True)
                    page.locator('.site-header').evaluate("el => el.style.visibility = 'hidden'")
                    for i, figure in enumerate(page.locator('figure.diagram').all()):
                        figure.screenshot(path=str(args.screenshots / f'{slug}-figure-{i}-{appearance}-{width}.png'))
        no_js = browser.new_context(java_script_enabled=False, viewport={'width': 390, 'height': 844})
        offline_page = no_js.new_page()
        offline_page.goto((SITE / 'index.html').as_uri())
        assert offline_page.locator('.sidebar').is_visible(), 'No-JS mobile navigation is unavailable'
        offline_page.locator('.sidebar a').filter(has_text='How improvement works').click()
        assert 'improvement.html' in offline_page.url
        assert offline_page.locator('article').inner_text(), 'No-JS article is empty'
        browser.close()
    if network: errors.append('Unexpected network requests: ' + ', '.join(network))
    print(json.dumps({'pages': len(pages), 'responsive_theme_checks': layouts, 'flows': ['offline search + nested result', 'Escape + focus return', 'keyboard shortcut', 'empty results', 'theme persistence', 'mobile menu + navigation', 'skip link', 'previous/next', 'section anchor', 'no-JS mobile reading'], 'network_requests': len(network), 'errors': errors}, indent=2))
    if errors: raise SystemExit(1)

if __name__ == '__main__':
    main()
