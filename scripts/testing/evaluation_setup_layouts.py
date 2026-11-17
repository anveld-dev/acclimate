#!/usr/bin/env python3
"""Evaluation authoring on disposable PostgreSQL/OIDC; never executes a model."""
import argparse,json,re,sys
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.bdd.layout import capture_layout
from scripts.bdd.editor import editor_value,expect_editor_value
from scripts.testing.compact_console import FILES,visit,improvement_server_function_path,server_function_action
from scripts.testing.desktop_layouts import build_fingerprint


def configuration(count=3):
    return dict(datasetRevision='receipt-fixture-v7',graderRevision='receipt-grader-v3',runtime=dict(configId='installed-fixture',configRevision='opaque-revision-42',model='none',writes='disabled'),expectedCases=[dict(caseId='case-'+str(i//2),repetition=i%2) for i in range(count)])


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    def record(value):checks.append(value);print('PASS '+value,flush=True)
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
        w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nKeep the original receipt.\n') for f in FILES])))
        b=w.browser();p=b.page;route_path=b.bundle_path('changes',candidate=w.draft['snapshotVersion']['id'])
        section=p.get_by_role('region',name='Create evaluation request',exact=True)
        profile=section.get_by_label('Evaluation configuration',exact=True)
        editor=section.get_by_label('Public evaluator configuration (JSON)',exact=True).filter(visible=True)
        trigger=section.locator('h2 > [data-slot=disclosure-trigger]')
        create=section.get_by_role('button',name='Create evaluation request',exact=True)
        preview=section.locator('.evaluation-setup-preview')
        for width in (1440,1024,390,320):
            p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route_path)
            expect(profile).to_be_visible();assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            capture_layout(p,out,f'first-setup-{width}')
            if args.verify:
                expect(profile).to_have_value('')
                expect(create).to_be_disabled()
                expect(preview.locator('dl')).to_have_count(0)
                assert section.evaluate('e=>e.getBoundingClientRect().width>document.querySelector(".evaluation-workspace").getBoundingClientRect().width-4')
            record(f'First setup fits {width}px')
        p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,route_path)
        for value,count in [('payment-retry',6),('presence-contract',4),('codex-luna-review',2)]:
            profile.select_option(value)
            if args.verify:expect(preview.locator('dd').first).to_have_text(str(count))
            capture_layout(p,out,'profile-'+value)
            assert w.call('GET',w.bundle+'/evaluation-requests')['items']==[]
        record('Preset selections show exact 6/4/2 expected pairs without submitting or executing')
        profile.select_option('custom');editor.fill('{')
        expect(create).to_be_disabled();expect(section.get_by_role('alert')).to_be_visible()
        if args.verify:
            expect(editor).to_have_attribute('aria-invalid','true')
            assert editor.evaluate('e=>e.getAttribute("aria-describedby").split(" ").every(id=>document.getElementById(id))')
            expect(preview.locator('dl')).to_have_count(0)
        capture_layout(p,out,'custom-invalid')
        duplicate=configuration();duplicate['expectedCases']=[dict(caseId='same',repetition=0)]*2
        editor.fill(json.dumps(duplicate));expect(create).to_be_disabled();expect(section.get_by_role('alert')).to_contain_text('Invalid public evaluation configuration')
        too_many=configuration(1001);editor.fill(json.dumps(too_many));expect(create).to_be_disabled();expect(section.get_by_role('alert')).to_contain_text('Invalid public evaluation configuration')
        editor.focus();p.keyboard.press('ControlOrMeta+A');p.keyboard.press('Backspace');p.keyboard.press('Enter');p.keyboard.insert_text(' ');expect_editor_value(editor,'\n ')
        valid=configuration();text=' \n'+json.dumps(valid,indent=2)+'\n\n';editor.fill(text)
        expect(create).to_be_enabled();expect_editor_value(editor,text)
        if args.verify:
            expect(editor).to_have_attribute('aria-invalid','false');expect(preview.locator('dd').first).to_have_text('3')
        profile.select_option('payment-retry');profile.select_option('custom');expect_editor_value(editor,text)
        capture_layout(p,out,'custom-valid-desktop')
        editor.focus();p.keyboard.press('Tab');expect(preview).to_be_focused();p.keyboard.press('Tab');expect(create).to_be_focused()
        trigger.click();expect(editor).to_be_hidden();trigger.focus();p.keyboard.press('Tab');assert not section.locator('[data-slot=disclosure-content]').evaluate('e=>e.contains(document.activeElement)')
        trigger.click();expect_editor_value(editor,text)
        record('Malformed, duplicate and oversized configs block create; correction updates accessible error and exact uneven-pair preview; switching/folding retain text and Tab exits')
        large=configuration(1000);large['datasetRevision']='long-public-dataset-'+('retained-'*30)
        large_text=json.dumps(large,indent=2);editor.focus();p.keyboard.press('ControlOrMeta+A');p.keyboard.insert_text(large_text);expect_editor_value(editor,large_text);expect(create).to_be_enabled()
        for width in (1440,1024,390,320):
            p.set_viewport_size(dict(width=width,height=1000));expect_editor_value(editor,large_text)
            assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            if args.verify:
                geometry=section.evaluate('e=>({width:e.clientWidth,columns:getComputedStyle(e.querySelector(".evaluation-setup-grid")).gridTemplateColumns.split(" ").length,editor:e.querySelector(".code-editor").getBoundingClientRect().height,author:e.querySelector(".evaluation-setup-author").getBoundingClientRect().width})')
                assert geometry['editor']<=320,geometry
                assert preview.evaluate('e=>e.getBoundingClientRect().height<=320'), geometry
                if geometry['columns']==2:assert geometry['author']>=600,geometry
                expect(preview.locator('dd').first).to_have_text('1000')
                assert editor.locator('.cm-syntax-string').count()>0 or editor.locator('..').locator('.cm-syntax-string').count()>0
            capture_layout(p,out,f'large-custom-{width}')
        p.set_viewport_size(dict(width=1440,height=1000));section.evaluate("e=>e.style.width='430px'")
        if args.verify:
            assert section.locator('.evaluation-setup-grid').evaluate('e=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==1
            assert section.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        capture_layout(p,out,'embedded-430');section.evaluate("e=>e.style.width=''")
        record('1000-pair JSON stays bounded with syntax highlighting, exact count, long revisions and container reflow')
        editor.fill(text)
        p.get_by_role('navigation',name='Bundle navigation').get_by_role('link',name='Releases',exact=True).click()
        guard=p.get_by_role('alertdialog',name='Leave current edits?',exact=True)
        expect(guard).to_be_visible();capture_layout(p,out,'dirty-navigation-guard');guard.get_by_role('button',name='Keep editing',exact=True).click();expect_editor_value(editor,text)
        record('Dirty navigation cancellation keeps exact JSON without creating a request')
        if args.verify:
            create.focus();p.keyboard.press('Enter')
            expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
            request=w.call('GET',w.bundle+'/evaluation-requests')['items'][0]
            assert request['requireBoundEvidence'] and request['status']=='requested'
            for key,value in valid.items():assert request[key]==value,(key,request[key],value)
            article=p.get_by_label('Evaluation request '+request['id'],exact=True)
            request_trigger=article.get_by_role('button',name=re.compile('^Evaluation request details for'))
            # Exact accessible wording belongs to the shared label helper.
            if not request_trigger.count():request_trigger=article.locator('.evaluation-request-row [data-slot=disclosure-trigger]')
            expect(request_trigger).to_be_focused()
            expect(trigger).to_have_attribute('aria-expanded','false')
            capture_layout(p,out,'another-request-collapsed')
            article.get_by_role('button',name='Copy request ID',exact=True).click();assert p.evaluate('navigator.clipboard.readText()')==request['id']
            article.get_by_role('button',name='Copy configuration',exact=True).click();handoff=json.loads(p.evaluate('navigator.clipboard.readText()'));assert handoff['requestId']==request['id'] and handoff['configuration']==valid
            trigger.click();editor.fill(json.dumps(configuration(7)))
            article.get_by_role('button',name='Copy configuration',exact=True).click();assert json.loads(p.evaluate('navigator.clipboard.readText()'))['configuration']==valid
            capture_layout(p,out,'created-frozen-custom-handoff')
            assert w.call('GET',w.bundle+'/comparisons')['items']==[]
            assert w.call('GET',w.bundle+'/evaluation-requests/'+request['id'])==request
            record('Created custom request freezes exact validated settings, focuses confirmed request and starts another setup closed; later edits cannot change copied configuration')
            dropped=[]
            pattern='**'+improvement_server_function_path()+'*'
            def lose_confirmation(route):
                body=route.request.post_data_json if route.request.method=='POST' else None
                if not dropped and server_function_action(body)=='submitFrozen':
                    response=route.fetch();assert response.ok;dropped.append(True);route.abort('failed')
                else:route.continue_()
            p.route(pattern,lose_confirmation)
            try:
                create.click();expect(p.get_by_role('button',name='Check result',exact=True)).to_be_enabled()
            finally:p.unroute(pattern,lose_confirmation)
            assert dropped
            expect(profile).to_be_disabled();expect(create).to_be_disabled()
            trigger.click();expect(trigger).to_have_attribute('aria-expanded','false')
            expect(section.locator('.evaluation-setup-blocked-reason')).to_contain_text('not been confirmed')
            capture_layout(p,out,'unconfirmed-operation-setup-collapsed')
            assert len(w.call('GET',w.bundle+'/evaluation-requests')['items'])==2
            p.get_by_role('button',name='Check result',exact=True).click()
            expect(p.get_by_role('region',name='Unconfirmed operation',exact=True)).to_have_count(0)
            assert len(w.call('GET',w.bundle+'/evaluation-requests')['items'])==2
            trigger.click();expect(profile).to_be_enabled();expect_editor_value(editor,json.dumps(configuration(7)))
            record('Lost successful submission confirmation blocks a new request and remains visible while folded; checking the exact result recovers once without duplicate creation')
            # Force the existing editor loading fallback through the real browser asset boundary.
            fallback_context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1024,height=1000))
            try:
                b.sign_in(fallback_context)
                fallback_context.route('**/assets/code-editor-engine-*.js',lambda route:route.abort('failed'))
                fp=fallback_context.new_page();visit(fp,b,route_path)
                fs=fp.get_by_role('region',name='Create evaluation request',exact=True)
                fs.locator('h2 > [data-slot=disclosure-trigger]').click()
                fs.get_by_label('Evaluation configuration',exact=True).select_option('custom')
                expect(fs.get_by_text('Syntax editor unavailable. Plain-text editing is available.',exact=True)).to_be_visible()
                fallback=fs.get_by_label('Public evaluator configuration (JSON)',exact=True).filter(visible=True)
                fallback.fill('{');expect(fallback).to_have_attribute('aria-invalid','true')
                assert fallback.evaluate('e=>e.getAttribute("aria-describedby").split(" ").every(id=>document.getElementById(id))')
                fallback.fill(text);expect(fallback).to_have_attribute('aria-invalid','false');expect_editor_value(fallback,text)
                capture_layout(fp,out,'plain-text-fallback-validation')
            finally:fallback_context.close()
            record('Blocked editor chunk uses plain-text fallback with associated error, corrected invalid state and exact input')
            w.sign_in('viewer','evaluation-setup-reader')
            w.call('PUT',w.root+'/memberships/'+w.sessions['viewer']['userId'],dict(role='viewer'),actor='_browser-operator')
            readonly=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1440,height=1000))
            try:
                b.sign_in(readonly,'evaluation-setup-reader');rp=readonly.new_page();visit(rp,b,route_path)
                rs=rp.get_by_role('region',name='Create evaluation request',exact=True)
                expect(rs.locator('.evaluation-setup-blocked-reason')).to_contain_text('read-only')
                expect(rs.locator('h2 > [data-slot=disclosure-trigger]')).to_have_attribute('aria-expanded','false')
                rs.locator('h2 > [data-slot=disclosure-trigger]').click();expect(rs.get_by_role('button',name='Create evaluation request',exact=True)).to_be_disabled()
                capture_layout(rp,out,'read-only-setup-reason')
            finally:readonly.close()
            alternative=w.call('POST',w.bundle+'/versions',dict(parentVersionId=w.original['version']['id'],payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+' Different current parent.') for f in FILES])))
            w.call('POST',w.channel+'/promotions',dict(versionId=alternative['id'],expectedRevision=w.original['revision'],unevaluatedReason='Advance disposable evaluation setup fixture.'))
            # The successful recovery accepted the current form, so leaving doesn't discard edits.
            visit(p,b,route_path);expect(section.locator('.evaluation-setup-blocked-reason')).to_contain_text('current release')
            trigger.click();expect(create).to_be_disabled();capture_layout(p,out,'stale-parent-setup-reason')
            record('Read-only and stale-parent gates explain themselves even when setup starts folded and prevent submission')

        assert not b.errors,b.errors;assert before==build_fingerprint()
        summary=dict(passed=True,checks=checks,browserErrors=b.errors,sourceBuildSha256=before,modelCalls=0,limits=['Disposable PostgreSQL/OIDC. No native/live model execution.','Native screen readers and actual browser zoom are untested.','Only the listed interactions and separate selected BDD scenarios are qualified.'])
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
            (out/'failure-accessibility.txt').write_text(w.browser_fixture.page.locator('main').aria_snapshot())
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path)
    mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--capture-only',action='store_true');mode.add_argument('--verify',action='store_true');run(parser.parse_args())
