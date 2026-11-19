#!/usr/bin/env python3
"""Record actual console interaction states against disposable real infrastructure.

--baseline records regressions as observations. The default run asserts the
intended behavior. Neither mode builds the console or calls a model provider.
"""
import re
import argparse
import base64
import struct
import json
import sys
import tempfile
import traceback
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.interactions import close_draft_details
from scripts.bdd.editor import editor_value
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.interactions import open_files, open_details, draft_action
from scripts.bdd.layout import inspect_layout, tab_to
from scripts.testing.compact_console import FILES, visit


class Evidence:
    def __init__(self, output, baseline):
        self.output, self.baseline = output, baseline
        self.states, self.checks, self.failures = [], [], []
        self.cdp = None

    def check(self, name, condition, details=None):
        row = dict(check=name, passed=bool(condition), details=details)
        self.checks.append(row)
        if not condition:
            print(('OBSERVED ' if self.baseline else 'FAIL ') + name, flush=True)
            if not self.baseline:
                self.failures.append(row)

    def capture(self, page, name, coarse=False):
        # Read-only inspection; no DOM, focus, storage or application-state injection.
        page.evaluate('''async () => { await Promise.all(document.getAnimations().filter(a => a.playState==='running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{}))); }''')
        metrics = inspect_layout(page, coarse=coarse)
        metrics['interaction'] = page.evaluate('''() => {
          const r=el=>{const b=el.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};
          const visible=el=>el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
          return {focus:{tag:document.activeElement?.tagName,id:document.activeElement?.id,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.trim().slice(0,90)},
          dialogs:[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(visible).map(el=>({bounds:r(el),kind:el.getAttribute('data-slot'),title:el.querySelector('[data-slot=dialog-title],[data-slot=alert-dialog-title],h2')?.textContent,buttons:[...el.querySelectorAll('button')].filter(visible).map(b=>({name:b.textContent.trim()||b.getAttribute('aria-label'),bounds:r(b)}))})),
          menus:[...document.querySelectorAll('[role=menuitem]')].filter(visible).map(el=>({name:el.textContent.trim(),bounds:r(el)})),
          fieldErrors:[...document.querySelectorAll('[aria-invalid=true]')].filter(visible).map(el=>({id:el.id,describedby:el.getAttribute('aria-describedby')})),
          headings:[...document.querySelectorAll('main h1,main h2')].filter(visible).map(el=>({text:el.textContent.trim(),bounds:r(el)})),
          headingActionOverlaps:[...document.querySelectorAll('.page-heading h1')].filter(visible).flatMap(h=>[...h.closest('.page-heading').querySelectorAll('.page-actions button,.page-actions a')].filter(visible).filter(b=>{const range=document.createRange();range.selectNodeContents(h);const a=range.getBoundingClientRect(),c=b.getBoundingClientRect();return Math.min(a.right,c.right)-Math.max(a.left,c.left)>1 && Math.min(a.bottom,c.bottom)-Math.max(a.top,c.top)>1}).map(b=>({heading:h.textContent.trim(),button:b.textContent.trim(),headingBounds:r(h),buttonBounds:r(b)}))),
          dpr:devicePixelRatio}; }''')
        (self.output / (name + '.json')).write_text(json.dumps(metrics, indent=2)+'\n')
        # This applies even to disposable fixture credentials. Never store raw DOM.
        sensitive=page.locator('[data-sensitive=true], [aria-label="One-time credential secret"]')
        if self.cdp:
            # Chrome native zoom requires physical-pixel CDP capture. Playwright's
            # screenshot viewport path crops the bitmap at the unscaled CSS size.
            assert not sensitive.filter(visible=True).count(), 'Native capture cannot include a visible secret'
            bitmap=base64.b64decode(self.cdp.send('Page.captureScreenshot',dict(format='png',fromSurface=True))['data'])
            (self.output/(name+'.png')).write_bytes(bitmap)
            pixels=struct.unpack('>II',bitmap[16:24])
            metrics['nativeScreenshotPixels']=list(pixels)
            self.check(name+'-physical-screenshot-width',pixels[0]==round(metrics['viewport']*metrics['interaction']['dpr']),dict(pixels=pixels,dpr=metrics['interaction']['dpr']))
            (self.output/(name+'.json')).write_text(json.dumps(metrics,indent=2)+'\n')
        else:
            page.screenshot(path=str(self.output / (name + '.png')), full_page=False,mask=[sensitive])
        self.states.append(dict(name=name, viewport=metrics['viewport'], coarse=coarse,
                                nativeDpr=metrics['interaction']['dpr']))
        self.check(name+'-no-page-overflow', metrics['width'] <= metrics['viewport']+1,
                   dict(viewport=metrics['viewport'], width=metrics['width']))
        self.check(name+'-heading-actions-do-not-overlap',not metrics['interaction']['headingActionOverlaps'],metrics['interaction']['headingActionOverlaps'])
        for i, dialog in enumerate(metrics['interaction']['dialogs']):
            bounds=dialog['bounds']
            self.check(name+f'-dialog-{i}-gutter', dialog.get('kind')=='sheet-content' or bounds['left']>=15 and bounds['right']<=metrics['viewport']-15,
                       bounds)
            bad=[b for b in dialog['buttons'] if b['bounds']['left']<bounds['left']-1 or b['bounds']['right']>bounds['right']+1]
            self.check(name+f'-dialog-{i}-buttons-contained', not bad, bad)
        print('CAPTURE '+name, flush=True)
        return metrics

    def run(self, name, page, fn):
        try:
            fn()
        except Exception as error:
            row=dict(check=name, error=str(error), traceback=traceback.format_exc())
            self.failures.append(row)
            print('ERROR '+name+': '+str(error), flush=True)
            try:
                self.capture(page,name+'-interrupted')
            except Exception:
                pass


