#!/usr/bin/env python3
"""Capture desktop product layouts against the existing build and private fixtures.

No build, provider, model, external service writes, DOM mutation, or injected focus.
The baseline records geometry violations; behavior failures always fail the run.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import struct
import traceback
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout, tab_to, assert_navigation_metrics
from scripts.testing.compact_console import FILES, visit


class Evidence:
    def __init__(self, output, baseline):
        self.output, self.baseline = output, baseline
        self.checks, self.failures, self.geometry = [], [], []

    def run(self, name, page, action):
        print('CHECK ' + name, flush=True)
        try:
            details = action()
            self.checks.append(dict(check=name, passed=True, details=details))
            print('PASS ' + name, flush=True)
        except Exception as error:
            self.checks.append(dict(check=name, passed=False))
            self.failures.append(dict(check=name, error=str(error), traceback=traceback.format_exc()))
            print('FAIL ' + name + ': ' + str(error), flush=True)
            if not page.is_closed():
                page.screenshot(path=str(self.output / (name + '-failure.png')))

    def capture(self, page, name, *, coarse=False):
        # Read-only rendered DOM inspection. Interactions use native browser input.
        page.evaluate('''async () => {
          await document.fonts.ready;
          await Promise.all(document.getAnimations().filter(a=>a.playState==='running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        }''')
        # Chromium's compositor can lag the DOM's final scroll offset after a
        # real wheel event. Allow that native scroll/paint to settle as well.
        page.wait_for_timeout(500)
        metrics = inspect_layout(page,coarse=coarse)
        metrics['desktop'] = page.evaluate('''() => {
          const rect = el => { if (!el || !el.getClientRects().length) return null; const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
          const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const node = el => ({text:(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0,160),bounds:rect(el)});
          return {title:document.title, h1:[...document.querySelectorAll('h1')].filter(visible).map(node),
            scope:[...document.querySelectorAll('.bundle-scope-header,.workspace-view-header,.workspace-switcher,.bundle-header')].filter(visible).map(node),
            main:rect(document.querySelector('main')), canvas:rect(document.querySelector('.workspace-column')),
            sidebar:rect(document.querySelector('.workspace-sidebar')),header:rect(document.querySelector('.workspace-desktop-header')),
            headerChildren:[...document.querySelectorAll('.workspace-desktop-header > *,.workspace-desktop-header a,.workspace-desktop-header button,.workspace-desktop-header select')].filter(visible).map(node),
            headerGroups:[...document.querySelectorAll('.workspace-desktop-header > *')].filter(visible).map(node),
            navigation:[...document.querySelectorAll('nav')].filter(visible).map(el=>({label:el.getAttribute('aria-label'),bounds:rect(el),links:[...el.querySelectorAll('a')].filter(visible).map(link=>({...node(link),href:link.getAttribute('href'),current:link.getAttribute('aria-current')}))})),
            focus:node(document.activeElement), focusVisible:document.activeElement.matches(':focus-visible'),
            dialogs:[...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=tooltip]')].filter(visible).map(node),
            controlTargets:[...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=menuitem]')].filter(visible).map(el=>({...node(el),tag:el.tagName,role:el.getAttribute('role'),inlineLink:el.tagName==='A' && !el.matches('[data-slot=button],.navigation-link,.bundle-nav-link,.content-file-button') && !el.closest('nav'),disabled:el.matches(':disabled'),ariaDisabled:el.getAttribute('aria-disabled'),opacity:getComputedStyle(el).opacity,font:parseFloat(getComputedStyle(el).fontSize)}))};
        }''')
        violations = []
        if metrics['width'] > metrics['viewport'] + 1:
            violations.append('page overflow')
        try:
            assert_navigation_metrics(metrics)
        except AssertionError as error:
            violations.append('bundle header rows/tabs invalid: '+str(error))
        if metrics['smallText'] or metrics['smallReadingText']:
            violations.append('reading/control text below 14px')
        # Inline prose links use text size/legibility; the target gate concerns
        # standalone controls and navigation, not every inline text anchor.
        target_minimum=44 if coarse else 32
        if coarse:
            assert metrics['pointerCoarse'],'Coarse desktop capture must use an actual coarse-pointer context'
        short = [row for row in metrics['desktop']['controlTargets'] if not row['inlineLink'] and row['bounds'] and (row['bounds']['height'] < target_minimum-0.5 or (coarse and row['bounds']['width'] < target_minimum-0.5))]
        if short:
            violations.append(f'{"coarse" if coarse else "fine"} pointer target below {target_minimum}px')
        if not metrics['desktop']['h1']:
            violations.append('missing visible h1')
        if not self.baseline and metrics['viewport']>1000:
            header=metrics['desktop']['header']
            canvas=metrics['desktop']['canvas']
            expanded=page.locator('.workspace-desktop-rail').get_attribute('data-rail-expanded')=='true'
            rail_width=176 if expanded else 64
            if not header or abs(header['x'])>1 or abs(header['y'])>1 or abs(header['width']-rail_width)>1 or abs(header['height']-metrics['viewportHeight'])>1:
                violations.append('desktop rail must occupy its selected width for the viewport height')
            if not canvas or abs(canvas['x']-rail_width)>1 or abs(canvas['width']-(metrics['viewport']-rail_width))>1:
                violations.append('desktop canvas must use the remaining width beside the rail')
            if header:
                outside=[row for row in metrics['desktop']['headerChildren'] if row['bounds'] and (row['bounds']['x']<header['x']-1 or row['bounds']['right']>header['right']+1 or row['bounds']['y']<header['y']-1 or row['bounds']['bottom']>header['bottom']+1)]
                overlaps=[]
                groups=metrics['desktop']['headerGroups']
                for i,first in enumerate(groups):
                    for second in groups[i+1:]:
                        a,b=first['bounds'],second['bounds']
                        if a and b and min(a['right'],b['right'])-max(a['x'],b['x'])>1 and min(a['bottom'],b['bottom'])-max(a['y'],b['y'])>1:
                            overlaps.append([first['text'],second['text']])
                metrics['desktop']['headerOutside']=outside
                metrics['desktop']['headerOverlaps']=overlaps
                if outside or overlaps:
                    violations.append('desktop header children must be contained and groups must not overlap')
        metrics['violations'] = violations
        metrics['shortTargets'] = short
        cdp = page.context.new_cdp_session(page)
        try:
            bitmap = base64.b64decode(cdp.send('Page.captureScreenshot',dict(format='png',fromSurface=True,captureBeyondViewport=False))['data'])
        finally:
            cdp.detach()
        (self.output / (name + '.png')).write_bytes(bitmap)
        after = inspect_layout(page,coarse=coarse)
        stable = ('viewport','viewportHeight','width','editor','publishedContent','selectedHeader','scrollY','visualViewportOffsetTop')
        metrics['capture'] = dict(method='CDP Page.captureScreenshot',pixels=list(struct.unpack('>II',bitmap[16:24])),
            before={key:metrics[key] for key in stable},after={key:after[key] for key in stable})
        (self.output / (name + '.json')).write_text(json.dumps(metrics, indent=2) + '\n')
        assert metrics['capture']['before']==metrics['capture']['after'], 'Screenshot changed route geometry'
        assert metrics['capture']['pixels']==[metrics['viewport'],metrics['viewportHeight']],metrics['capture']
        if violations:
            self.geometry.append(dict(surface=name, violations=violations))
        return metrics


def activate(page, target, *, reverse=False):
    tab_to(page, target, reverse=reverse)
    page.keyboard.press('Enter')


def navigation(page):
    """All rendered main and bundle navigation links must be keyboard reachable."""
    rows = []
    for label in ('Main navigation', 'Bundle navigation'):
        nav = page.get_by_role('navigation', name=label, exact=True)
        if not nav.count():
            continue
        links = nav.get_by_role('link')
        visible = [links.nth(i) for i in range(links.count()) if links.nth(i).is_visible()]
        if label == 'Bundle navigation':
            assert len(visible) == 4, 'Four bundle views must remain visible'
        for link in visible:
            tab_to(page, link)
            expect(link).to_be_focused()
            rows.append(dict(navigation=label, name=link.inner_text().strip(), href=link.get_attribute('href')))
    assert rows, 'No keyboard reachable navigation'
    # Native wheel returns to initial route context after Tab's real scrolling.
    page.mouse.move(1, 1)
    page.mouse.wheel(0, -10000)
    page.wait_for_function('scrollY <= 1')
    return rows


def keyboard_resize(b,e,routes):
    """Verify the app hands focus to real visible controls across its breakpoint."""
    p=b.page
    p.set_viewport_size(dict(width=1024,height=768))
    visit(p,b,routes['library'])
    account=p.get_by_role('button',name='Account',exact=True)
    tab_to(p,account)
    expect(account).to_be_focused()
    e.capture(p,'1024-account-before-resize-focus')
    p.set_viewport_size(dict(width=899,height=768))
    menu=p.get_by_role('button',name='Open navigation',exact=True)
    expect(menu).to_be_visible()
    expect(account).not_to_be_visible()
    expect(menu).to_be_focused(timeout=5000)
    e.capture(p,'899-hidden-header-menu-focus')
    p.set_viewport_size(dict(width=1024,height=768))
    expect(menu).not_to_be_visible()
    expect(p.get_by_role('main')).to_be_focused(timeout=5000)
    e.capture(p,'1024-hidden-menu-main-focus')
    return dict(accountKeyboardReached=True,hiddenHeaderToVisibleMenu=True,hiddenClosedMenuToMain=True)


def coarse_desktop(b,e,routes):
    """Use Chromium's real coarse-pointer context, never CSS/media injection."""
    context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1024,height=768),
      has_touch=True,storage_state=b.context.storage_state())
    try:
        p=context.new_page(); p.set_default_timeout(10000)
        p.on('pageerror',lambda error:b.errors.append(str(error)))
        visit(p,b,routes['library'])
        assert p.evaluate('matchMedia("(pointer: coarse)").matches')
        header=p.locator('.workspace-desktop-header')
        expect(header).to_be_visible()
        e.capture(p,'1024-coarse-desktop-topbar',coarse=True)
        controls=header.locator('a[href],button,select')
        checked=[]
        for control in controls.all():
            if not control.is_visible():
                continue
            rect=control.bounding_box()
            assert rect and rect['width']>=43.5 and rect['height']>=43.5,dict(name=control.inner_text(),bounds=rect)
            tab_to(p,control)
            checked.append(dict(name=control.get_attribute('aria-label') or control.inner_text().strip(),bounds=rect))
        for selector in ('.workspace-brand','button[aria-label^="Workspaces"]','nav[aria-label="Main navigation"] a'):
            assert header.locator(selector).count(),'Required coarse desktop header control missing: '+selector
        e.capture(p,'1024-coarse-desktop-topbar-focus',coarse=True)
        return dict(pointerCoarse=True,realHasTouchContext=True,minimumTarget=44,keyboardReachable=checked)
    finally:
        context.close()


