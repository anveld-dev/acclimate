#!/usr/bin/env python3
"""Qualify immutable content inspection on disposable PostgreSQL/OIDC; no models."""
import argparse
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import FILES, select_release, visit
from scripts.testing.desktop_layouts import build_fingerprint

EXPORTED = 'First nested duplicate.\r\nUnicode: café, 日本語, résumé.\r\n\r\n'
LONG_PATH = 'skills/team/references/' + 'longname' * 12 + '.md'
FILES14 = FILES + [dict(path=p, kind='skill', text=t) for p, t in [
    ('skills/a/references/shared.md', EXPORTED),
    ('skills/b/references/shared.md', 'Second nested duplicate.\nUnique content needle.\n'),
    ('skills/a/references/data.json', '{\n  "message": "hello"\n}\n'),
    ('skills/a/references/code.py', 'print("hello")\n'),
    (LONG_PATH, 'Unicode content: café, 日本語, résumé.\n'),
    ('skills/a/references/long.md', 'Long content line.\n' * 500)]]


def seed(w):
    w.start(); w.fresh_scenario(SimpleNamespace(effective_tags=[])); w.publish_initial('', files=FILES14)
    current = w.call('GET', w.channel)
    version = w.call('POST', w.bundle + '/versions', dict(parentVersionId=current['version']['id'], payload=dict(schemaVersion=1, files=[dict(f, text=f['text']+'\nRevision two.\n') for f in FILES14])))
    w.call('POST', w.channel+'/releases', dict(versionId=version['id'], expectedRevision=current['revision'], unevaluatedReason='Disposable historical inspection fixture.'))