def escape(e, page, trigger, name):
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    expect(page.get_by_role('menu')).to_have_count(0)
    try:
        expect(trigger).to_be_focused()
        focused=True
    except AssertionError:
        focused=False
    e.check(name+'-escape-restores-trigger', focused, page.evaluate('({tag:document.activeElement?.tagName,id:document.activeElement?.id,text:document.activeElement?.textContent?.trim().slice(0,80)})'))


def content(w,b,p,e,prefix,coarse):
    visit(p,b,b.bundle_path('content',path='memory/team.md'))
    e.capture(p,prefix+'-published-collapsed',coarse)
    if p.get_by_role('button',name='Files',exact=True).is_visible():
        open_files(p);e.capture(p,prefix+'-published-files-open',coarse)
        p.get_by_role('button',name='Files',exact=True).click()
    trigger=p.get_by_role('button',name='Content actions',exact=True)
    trigger.hover();e.capture(p,prefix+'-published-actions-hover',coarse)
    tab_to(p,trigger);p.keyboard.press('Enter')
    expect(p.get_by_role('dialog',name='Published entry actions',exact=True)).to_be_visible()
    e.capture(p,prefix+'-published-actions-keyboard',coarse)
    escape(e,p,trigger,prefix+'-published-actions')


def draft(w,b,p,e,prefix,coarse):
    route=b.bundle_path('changes',draft=w.draft['id'],path='skills/review/SKILL.md')
    visit(p,b,route)
    e.capture(p,prefix+'-draft-collapsed',coarse)
    open_files(p)
    add=p.get_by_role('button',name='Add entry',exact=True)
    tab_to(p,add);p.keyboard.press('Enter')
    menu=p.get_by_role('menuitem',name='Add instruction',exact=True)
    expect(menu).to_be_visible()
    m=e.capture(p,prefix+'-add-entry-keyboard-menu',coarse)
    if coarse:
        e.check(prefix+'-coarse-menu-minimum44',all(x['bounds']['height']>=44 for x in m['interaction']['menus']),m['interaction']['menus'])
    p.keyboard.press('ArrowDown');p.keyboard.press('Escape')
    expect(add).to_be_focused()
    if p.get_by_role('button',name='Files',exact=True).is_visible():
        p.get_by_role('button',name='Files',exact=True).click()
    trigger=p.get_by_role('button',name='Entry actions',exact=True)
    trigger.click()
    p.get_by_label('Rename entire skill package',exact=True).fill('Invalid Name!')
    p.get_by_role('button',name='Apply package rename',exact=True).click()
    m=e.capture(p,prefix+'-entry-invalid-package',coarse)
    field=p.get_by_label('Rename entire skill package',exact=True)
    e.check(prefix+'-package-error-field-local',field.get_attribute('aria-invalid')=='true' and bool(field.get_attribute('aria-describedby')),m['interaction']['fieldErrors'])
    escape(e,p,trigger,prefix+'-entry-actions')
    # Reset through navigation to avoid preserving an intentionally invalid package form.
    visit(p,b,route)
    open_files(p)
    import_trigger=p.get_by_role('button',name='Import files into this draft',exact=True)
    if e.baseline:
        open_details(p,'Import files into this draft')
        open_details(p,'Import files')
        import_trigger.scroll_into_view_if_needed()
    else:
        import_trigger.click()
        expect(p.get_by_role('dialog',name='Import files into this draft',exact=True)).to_be_visible()
    e.capture(p,prefix+'-import-expanded',coarse)
    if not e.baseline:
        escape(e,p,import_trigger,prefix+'-import')
    details=open_details(p,'Draft details')
    expect(details.get_by_role('heading',name='Saved snapshot history',exact=True)).to_be_visible()
    e.capture(p,prefix+'-draft-history-details',coarse)
    close_draft_details(p)
    visit(p,b,route)
    editor=p.get_by_role('textbox', name='Content', exact=True)
    editor.fill(editor_value(editor)+'\nBrowser-only pending edit.\n')
    action=draft_action(p,'Evaluate saved generation 1')
    action.click()
    expect(p.get_by_role('alertdialog')).to_be_visible()
    e.capture(p,prefix+'-draft-navigation-alert',coarse)
    p.keyboard.press('Escape')
    expect(p.get_by_role('alertdialog')).to_have_count(0)
    returned=p.get_by_role('button',name='Draft actions',exact=True)
    if not returned.count() or not returned.is_visible():
        returned=p.get_by_role('link',name='Evaluate saved generation 1',exact=True)
    e.check(prefix+'-navigation-escape-restores-trigger',returned.evaluate('el=>el===document.activeElement'))
    e.check(prefix+'-navigation-keeps-unsaved-source','Browser-only pending edit.' in editor_value(editor))