def focus_stress(b,e,routes):
    """Assert native focus immediately after resize, without capture settlement."""
    p=b.page;rows=[]
    def observed():
        return p.evaluate('''() => ({width:innerWidth,active:{tag:document.activeElement.tagName,id:document.activeElement.id,label:document.activeElement.getAttribute('aria-label')},headerRects:document.querySelector('.workspace-desktop-header').getClientRects().length,menu:[...document.querySelectorAll('button[aria-label="Open navigation"]')].map(el=>({rects:el.getClientRects().length,focused:el===document.activeElement}))})''')
    for attempt in range(1,11):
        p.set_viewport_size(dict(width=1024,height=768));visit(p,b,routes['library'])
        tab_to(p,p.get_by_role('button',name='Account',exact=True))
        expect(p.get_by_role('button',name='Account',exact=True)).to_be_focused()
        row=dict(attempt=attempt,before=observed())
        p.set_viewport_size(dict(width=899,height=768))
        try:
            expect(p.get_by_role('button',name='Open navigation',exact=True)).to_be_focused(timeout=5000)
            row['toMenu']=True
        except Exception as error:
            row['toMenu']=False;row['toMenuError']=str(error)
        row['after899']=observed()
        p.set_viewport_size(dict(width=1024,height=768))
        try:
            expect(p.get_by_role('main')).to_be_focused(timeout=5000)
            row['toMain']=True
        except Exception as error:
            row['toMain']=False;row['toMainError']=str(error)
        row['after1024']=observed();rows.append(row)
        print(f'STRESS {attempt}: menu={row["toMenu"]} main={row["toMain"]}',flush=True)
    result=dict(passed=all(row['toMenu'] and row['toMain'] for row in rows),cycles=10,
      menuPasses=sum(row['toMenu'] for row in rows),mainPasses=sum(row['toMain'] for row in rows),
      method='Native Tab to Account; resize899 then immediate5s focus assertion; resize1024 then immediate5s focus assertion. No screenshots or settling between resize and assertion.',results=rows)
    (e.output/'native-resize-stress.json').write_text(json.dumps(result,indent=2)+'\n')
    assert result['passed'],f'Native resize stress failed: menu {result["menuPasses"]}/10, main {result["mainPasses"]}/10'
    return result