def read_endpoint():
    ids=set()
    for p in (ROOT/'apps/console/.output/server/_ssr').glob('read-console-*.mjs'):
        ids.update(re.findall(r'id:\s*"([a-f0-9]+)",\s*name:\s*"readStoredVersion"',p.read_text()))
    assert len(ids)==1,'Cannot identify the frozen version-read transport'
    return '/_serverFn/'+ids.pop()


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[];mutations=[]
    def record(text):checks.append(text);print('PASS '+text,flush=True)
    try:
        seed(w);current=w.call('GET',w.channel);b=w.browser();p=b.page
        p.on('request',lambda r:mutations.append(dict(method=r.method,path=urlsplit(r.url).path)) if r.method in ('POST','PUT','PATCH','DELETE') else None)
        d=p.get_by_role('dialog',name='Version content',exact=True)
        def trigger(revision=1):
            select_release(p, revision)
            return p.get_by_role('button',name='Inspect content for revision '+str(revision),exact=True)
        def open_dialog(revision=1):
            trigger(revision).click();expect(d.get_by_label('Content of AGENTS.md',exact=True)).to_have_text(FILES[0]['text'] if revision==1 else FILES[0]['text']+'\nRevision two.\n')
        def files_open():
            t=d.get_by_role('button',name='Files',exact=True)
            if t.is_visible() and t.get_attribute('aria-expanded')=='false':t.click()
        def leaf(path):return d.get_by_role('treeitem',name='Open '+path,exact=True)
        def choose(path):
            files_open();leaf(path).click();expect(d.get_by_label('Content of '+path,exact=True)).to_be_visible()
        def shot(name):p.screenshot(path=str(out/(name+'.png')),full_page=True)
        def bounds():
            r=d.bounding_box();v=p.viewport_size
            assert r and r['x']>=-1 and r['y']>=-1 and r['x']+r['width']<=v['width']+1 and r['y']+r['height']<=v['height']+1,r
            assert d.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            return d.locator('.version-inspector-workspace').evaluate('e=>({width:e.clientWidth,compact:e.querySelector(".file-navigator").dataset.compact})')
        for width in (1440,1024,390,320):
            p.set_viewport_size(dict(width=width,height=900));visit(p,b,b.bundle_path('releases'));open_dialog()
            if args.verify:
                g=bounds();assert (g['compact']=='true')==(g['width']<=899),g
                expect(d.get_by_role('button',name='Download',exact=True)).to_be_visible()
                assert d.locator('.version-inspector-source').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)>=14')
            shot('inspector-'+str(width));files_open();choose('skills/b/references/shared.md')
            expect(d.get_by_label('Content of skills/b/references/shared.md',exact=True)).to_have_text(FILES14[5]['text'])
            shot('nested-'+str(width));p.keyboard.press('Escape');expect(trigger()).to_be_focused()
            record(f'Historical tree/source fit {width}px and nested selection returns focus on Escape')
        p.set_viewport_size(dict(width=1440,height=900));open_dialog();files_open()
        search=d.get_by_label('Find a version entry',exact=True)
        choose('skills/a/references/shared.md');search.fill('unique content needle')
        expect(leaf('skills/b/references/shared.md')).to_have_attribute('aria-selected','true')
        expect(search).to_be_focused();expect(d.get_by_label('Content of skills/b/references/shared.md')).to_have_text(FILES14[5]['text'])
        d.get_by_role('button',name='Clear search',exact=True).click();expect(search).to_be_focused()
        expect(leaf('skills/a/references/shared.md')).to_have_attribute('aria-selected','true')
        search.fill('no-such-entry-xyz');expect(d.get_by_role('treeitem')).to_have_count(0)
        expect(d.locator('.version-inspector-source')).to_have_count(0);expect(d.get_by_role('button',name='Download',exact=True)).to_have_count(0)
        expect(d.get_by_text('No entries match your search. Try another word or clear the search.',exact=True)).to_be_visible();shot('no-results')
        d.get_by_role('button',name='Clear search',exact=True).click();expect(search).to_be_focused()
        choose('AGENTS.md');folder=d.get_by_role('treeitem',name='Folder skills',exact=True);folder.click();expect(folder).to_have_attribute('aria-expanded','false')
        search.fill('unique content needle');expect(leaf('skills/b/references/shared.md')).to_be_visible()
        d.get_by_role('button',name='Clear search',exact=True).click();expect(folder).to_have_attribute('aria-expanded','false')
        folder.focus();p.keyboard.press('ArrowRight');expect(folder).to_have_attribute('aria-expanded','true');p.keyboard.press('ArrowRight')
        assert d.get_by_role('tree').evaluate('e=>e.contains(document.activeElement)')
        p.keyboard.press('Home');expect(folder).to_be_focused();p.keyboard.press('End');expect(leaf('AGENTS.md')).to_be_focused()
        p.keyboard.press('Space');expect(leaf('AGENTS.md')).to_have_attribute('aria-selected','true')
        folder.focus();p.keyboard.press('m');expect(d.get_by_role('treeitem',name='Folder memory',exact=True)).to_be_focused()
        record('Path/content filtering, temporary fallback, explicit selection, no-results, saved folds and tree keyboard navigation agree')
        choose(LONG_PATH);expect(d.locator('.version-inspector-file-header')).to_contain_text(LONG_PATH);shot('long-path')
        choose('skills/a/references/data.json');expect(d.get_by_label('Content of skills/a/references/data.json')).to_have_attribute('data-highlighted','true');shot('json-source')
        choose('skills/a/references/shared.md');source=d.get_by_label('Content of skills/a/references/shared.md',exact=True);expect(source).to_have_text(EXPORTED,use_inner_text=False);assert source.text_content()==EXPORTED
        copy=d.get_by_role('button',name='Copy content',exact=True);copy.focus();expect(p.get_by_role('tooltip').filter(has_text='Copy content')).to_be_visible()
        p.keyboard.press('Escape');expect(d).to_be_visible();p.keyboard.press('Tab');d.get_by_role('heading',name='Version content',exact=True).hover();copy.hover();expect(p.get_by_role('tooltip').filter(has_text='Copy content')).to_be_visible();copy.click();assert p.evaluate('navigator.clipboard.readText()')==EXPORTED
        with p.expect_download() as downloaded:d.get_by_role('button',name='Download',exact=True).click()
        download=downloaded.value;assert download.suggested_filename=='shared.md';path=out/'export-shared.md';download.save_as(str(path));assert path.read_bytes()==EXPORTED.encode('utf-8')
        details=d.get_by_role('button',name='Version details',exact=True);details.click()
        for key in ('id','digest'):expect(d.locator('.version-inspector-metadata')).to_contain_text(w.original['version'][key])
        d.get_by_role('button',name='Copy digest',exact=True).click();assert p.evaluate('navigator.clipboard.readText()')==w.original['version']['digest'];shot('metadata-expanded');details.click()
        cdp=p.context.new_cdp_session(p);permission=dict(permission=dict(name='clipboard-write'),origin=b.base,browserContextId=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId'])
        try:
            cdp.send('Browser.setPermission',dict(permission,setting='denied'));copy.click()
            expect(d.get_by_role('status').filter(has_text='Clipboard unavailable.')).to_be_visible();expect(source).to_have_text(EXPORTED,use_inner_text=False);shot('clipboard-denied')
        finally:cdp.send('Browser.setPermission',dict(permission,setting='granted'));cdp.detach()
        record('Syntax enhancement, full metadata, tooltip Escape, exact Unicode/CRLF clipboard text and UTF-8 download, and clipboard denial preserve source')
        p.keyboard.press('Escape');open_dialog(2);d.get_by_role('button',name='Version details',exact=True).click()
        expect(d.locator('.version-inspector-metadata')).to_contain_text(w.original['version']['id']);p.keyboard.press('Escape')
        open_dialog();files_open();leaf('AGENTS.md').focus();p.set_viewport_size(dict(width=390,height=900))
        toggle=d.get_by_role('button',name='Files',exact=True);expect(toggle).to_be_focused();expect(toggle).to_have_attribute('aria-expanded','false')
        toggle.click();leaf('AGENTS.md').click();expect(toggle).to_have_attribute('aria-expanded','true')
        search.fill('unique content needle');search.fill('');expect(toggle).to_have_attribute('aria-expanded','true')
        leaf('skills/b/references/shared.md').click();expect(toggle).to_have_attribute('aria-expanded','false');expect(toggle).to_be_focused();shot('compact-selection')
        for width,height in ((320,900),(1024,420)):
            p.set_viewport_size(dict(width=width,height=height));d.get_by_role('button',name='Version details',exact=True).click();files_open();bounds();shot(f'expanded-{width}-{height}')
            choose(LONG_PATH);bounds();d.get_by_role('button',name='Download',exact=True).scroll_into_view_if_needed();expect(d.get_by_role('button',name='Download',exact=True)).to_be_in_viewport()
            d.get_by_role('button',name='Version details',exact=True).click()
        p.set_viewport_size(dict(width=1440,height=900));d.evaluate('e=>e.style.width="430px"');files_open();bounds();shot('embedded-430');d.evaluate('e=>e.style.width=""');p.keyboard.press('Escape')
        record('Measured compact mode, unchanged activation/search, committed selection, reflow focus, expanded metadata, embedded and low-height controls remain reachable')
        endpoint=read_endpoint();held=[]
        def hold(route):held.append(route)
        pattern='**'+endpoint+'*';p.route(pattern,hold)
        try:
            for old_fails in (False,True):
                held.clear()
                for _ in range(2):
                    with p.expect_request(lambda r:urlsplit(r.url).path==endpoint):trigger().click()
                    expect(d.get_by_role('status').filter(has_text='Loading version…')).to_be_visible()
                    expect(d.get_by_role('treeitem')).to_have_count(0)
                    if len(held)==1:p.keyboard.press('Escape')
                assert len(held)==2
                if old_fails:
                    held[1].fulfill(response=held[1].fetch());expect(d.get_by_label('Content of AGENTS.md')).to_have_text(FILES[0]['text'])
                    held[0].fulfill(status=500,body='{}',content_type='application/json')
                else:
                    held[1].fulfill(status=500,body='{}',content_type='application/json');expect(d.get_by_role('alert')).to_be_visible();expect(d.get_by_role('treeitem')).to_have_count(0)
                    held[0].fulfill(response=held[0].fetch())
                p.wait_for_timeout(100)
                if old_fails:expect(d.get_by_label('Content of AGENTS.md')).to_have_text(FILES[0]['text'])
                else:expect(d.get_by_role('alert')).to_be_visible();shot('read-failure')
                p.keyboard.press('Escape')
        finally:
            p.unroute(pattern,hold)
            for route in held:
                try:route.abort()
                except Exception:pass
        # Fail once, then use the visible Retry with the actual scoped read.
        failed=[]
        def fail_once(route):
            if not failed:failed.append(True);route.abort('failed')
            else:route.continue_()
        p.route(pattern,fail_once)
        try:
            trigger().click();expect(d.get_by_role('alert')).to_be_visible();d.get_by_role('button',name='Retry',exact=True).click();expect(d.get_by_label('Content of AGENTS.md')).to_have_text(FILES[0]['text']);p.keyboard.press('Escape')
        finally:p.unroute(pattern,fail_once)
        record('Whole-version loading/failure/retry and out-of-order success/failure across close/reopen never expose stale inventory')
        assert not mutations,mutations;after=w.call('GET',w.channel);assert after['revision']==current['revision'] and after['version']['id']==current['version']['id']
        assert not b.errors,b.errors;assert before==build_fingerprint(),'Build changed'
        summary=dict(passed=True,checks=checks,modelCalls=0,browserErrors=b.errors,sourceBuildSha256=before,limits=['Only listed assertions exercised; native zoom and screen readers untested.','Empty versions and non-ASCII paths are rejected by production payload validation; no synthetic empty service result was claimed.','Same mounted scope/version prop replacement is source-reviewed through keyed reset, not driven by a production UI control.'])
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
    except BaseException as error:
        if getattr(w,'browser_fixture',None) and not w.browser_fixture.page.is_closed():w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    a=argparse.ArgumentParser(description=__doc__);a.add_argument('--pg-bin');a.add_argument('--output',type=Path,required=True);a.add_argument('--verify',action='store_true',help='Run full qualification (all runs use the current component contract)');run(a.parse_args())