def evaluation(w,b,p,e,prefix,coarse):
    route=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=1)
    visit(p,b,route)
    for label, comparison in [('incomplete',w.incomplete),('mismatched',w.mismatched)]:
        open_details(p,'Advanced details')
        p.get_by_label('Comparison ID',exact=True).fill(comparison['id'])
        p.get_by_role('button',name='Inspect comparison',exact=True).click()
        expect(p.get_by_text('Selected comparison: '+comparison['id'],exact=True)).to_be_visible()
        expect(p.get_by_role('button',name='Inspect comparison',exact=True)).to_be_enabled()
        if label=='mismatched':
            expect(p.get_by_role('alert').filter(has_text='This evidence does not match the saved candidate')).to_be_visible()
            expect(p.get_by_role('region',name='Observed paired rewards',exact=True)).to_have_count(0)
        p.get_by_role('heading',name='Reported evidence',exact=True).scroll_into_view_if_needed()
        e.capture(p,prefix+'-evidence-'+label,coarse)
        review=p.get_by_role('button',name='Review release with this evidence',exact=True)
        expect(review).to_be_visible()
        e.check(prefix+'-'+label+'-cannot-review-evidenced-release',review.is_disabled())
    visit(p,b,route)
    link=p.get_by_role('link',name=re.compile(r'^Inspect evidence for '))
    link.first.click()
    trigger=p.get_by_role('button',name='Review release with this evidence',exact=True)
    expect(trigger).to_be_visible();trigger.click()
    expect(p.get_by_role('dialog')).to_contain_text(w.draft['snapshotVersion']['id'])
    e.capture(p,prefix+'-evidenced-publish-confirm',coarse)
    escape(e,p,trigger,prefix+'-evidenced-publish')
    visit(p,b,route)
    open_details(p,'Publish without evaluation')
    p.get_by_label('Manual release reason',exact=True).fill('Disposable review only; do not publish.')
    trigger=p.get_by_role('button',name='Review manual release',exact=True);trigger.click()
    e.capture(p,prefix+'-manual-publish-confirm',coarse)
    escape(e,p,trigger,prefix+'-manual-publish')