def build_fingerprint():
    """Hash all production outputs so changes behind the server entry are detected."""
    output=ROOT/'apps/console/.output'
    digest=hashlib.sha256()
    for path in sorted(output.rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(output)).encode()+b'\0')
            digest.update(path.read_bytes())
    return digest.hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--baseline',action='store_true')
    parser.add_argument('--only',choices=['all','geometry','focus','focus-stress'],default='all',help='Recheck source geometry or native keyboard breakpoint focus on the unchanged build')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    output=args.output.resolve(); output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Evidence(output,args.baseline)
    w=World(pg_bin(args.pg_bin)); b=None
    build_hash=build_fingerprint();build_hash_after=None
    try:
        w.start(); w.fresh_scenario(SimpleNamespace(effective_tags=[])); w.publish_initial('',files=FILES)
        b=w.browser(); p=b.page
        routes=dict(library=b.workspace_path(),content=b.bundle_path('content'),
          release=b.bundle_path('releases'),appsetup=b.bundle_path('connect'),
          connections=b.workspace_path('connections'),members=b.workspace_path('members'))
        if args.only in ('all','focus') and not args.baseline:
            e.run('keyboard-breakpoint-focus',p,lambda:keyboard_resize(b,e,routes))
        if args.only=='focus-stress':
            e.run('native-keyboard-resize-stress',p,lambda:focus_stress(b,e,routes))
        if args.only=='all' and not args.baseline:
            e.run('coarse-desktop-topbar',p,lambda:coarse_desktop(b,e,routes))
        for width,height in [(1024,768),(1440,900),(1920,1080)]:
            for name in routes:
                if args.only in ('focus','focus-stress'):
                    continue
                def capture(name=name, width=width, height=height):
                    p.set_viewport_size(dict(width=width, height=height))
                    visit(p, b, routes[name])
                    return e.capture(p, f'{width}-{name}')
                e.run(f'{width}-{name}', p, capture)
        assert w.call('GET',w.channel)['version']==w.original['version'],'Release changed during layout review'
        assert not b.errors,b.errors
        build_hash_after=build_fingerprint()
        assert build_hash_after==build_hash,'Console build changed during run'
    except Exception as error:
        e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        w.close()
        summary=dict(passed=not e.failures and (args.baseline or not e.geometry),baseline=args.baseline,
          selection=args.only,
          checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),
          fixture='Private PostgreSQL + real service + existing console build + OIDC/TLS',
          sourceBuildSha256=build_hash,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,
          sourceBuildBeforeSha256=build_hash,sourceBuildAfterSha256=build_hash_after,
          sourceBuildFingerprint='SHA256 of sorted .output relative paths and file bytes',
          releaseUnchanged=not any(row['check']=='fixture-or-invariants' for row in e.failures),
          limits=['Source fixtures only; no provider/model execution.','Desktop fine pointer32px controls plus real coarse-pointer1024px44px controls.','Screenshots capture actual viewport; geometry covers full route DOM.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
