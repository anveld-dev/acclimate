#!/usr/bin/env python3
"""Read-only browser proof of the persisted example workspace on a frozen build.

Uses real Keycloak form sign-in. No state/DOM/focus injection, intercepts, app
writes, models, provider calls, builds or servers. Credentials never leave this
trusted browser consumer, its request bodies, or the existing owner-only file.
"""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import sync_playwright, expect
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    before = build_fingerprint()
    if before != args.expected_build_hash:
        raise RuntimeError('Production output does not match the requested frozen build')
    manifest = json.loads(args.manifest.read_text())
    config = json.loads(args.credentials_file.read_text())
    payment = manifest['bundles']['payments']
    evaluations = payment['drafts'][0]['evaluations']
    improved = next(e for e in evaluations if e['scenario'] == 'improved')
    origin = urlsplit(improved['url'])
    if origin.scheme != 'https' or origin.hostname not in ('localhost','127.0.0.1'):
        raise RuntimeError('Only the existing local example deployment is supported')
    public = f'{origin.scheme}://{origin.netloc}'
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    snapshots = []; errors = []; phase = 'launch'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(ignore_https_errors=True, viewport=dict(width=1440,height=1000))
            page = context.new_page()
            page.set_default_timeout(15000)
            page.on('pageerror',lambda error: errors.append(type(error).__name__))
            phase = 'real-keycloak-sign-in'
            path = improved['url'].removeprefix(public)
            page.goto(public+'/auth/login?'+urlencode(dict(returnTo=path)),wait_until='domcontentloaded')
            expect(page.locator('input[name="username"]')).to_be_visible()
            page.locator('input[name="username"]').fill(config['username'])
            page.locator('input[name="password"]').fill(config['userPassword'])
            page.locator('input[type="submit"],button[type="submit"]').click()
            page.wait_for_url(public+'/**',wait_until='networkidle')
            expect(page.locator('main')).to_be_visible()
            for name, url in [
                ('evaluation-improved',improved['url']),
                ('evaluation-regressed',next(e for e in evaluations if e['scenario']=='regressed')['url']),
                ('evaluation-incomplete',next(e for e in evaluations if e['scenario']=='incomplete')['url']),
                ('evaluation-task-failed-zero',next(e for e in evaluations if e['scenario']=='task-failed')['url']),
                ('evaluation-runs-no-evidence',next(e for e in evaluations if e['scenario']=='requested')['url']),
                ('payment-content',payment['contentUrl']),
                ('payment-changes',public+f'/w/{manifest["projectId"]}/bundles/{payment["id"]}/changes?channel=stable'),
                ('payment-draft',payment['drafts'][0]['url']),
                ('payment-releases',public+f'/w/{manifest["projectId"]}/bundles/{payment["id"]}/channels/stable/releases'),
                ('app-setup-typescript',public+f'/w/{manifest["projectId"]}/bundles/{payment["id"]}/channels/stable/connect'),
                ('app-setup-python',public+f'/w/{manifest["projectId"]}/bundles/{payment["id"]}/channels/stable/connect'),
                ('workspace-bundles',public+f'/w/{manifest["projectId"]}/bundles'),
                ('workspace-members',public+f'/w/{manifest["projectId"]}/settings/members'),
                ('workspace-connections',public+f'/w/{manifest["projectId"]}/connections'),
            ]:
                phase = name
                response = page.goto(url,wait_until='networkidle')
                if not response or response.status != 200:
                    raise RuntimeError('Seeded route did not return HTTP 200')
                expect(page.locator('main h1')).to_be_visible()
                if name=='app-setup-python':
                    # Highlighting runs after hydration. Wait for the actual
                    # client surface before changing its native language toggle.
                    expect(page.get_by_label('TypeScript delivery recipe',exact=True)).to_have_attribute('data-highlighted','true')
                    python = page.get_by_role('radio',name='Python',exact=True)
                    python.click()
                    expect(python).to_have_attribute('aria-checked','true')
                if name.startswith('app-setup'):
                    language='Python' if name.endswith('python') else 'TypeScript'
                    expect(page.get_by_label(language+' delivery recipe',exact=True)).to_have_attribute('data-highlighted','true')
                if name=='payment-draft':expect(page.get_by_role('textbox',name='Content',exact=True)).to_have_attribute('contenteditable','true')
                page.evaluate('async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}')
                page.wait_for_timeout(300)
                geometry = page.evaluate('''()=>({viewportWidth:innerWidth,viewportHeight:innerHeight,pageWidth:document.documentElement.scrollWidth,scrollY,heading:document.querySelector('main h1')?.textContent,visibleSimulationNote:[...document.querySelectorAll('.evaluation-history-example,.evaluation-example-note')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&/simulated example/i.test(e.textContent||''))})''')
                if name.startswith('evaluation') and not geometry['visibleSimulationNote']:
                    raise RuntimeError('Simulated evidence attribution is missing')
                if geometry['pageWidth'] > geometry['viewportWidth']+1:
                    raise RuntimeError('Seeded route has horizontal overflow')
                page.screenshot(path=str(args.output/(name+'.png')),full_page=False)
                snapshots.append(dict(name=name,url=url,geometry=geometry))
            for name,button,role,label in [
                ('workspace-switcher','Workspaces','menu',''),
                ('account-dialog','Account','dialog','Your account'),
            ]:
                phase = name
                page.get_by_role('button',name=button,exact=True).click()
                overlay = page.get_by_role(role,name=label,exact=True) if label else page.get_by_role(role)
                expect(overlay).to_be_visible()
                page.wait_for_timeout(250)
                page.screenshot(path=str(args.output/(name+'.png')),full_page=False)
                snapshots.append(dict(name=name,url=page.url,visibleOverlayRole=role))
                page.keyboard.press('Escape')
                expect(overlay).to_have_count(0)
            context.close();browser.close()
        after = build_fingerprint()
        if before != after: raise RuntimeError('Production output changed during captures')
        if errors: raise RuntimeError('Browser reported an application error')
        summary = dict(passed=True,buildSha256=before,sourceBuildAfterSha256=after,capturedStates=len(snapshots),states=snapshots,browserErrors=0,appWrites=0,providerCalls=0,paidModelCalls=0,realOidcLogin=True,authOrStorageInjection=False)
        (args.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2));return 0
    except Exception as error:
        # Browser diagnostics can include field values or OIDC redirect codes.
        # Record only the stage and error type, never raw automation diagnostics.
        summary = dict(passed=False,phase=phase,errorType=type(error).__name__,capturedStates=len(snapshots),states=snapshots,geometry=locals().get('geometry'))
        if phase != 'real-keycloak-sign-in' and 'page' in locals() and not page.is_closed():
            try: page.screenshot(path=str(args.output/'diagnostic-failure.png'),full_page=False)
            except Exception: pass
        (args.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2),file=sys.stderr);return 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-build-hash',required=True)
    parser.add_argument('--manifest',type=Path,default=ROOT/'.local/example-workspace.json')
    parser.add_argument('--credentials-file',type=Path,default=ROOT/'.local/keycloak-stack/credentials.json')
    parser.add_argument('--output',type=Path,required=True)
    return run(parser.parse_args())


if __name__=='__main__':raise SystemExit(main())