def members(w,b,p,e,prefix,coarse):
    w.enable_email()
    visit(p,b,b.workspace_path('members'))
    trigger=p.get_by_role('button',name='Invite member',exact=True)
    expect(trigger).to_be_enabled()
    trigger.click()
    expect(p.get_by_role('button',name='Send invite',exact=True)).to_be_disabled()
    field=p.get_by_label('Email',exact=True)
    field.fill('not-an-email')
    p.get_by_role('button',name='Send invite',exact=True).click()
    e.capture(p,prefix+'-member-invite-invalid',coarse)
    e.check(prefix+'-member-email-native-validation',not field.evaluate('(el)=>el.validity.valid'))
    escape(e,p,trigger,prefix+'-member-invite')
    trigger=p.locator('.member-role-trigger').first;trigger.click()
    expect(p.get_by_role('menu')).to_be_visible()
    e.capture(p,prefix+'-member-role-menu',coarse)
    escape(e,p,trigger,prefix+'-member-role')
    trigger=p.locator('.member-actions-trigger').first;trigger.click()
    expect(p.get_by_role('menuitem',name='Copy user ID',exact=True)).to_be_visible()
    e.capture(p,prefix+'-member-actions-menu',coarse)
    escape(e,p,trigger,prefix+'-member-actions')



def connections(w,b,p,e,prefix,coarse,secret=False):
    visit(p,b,b.workspace_path('connections'))
    e.capture(p,prefix+'-connections-directory',coarse)
    trigger=p.get_by_role('button',name='New connection',exact=True);trigger.click()
    expect(p.get_by_role('button',name='Create connection',exact=True)).to_be_disabled()
    p.get_by_label('Display name',exact=True).fill('Review-only second connection')
    e.capture(p,prefix+'-connection-new-dialog',coarse)
    escape(e,p,trigger,prefix+'-connection-new')
    p.get_by_role('link').filter(has_text='BDD application').first.click()
    expect(p.get_by_role('heading',name='BDD application',exact=True)).to_be_visible()
    open_details(p,'Connection ID')
    p.get_by_role('heading',name='BDD application',exact=True).scroll_into_view_if_needed()
    e.capture(p,prefix+'-connection-selected-id',coarse)
    open_details(p,'Revoke this connection')
    trigger=p.get_by_role('button',name='Revoke connection',exact=True);trigger.click()
    dialog=p.get_by_role('dialog',name='Revoke connection?',exact=True)
    expect(dialog).to_be_visible()
    e.capture(p,prefix+'-connection-revoke-confirm',coarse)
    target=dialog.inner_text()
    e.check(prefix+'-revoke-names-target',all(part in target for part in ('BDD application','BDD bundle','stable',w.integration['id'])))
    escape(e,p,trigger,prefix+'-connection-revoke')
    if secret:
        p.get_by_role('button',name='Create read credential',exact=True).click()
        expect(p.get_by_label('One-time credential secret',exact=True)).to_be_visible()
        e.capture(p,prefix+'-credential-once-MASKED',coarse)
        p.get_by_role('button',name='I saved it · close',exact=True).click()


