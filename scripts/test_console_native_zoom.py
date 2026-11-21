#!/usr/bin/env python3
"""Check real Chrome 200% zoom against a disposable service and console."""
import argparse
import base64
import json
from pathlib import Path
import sys
import tempfile
import struct
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout
from playwright.sync_api import expect


def capture_native(page, cdp, output, name):
    metrics = inspect_layout(page)
    bitmap = base64.b64decode(cdp.send('Page.captureScreenshot',
        dict(format='png', fromSurface=True))['data'])
    (output/(name+'.png')).write_bytes(bitmap)
    pixels = struct.unpack('>II', bitmap[16:24])
    metrics['nativeScreenshotPixels'] = list(pixels)
    (output/(name+'.json')).write_text(json.dumps(metrics,indent=2)+'\n')
    assert pixels[0] == round(metrics['viewport']*page.evaluate('devicePixelRatio'))
    assert metrics['controls'] and metrics['width'] <= metrics['viewport']+1, metrics
    assert not metrics['smallText'], metrics['smallText']
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--channel', default='chrome')
    parser.add_argument('--output', type=Path, default=ROOT/'artifacts/ui-native-zoom')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    world = World(pg_bin(args.pg_bin))
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('Native zoom fixture.', files=[
            dict(path='AGENTS.md', kind='instruction', text='Review the supplied code.'),
            dict(path='skills/review/SKILL.md', kind='skill', text='---\nname: review\ndescription: Review supplied code.\n---\nRead the code and report findings.'),
            dict(path='memory/team.md', kind='memory', text='Approved fixture context.\n'*20),
        ])
        fixture = world.browser()
        with tempfile.TemporaryDirectory(prefix='acclimate-native-zoom-') as profile:
            context = fixture.playwright.chromium.launch_persistent_context(
                profile, channel=args.channel, headless=True, no_viewport=True,
                ignore_https_errors=True,
                args=['--window-size=1280,1000'])
            try:
                fixture.sign_in(context)
                page = context.pages[0]
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(fixture.base, wait_until='networkidle')
                baseline = page.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
                # Change only this temporary Chrome profile through Chrome's
                # own settings API. Verify actual layout-width/DPR effects.
                page.goto('chrome://settings/appearance', wait_until='domcontentloaded')
                page.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
                page.goto(fixture.base, wait_until='networkidle')
                page.wait_for_function('expected => Math.abs(innerWidth-expected)<2', arg=baseline['width']/2)
                assert page.evaluate('devicePixelRatio') == baseline['dpr']*2
                cdp = context.new_cdp_session(page)
                window = cdp.send('Browser.getWindowForTarget')['windowId']
                results = []
                for outer_width in (1280,640):
                    cdp.send('Browser.setWindowBounds', dict(windowId=window,
                        bounds=dict(width=outer_width,height=1000)))
                    page.wait_for_function('expected => Math.abs(innerWidth-expected)<2', arg=outer_width/2)
                    routes = dict(
                        content=fixture.bundle_path('content'),
                        releases=fixture.bundle_path('releases'),
                        library=fixture.workspace_path(),
                        connections=fixture.workspace_path('connections'),
                        setup=fixture.bundle_path('connect'),
                    )
                    for name,path in routes.items():
                        page.goto(fixture.base+path,wait_until='networkidle')
                        metrics = capture_native(page, cdp, output, f'native200-{outer_width}-{name}')
                        results.append(dict(surface=name,outerWidth=outer_width,
                            cssWidth=metrics['viewport'],dpr=page.evaluate('devicePixelRatio')))
                    page.goto(fixture.base+fixture.bundle_path('releases'),wait_until='networkidle')
                    page.get_by_role('button',name='Inspect content for revision 1',exact=True).click()
                    dialog=page.get_by_role('dialog',name='Version content',exact=True)
                    expect(dialog.get_by_text('Loading version…',exact=True)).to_have_count(0)
                    bounds=dialog.evaluate('el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,viewport:innerWidth,screen:innerHeight}}')
                    assert bounds['left'] >= 0 and bounds['right'] <= bounds['viewport']+1 and bounds['height'] <= bounds['screen']+1,bounds
                    capture_native(page,cdp,output,f'native200-{outer_width}-dialog')
                    page.keyboard.press('Escape')
                    expect(dialog).to_have_count(0)
                assert not errors, 'Native zoom browser emitted errors'
                summary=dict(passed=True,nativeZoom=2,baseline=baseline,
                    checked=results,dialogWidths=[640,320],browserErrors=0,
                    authentication='real OIDC client through private test HTTPS issuer and proxy',
                    browserFixtureTrust='ignore_https_errors in this disposable Chrome profile only',
                    externalOIDC='not qualified')
                (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
                print(json.dumps(dict(passed=True,nativeZoom=2,routeChecks=len(results),dialogChecks=2,browserErrors=0)))
            finally:
                context.close()
    finally:
        world.close()


if __name__ == '__main__':
    main()