def releases(w,b,p,e,prefix,coarse):
    visit(p,b,b.bundle_path('releases',bundle_id=w.history_setup['bundle']['id']))
    p.get_by_role('button',name=re.compile(r'^Release details for revision ')).first.click()
    release_details=p.get_by_role('dialog',name='Release details',exact=True)
    expect(release_details).to_be_visible()
    p.wait_for_function('element=>element.contains(document.activeElement)',arg=release_details.element_handle())
    e.capture(p,prefix+'-release-history-details',coarse)
    p.keyboard.press('Escape')
    expect(release_details).to_have_count(0)
    p.get_by_role('button',name=re.compile(r'^Inspect content for revision ')).first.click()
    expect(p.get_by_role('dialog',name='Version content',exact=True)).to_be_visible()
    expect(p.get_by_text('Loading version…',exact=True)).to_have_count(0)
    e.capture(p,prefix+'-version-inspector',coarse)
    p.keyboard.press('Escape')
    trigger=p.get_by_role('button',name=re.compile(r'^Restore revision ')).first;trigger.click()
    open_details(p,'Selected version details')
    p.get_by_label('Reason for restoring',exact=True).fill('Review-only restore reason.')
    e.capture(p,prefix+'-restore-confirm',coarse)
    escape(e,p,trigger,prefix+'-restore')


def sdk(w,b,p,e,prefix,coarse):
    visit(p,b,b.bundle_path('connect'))
    open_details(p,'Workspace and bundle IDs')
    p.get_by_role('button',name='Workspace and bundle IDs',exact=True).scroll_into_view_if_needed()
    e.capture(p,prefix+'-sdk-native-ids',coarse)
    open_details(p,'Environment variables and private directories')
    recipe=p.get_by_label('TypeScript delivery recipe',exact=True)
    expect(recipe).to_be_visible()
    recipe.scroll_into_view_if_needed()
    e.capture(p,prefix+'-sdk-recipe-expanded',coarse)


def short_dialogs(w,b,p,e):
    """Actual Chrome 200% zoom with a 640 by 328 CSS-pixel viewport."""
    def capture(name, action):
        action.scroll_into_view_if_needed()
        m=e.capture(p,'native200-short-'+name)
        box=action.bounding_box()
        e.check('native200-short-'+name+'-decision-visible',box is not None and box['y']>=0 and box['y']+box['height']<=m['viewportHeight']+1,box)
    route=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=1,comparison=w.report['id'])
    visit(p,b,route)
    trigger=p.get_by_role('button',name='Review release with this evidence',exact=True)
    trigger.click();capture('evidenced-publish',p.get_by_role('button',name='Publish with selected evidence',exact=True))
    escape(e,p,trigger,'native200-short-evidenced')
    visit(p,b,b.workspace_path('connections'))
    trigger=p.get_by_role('button',name='New connection',exact=True);trigger.click()
    p.get_by_label('Display name',exact=True).fill('Short viewport review')
    capture('new-connection',p.get_by_role('button',name='Create connection',exact=True))
    escape(e,p,trigger,'native200-short-new-connection')
    visit(p,b,b.workspace_path('members'))
    trigger=p.locator('.member-actions-trigger').first;trigger.click()
    p.get_by_role('menuitem',name='Remove access',exact=True).click()
    expect(p.get_by_role('alertdialog')).to_be_visible()
    capture('remove-member',p.get_by_role('button',name='Remove member',exact=True))
    p.get_by_role('button',name='Keep member',exact=True).click()
    expect(trigger).to_be_focused()
    visit(p,b,b.bundle_path('releases',bundle_id=w.history_setup['bundle']['id']))
    trigger=p.get_by_role('button',name=re.compile(r'^Restore revision ')).first;trigger.click()
    p.get_by_label('Reason for restoring',exact=True).fill('Short viewport review only.')
    capture('restore',p.get_by_role('button',name='Restore version',exact=True))
    escape(e,p,trigger,'native200-short-restore')
    # The import task must remain usable in a short, genuinely zoomed viewport.
    visit(p,b,b.bundle_path('changes',draft=w.draft['id'],path='AGENTS.md'))
    open_files(p)
    trigger=p.get_by_role('button',name='Import files into this draft',exact=True)
    trigger.click()
    dialog=p.get_by_role('dialog',name='Import files into this draft',exact=True)
    expect(dialog).to_be_visible()
    files=[dict(name=f'native-import-{i}.md',mimeType='text/markdown',buffer=b'# Native zoom preview\n') for i in range(12)]
    dialog.get_by_label('Individual files',exact=True).set_input_files(files)
    expect(dialog.get_by_role('heading',name='Ready to add · 12 files',exact=True)).to_be_visible()
    e.capture(p,'native200-short-import-preview')
    add=dialog.get_by_role('button',name='Add 12 files to draft',exact=True)
    tab_to(p,add)
    capture('import-action',add)
    scrolls=dialog.evaluate('''el => [el,...el.querySelectorAll('*')].filter(e => e.getClientRects().length && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight>e.clientHeight+1).map(e=>e.getAttribute('data-slot')||e.tagName)''')
    e.check('native200-short-import-single-content-scroller',scrolls==['dialog-content'],scrolls)
    escape(e,p,trigger,'native200-short-import')
    trigger.click()
    expect(dialog.get_by_role('heading',name='Ready to add · 12 files',exact=True)).to_be_visible()
    e.check('native200-short-import-preview-retained',True)
    p.wait_for_function('element => element.contains(document.activeElement)', arg=dialog.element_handle())
    escape(e,p,trigger,'native200-short-import-reopened')


def prepare(w):
    w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
    candidate=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nReview saved candidate.\n' if f['path']=='AGENTS.md' else f['text']) for f in FILES])
    w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=candidate))
    w.draft_path=w.channel+'/drafts/'+w.draft['id']
    w.request_evaluation();w.start_attempt()
    w.comparison('missing grades');w.incomplete=w.report
    other_payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nDifferent comparison candidate.\n') for f in FILES])
    other=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=other_payload))['snapshotVersion']
    good=dict(executionStatus='completed',gradingStatus='scored',reward=1,usage=dict(costUsd=0))
    mismatched=dict(w.settings,candidateVersionId=other['id'],candidateDigest=other['digest'],results=[dict(**case,parent=good,candidate=good) for case in w.settings['expectedCases']])
    w.mismatched=w.call('POST',w.bundle+'/comparisons',mismatched,actor='evaluator')
    w.comparison();w.finish();w.create_integration()
    w.history_setup=w.call('POST',w.root+'/bundle-setups',dict(name='Restore history fixture',origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES),reason='Disposable history fixture.'))
    bundle=w.root+'/bundles/'+w.history_setup['bundle']['id'];channel=bundle+'/channels/stable';base=w.history_setup['resolution']
    d=w.call('POST',channel+'/drafts',dict(baseVersionId=base['version']['id'],baseRevision=base['revision'],payload=candidate))
    w.call('POST',channel+'/promotions',dict(versionId=d['snapshotVersion']['id'],expectedRevision=base['revision'],unevaluatedReason='Disposable second release for Restore dialog.'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',action='store_true');parser.add_argument('--pg-bin');parser.add_argument('--only',choices=['all','connections','native'],default='all')
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--chrome-channel',default='chrome');parser.add_argument('--skip-native',action='store_true')
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Evidence(output,args.baseline);w=World(pg_bin(args.pg_bin));b=touch=None
    try:
        prepare(w);b=w.browser();p=b.page;p.set_viewport_size(dict(width=1440,height=900))
        touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
        mobile=touch.new_page();mobile.set_default_timeout(7000);mobile.on('pageerror',lambda error:b.errors.append(str(error)))
        for page,prefix,coarse in ([] if args.only=='native' else [(p,'desktop',False),(mobile,'mobile390',True)]):
            for name,fn in [('content',content),('draft',draft),('evaluation',evaluation),('members',members),('connections',connections),('releases',releases),('sdk',sdk)]:
                if args.only=='all' or name=='connections':
                    e.run(prefix+'-'+name,page,lambda fn=fn,page=page,prefix=prefix,coarse=coarse:fn(w,b,page,e,prefix,coarse))
        mobile.set_viewport_size(dict(width=320,height=844))
        if args.only!='native':
            e.run('mobile320-connections',mobile,lambda:connections(w,b,mobile,e,'mobile320',True,True))
        if not args.skip_native:
            with tempfile.TemporaryDirectory(prefix='acclimate-layout5-native-') as profile:
                native=b.playwright.chromium.launch_persistent_context(profile,channel=args.chrome_channel,headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,1000'])
                try:
                    b.sign_in(native);page=native.pages[0];visit(page,b,b.bundle_path('content'))
                    before=page.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
                    page.goto('chrome://settings/appearance',wait_until='domcontentloaded');page.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
                    visit(page,b,b.bundle_path('content'));page.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2)
                    assert page.evaluate('devicePixelRatio')==before['dpr']*2
                    page.on('pageerror',lambda error:b.errors.append(str(error)))
                    e.cdp=native.new_cdp_session(page)
                    for name,fn in [('content',content),('members',members),('connections',connections),('releases',releases)]:
                        if args.only in ('all','native') or name=='connections':
                            e.run('native200-'+name,page,lambda fn=fn:fn(w,b,page,e,'native200',False))
                    if args.only in ('all','native'):
                        cdp=native.new_cdp_session(page)
                        window=cdp.send('Browser.getWindowForTarget')['windowId']
                        cdp.send('Browser.setWindowBounds',dict(windowId=window,bounds=dict(width=1280,height=800)))
                        page.wait_for_function('innerWidth===640 && innerHeight===328')
                        e.run('native200-short-dialogs',page,lambda:short_dialogs(w,b,page,e))
                finally:
                    e.cdp=None
                    native.close()
        e.check('published-release-unchanged',w.call('GET',w.channel)['version']==w.original['version'])
        e.check('no-browser-errors',not b.errors,b.errors)
    except Exception as error:
        e.failures.append(dict(check='fixture',error=str(error),traceback=traceback.format_exc()))
    finally:
        if touch:touch.close()
        w.close()
        summary=dict(mode='baseline' if args.baseline else 'acceptance',passed=not e.failures and all(c['passed'] for c in e.checks),traversalComplete=not e.failures,
            capturedStates=len(e.states),states=e.states,checks=e.checks,failures=e.failures,
            knownIssues=[c for c in e.checks if not c['passed']] if args.baseline else [],
            fixture='disposable PostgreSQL + real service + existing built console + OIDC/TLS',paidModelCalls=0,
            secretScreenshots='Ordinary captures mask data-sensitive/one-time secret locators; native CDP captures refuse visible sensitive locators. No raw DOM saved',
            sourceOnly=[dict(state='SDK/native ID hint tooltips',reason='shared.tsx ShortId uses a native title={value}; SDK uses visible expandable ID details. Native browser tooltip rendering is source-only, not a visual tooltip claim.'),
                        dict(state='Live evaluator/model execution and pending network recovery',reason='Intentionally not invoked; navigation pending edit alert is captured. Existing BDD recovery coverage remains separate.')])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(dict(passed=summary['passed'],capturedStates=len(e.states),failures=len(e.failures),knownIssues=len(summary['knownIssues'])),indent=2),flush=True)
    return 0 if (summary['traversalComplete'] if args.baseline else summary['passed']) else 1

if __name__=='__main__':raise SystemExit(main())
