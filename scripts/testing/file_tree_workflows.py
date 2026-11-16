#!/usr/bin/env python3
"""Real FileTree proof on private service/OIDC/TLS and an unchanged build.

Native browser inputs, read-only geometry, no providers/models/interception or
DOM/focus/storage injection. Browser draft edits are explicitly discarded.
"""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import traceback
from types import SimpleNamespace
from urllib.parse import parse_qs,urlsplit

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.editor import editor_value, expect_editor_contains, expect_editor_value
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.bdd.layout import tab_to,inspect_layout
from scripts.bdd.interactions import open_files,open_details
from scripts.testing.compact_console import FILES,visit
from scripts.testing.desktop_layouts import Evidence,build_fingerprint
from scripts.test_console_native_zoom import capture_native

DEEP='memory/release-guidelines/production-retry-contracts/provider-specific-evidence/retained-context.md'
EXTRA=[dict(path=DEEP,kind='memory',text='# Retained deep context\nKeep exact leaf identity.\n'),dict(path='memory/alpha/same.md',kind='memory',text='# Alpha same basename\n'),dict(path='memory/beta/same.md',kind='memory',text='# Beta same basename\n')]+[dict(path=f'memory/archive/{i:02d}/context.md',kind='memory',text=f'# Archive {i:02d}\n') for i in range(17)]
FILES24=FILES+EXTRA


def leaf(p,path):return p.get_by_role('treeitem',name='Open '+path,exact=True)
def folder(p,path):return p.get_by_role('treeitem',name='Folder '+path,exact=True)
def tree(p):return p.get_by_role('tree',name='Files',exact=True)


def capture(e,p,name,coarse=False):
    p.evaluate('async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}');p.wait_for_timeout(500);cdp=p.context.new_cdp_session(p)
    try:metric=capture_native(p,cdp,e.output,name)
    finally:cdp.detach()
    metric['tree']=tree(p).evaluate('''el=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return {bounds:box(el),scrollTop:el.scrollTop,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,documentScrollY:scrollY,pointerCoarse:matchMedia('(pointer:coarse)').matches,rows:[...el.querySelectorAll('[role=treeitem]')].map(row=>({name:row.getAttribute('aria-label'),path:row.getAttribute('data-file-path'),node:row.getAttribute('data-tree-node-id'),tabIndex:row.tabIndex,selected:row.getAttribute('aria-selected'),expanded:row.getAttribute('aria-expanded'),level:row.getAttribute('aria-level'),bounds:box(row),owns:row.getAttribute('aria-owns'),ownedGroupValid:!row.hasAttribute('aria-owns')||document.getElementById(row.getAttribute('aria-owns'))?.getAttribute('role')==='group'}))}}''')
    visible=tree(p).is_visible()
    if visible and metric['tree']['rows']:assert sum(row['tabIndex']==0 for row in metric['tree']['rows'])==1,metric['tree']
    for row in metric['tree']['rows']:
        assert row['ownedGroupValid'],row
        assert row['bounds']['height']>=(43.5 if coarse else 35.5),row
    if coarse:assert metric['tree']['pointerCoarse']
    assert metric['width']<=metric['viewport']+1,metric
    after=inspect_layout(p);keys=('viewport','viewportHeight','width','scrollY','visualViewportOffsetTop');assert {key:metric[key] for key in keys}=={key:after[key] for key in keys},'Capture changed geometry'
    metric['capture']=dict(method='CDP Page.captureScreenshot',before={key:metric[key] for key in keys},after={key:after[key] for key in keys})
    (e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n');return metric


def ordinary(w,b,e,f):
    p=b.page;visit(p,b,b.bundle_path('content',bundle_id=f['ordinary']['bundle']['id']));expect(tree(p)).to_be_visible();expect(tree(p).locator('[data-file-path]')).to_have_count(4)
    for file in FILES:expect(leaf(p,file['path'])).to_have_attribute('href',b.bundle_path('content',bundle_id=f['ordinary']['bundle']['id'],path=file['path']))
    before=p.url;source=p.get_by_test_id('entry-content').inner_text();control=folder(p,'skills');tab_to(p,control);p.keyboard.press('Space');expect(control).to_have_attribute('aria-expanded','false');assert p.url==before;expect(p.get_by_test_id('entry-content')).to_have_text(source);p.keyboard.press('Enter');expect(control).to_have_attribute('aria-expanded','true')
    tab_to(p,leaf(p,'memory/team.md'));p.keyboard.press('Enter');expect(p.get_by_test_id('entry-content')).to_have_text(FILES[-1]['text']);assert parse_qs(urlsplit(p.url).query)['path']==['memory/team.md']
    tab_to(p,leaf(p,'AGENTS.md'));p.keyboard.press('Space');expect(p.get_by_test_id('entry-content')).to_have_text(FILES[0]['text']);capture(e,p,'1440-ordinary-four-file-published-tree')
    return dict(fourRealLeaves=True,nativePublishedHrefEnterAndSpace=True,folderTogglePreservesContentAndRoute=True)


def deep_keyboard(w,b,e,f):
    p=b.page;visit(p,b,f['draftRoute']);editor=p.get_by_role('textbox', name='Content', exact=True);expect_editor_value(editor, FILES[0]['text']);expect(leaf(p,'AGENTS.md')).to_have_attribute('aria-selected','true')
    first=capture(e,p,'1440-deep24-selected-root-internal-reveal');assert first['tree']['documentScrollY']==0;assert first['tree']['scrollTop']>0
    selected=leaf(p,'AGENTS.md').bounding_box();bounds=first['tree']['bounds'];assert selected['y']>=bounds['y'] and selected['y']+selected['height']<=bounds['bottom']+1,(selected,bounds)
    tab_to(p,leaf(p,'AGENTS.md'));original=p.url;p.keyboard.press('Home');expect(folder(p,'skills')).to_be_focused();p.keyboard.press('ArrowRight');expect(folder(p,'skills/review')).to_be_focused();p.keyboard.press('ArrowLeft');expect(folder(p,'skills/review')).to_have_attribute('aria-expanded','false');p.keyboard.press('ArrowRight');expect(folder(p,'skills/review')).to_have_attribute('aria-expanded','true');p.keyboard.press('End');expect(leaf(p,'AGENTS.md')).to_be_focused();assert p.url==original;expect_editor_value(editor, FILES[0]['text'])
    p.keyboard.press('Home');p.keyboard.type('team',delay=30);expect(leaf(p,'memory/team.md')).to_be_focused();assert p.url==original;p.keyboard.press('Enter');expect_editor_value(editor, FILES[-1]['text'])
    target=leaf(p,DEEP);tab_to(p,target,tree=True);p.keyboard.press('Space');expect_editor_value(editor, EXTRA[0]['text']);expect(target).to_have_attribute('aria-selected','true')
    p.mouse.move(1400,10);target.hover();tip=p.get_by_role('tooltip',name=DEEP,exact=True).and_(p.locator('[data-state$="-open"]'));expect(tip).to_have_text(DEEP);capture(e,p,'1440-deep-path-exact-hover-tooltip');p.keyboard.press('Escape');expect(tip).to_have_count(0);p.mouse.move(1400,10);tab_to(p,leaf(p,'AGENTS.md'));tab_to(p,target,tree=True);expect(tip).to_have_text(DEEP);p.keyboard.press('Escape');expect(tip).to_have_count(0);expect(target).to_be_focused()
    assert leaf(p,'memory/alpha/same.md').count()==1 and leaf(p,'memory/beta/same.md').count()==1
    return dict(realFiles=24,initialRootSelectedVisible=True,documentNotScrolled=True,arrowsHomeEndFocusOnly=True,typeaheadFocusOnly=True,spaceSelects=True,sameBasenamesUnambiguous=True,exactHoverFocusTooltipEscape=True)


def filters(w,b,e,f):
    p=b.page;visit(p,b,b.bundle_path('changes',draft=f['draft']['id'],path='memory/team.md'));editor=p.get_by_role('textbox', name='Content', exact=True);expect_editor_value(editor, FILES[-1]['text']);before=p.url;folder(p,'memory').click();expect(folder(p,'memory')).to_have_attribute('aria-expanded','false');expect(leaf(p,'memory/team.md')).to_have_count(0)
    query=p.get_by_label('Find an entry',exact=True);query.fill('checks');expect(folder(p,'skills')).to_have_attribute('aria-expanded','true');expect(query).to_be_focused();folder(p,'skills').click();expect(folder(p,'skills')).to_have_attribute('aria-expanded','false');query.fill('SKILL.md');expect(folder(p,'skills')).to_have_attribute('aria-expanded','true');p.get_by_role('button',name='Clear filters',exact=True).click()
    expect(folder(p,'memory')).to_have_attribute('aria-expanded','false');expect(folder(p,'skills')).to_have_attribute('aria-expanded','true');assert p.url==before;expect_editor_value(editor, FILES[-1]['text']);capture(e,p,'1440-filter-cleared-restores-base-selected-folder-fold')
    query.fill('tree-no-match');expect(tree(p).get_by_role('treeitem')).to_have_count(0);expect(p.get_by_text('No matching entries. Clear filters to see all entries.',exact=True)).to_be_visible();expect_editor_value(editor, FILES[-1]['text']);p.get_by_role('button',name='Clear filters',exact=True).click();expect(folder(p,'memory')).to_have_attribute('aria-expanded','false')
    expect(p.get_by_label('Entry type',exact=True)).to_have_count(0);expect(p.get_by_role('combobox',name='Published file type',exact=True)).to_have_count(0);expect(p.locator('.file-navigator-footer')).to_have_text('24 files')
    return dict(baseFoldsRestored=True,temporaryFilterFoldsResetOnNewQuery=True,selectedFilteredOutThenClearedPreservesFold=True,emptyFilterReal=True,kindFilterRemoved=True,footerCount=True,routeContentUnchanged=True)


def mutations(w,b,e,f):
    p=b.page;visit(p,b,f['draftRoute']);tab_to(p,leaf(p,DEEP),tree=True);p.keyboard.press('Enter');original_id=leaf(p,DEEP).get_attribute('data-tree-node-id');editor=p.get_by_role('textbox', name='Content', exact=True);text=editor_value(editor);p.get_by_role('button',name='Entry actions',exact=True).click();dialog=p.get_by_role('dialog',name='Entry actions',exact=True);path=dialog.get_by_label('Entry path (rename)',exact=True)
    for value in ('../invalid.md','AGENTS.md','memory/renamed/deep/retained.md'):
        path.fill(value);expect(path).to_be_focused()
        if value=='../invalid.md':expect(p.get_by_role('treeitem',name='Folder ..',exact=True)).to_have_count(0)
        if value=='AGENTS.md':expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True,include_hidden=True)).to_have_count(2)
    p.keyboard.press('Escape');renamed='memory/renamed/deep/retained.md';expect(leaf(p,renamed)).to_have_attribute('data-tree-node-id',original_id);expect(folder(p,'memory/renamed/deep')).to_have_attribute('aria-expanded','true');expect_editor_value(editor, text)
    leaf(p,'AGENTS.md').click();p.get_by_role('button',name='Entry actions',exact=True).click();p.get_by_role('dialog').get_by_role('button',name='Remove entry',exact=True).click();p.get_by_role('dialog',name='Entry actions',exact=True).get_by_role('button',name='Close',exact=True).click();expect(p.get_by_role('dialog',name='Entry actions',exact=True)).to_have_count(0);expect_editor_value(editor, FILES[1]['text']);tab_to(p,leaf(p,renamed),tree=True);p.keyboard.press('Enter');expect_editor_value(editor, text)
    folder(p,'memory').click();p.get_by_role('button',name='Add entry',exact=True).click();p.get_by_role('menuitem',name='Add shared memory',exact=True).click();expect(folder(p,'memory')).to_have_attribute('aria-expanded','true');added=tree(p).locator('[aria-selected=true]');added_path=added.get_attribute('data-file-path');assert added_path.startswith('memory/new-');expect_editor_value(editor, '')
    root=w.h.dir/'tree-import';(root/'memory/imported/deep').mkdir(parents=True);(root/'memory/imported/deep/new.md').write_text('# Imported tree leaf\n');p.get_by_role('button',name='Import files into this draft',exact=True).click();import_dialog=p.get_by_role('dialog',name='Import files into this draft',exact=True);import_dialog.get_by_label('Bundle folder',exact=True).set_input_files(str(root));expect(import_dialog.get_by_role('button',name='Add 1 file to draft',exact=True)).to_be_enabled();import_dialog.get_by_role('button',name='Add 1 file to draft',exact=True).click();expect(import_dialog).to_have_count(0);expect(folder(p,'memory/imported/deep')).to_have_attribute('aria-expanded','true');expect(tree(p).locator('[aria-selected=true]')).to_have_attribute('data-file-path',added_path)
    capture(e,p,'1440-browser-rename-delete-add-import-tree');assert w.call('GET',f['draftPath'])==f['saved'],'Browser tree edits saved unexpectedly'
    p.get_by_role('button',name='Reload saved draft',exact=True).click();guard=p.get_by_role('alertdialog');expect(guard).to_be_visible();guard.get_by_role('button',name='Leave editor',exact=True).click();expect(leaf(p,DEEP)).to_have_count(1);expect(leaf(p,renamed)).to_have_count(0);expect(tree(p).locator('[data-file-path]')).to_have_count(24)
    return dict(invalidPathRootLeaf=True,duplicatePathsDistinct=True,renameIdentityStable=True,renameAncestorsOpenWithoutDialogFocusSteal=True,deleteEarlierThenSelectCorrectContent=True,addAndImportAncestorsOpen=True,importSelectionPreserved=True,allBrowserEditsDiscarded=True)


def narrow(w,b,e,f,*,native=False):
    temporary=tempfile.TemporaryDirectory(prefix='acclimate-tree-native-') if native else None
    context=b.playwright.chromium.launch_persistent_context(temporary.name,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900']) if native else b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
    try:
        if native:
            b.sign_in(context);p=context.pages[0];visit(p,b,f['draftRoute']);before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)');visit(p,b,f['draftRoute']);p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2
        else:p=context.new_page();visit(p,b,f['draftRoute'])
        p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)));toggle=p.get_by_role('button',name='Files',exact=True);toggle.click();current=p.url;folder(p,'memory').click();expect(toggle).to_have_attribute('aria-expanded','true');assert p.url==current;folder(p,'memory').click();tab_to(p,leaf(p,'memory/team.md'),tree=True);p.keyboard.press('Enter');expect(toggle).to_have_attribute('aria-expanded','false');expect(toggle).to_be_focused();expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), FILES[-1]['text']);toggle.click();capture(e,p,('native200' if native else '390-coarse')+'-tree-keyboard-and-folder-no-close',coarse=not native)
        # Published leaf navigation remains guarded while browser draft text is dirty.
        p.get_by_role('textbox', name='Content', exact=True).fill(FILES[-1]['text']+'\nUnsaved guard fixture.\n');link=p.get_by_role('link',name='Content',exact=True);link.click();guard=p.get_by_role('alertdialog');expect(guard).to_be_visible();p.keyboard.press('Escape');expect(guard).to_have_count(0);expect_editor_contains(p.get_by_role('textbox', name='Content', exact=True), 'Unsaved guard fixture.')
        p.get_by_role('button',name='Reload saved draft',exact=True).click();p.get_by_role('alertdialog').get_by_role('button',name='Leave editor',exact=True).click()
        return dict(actualNative200=native,actualCoarse=not native,folderDoesNotClose=True,committedLeafClosesAndReturnsFocus=True,dirtyNavigationCancelled=True)
    finally:context.close();temporary.cleanup() if temporary else None


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--expected-build-hash',required=True);parser.add_argument('--output',type=Path,default=ROOT/'artifacts/file-tree/accepted');args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700);e=Evidence(output,False);w=World(pg_bin(args.pg_bin));before=build_fingerprint();unchanged=False
    try:
        assert before==args.expected_build_hash;w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES24);draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=dict(schemaVersion=1,files=FILES24)));ordinary_setup=w.call('POST',w.root+'/bundle-setups',dict(name='Ordinary four-file tree',origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES),reason='Disposable ordinary FileTree fixture.'));b=w.browser();p=b.page;p.set_viewport_size(dict(width=1440,height=900));f=dict(draft=draft,draftPath=w.channel+'/drafts/'+draft['id'],saved=draft,ordinary=ordinary_setup,draftRoute=b.bundle_path('changes',draft=draft['id'],path='AGENTS.md'));initial=dict(release=w.call('GET',w.channel),promotions=w.call('GET',w.channel+'/promotions')['items'],draft=w.call('GET',f['draftPath']))
        e.run('ordinary-tree-published-native-semantics',p,lambda:ordinary(w,b,e,f));e.run('deep24-keyboard-reveal-and-tooltips',p,lambda:deep_keyboard(w,b,e,f));e.run('filtered-ancestry-and-base-fold-restoration',p,lambda:filters(w,b,e,f));e.run('rename-add-delete-import-browser-updates',p,lambda:mutations(w,b,e,f));e.run('390-coarse-committed-selection-and-dirty-cancel',p,lambda:narrow(w,b,e,f));e.run('actual-native200-tree',p,lambda:narrow(w,b,e,f,native=True))
        final=dict(release=w.call('GET',w.channel),promotions=w.call('GET',w.channel+'/promotions')['items'],draft=w.call('GET',f['draftPath']));assert initial==final,'Browser tests changed persisted fixture';assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        summary=dict(passed=not e.failures,checks=e.checks,failures=e.failures,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,persistedVersionsPromotionsAndDraftsUnchanged=unchanged,paidModelCalls=0,providerCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,fixture='Private PostgreSQL + real service + frozen production console + actual OIDC/TLS',limits=['All browser edits are explicitly discarded, with no Save or publication.','Real native keyboard enters the roving tree through Tab, then uses tree keys; no programmatic focus or node/style injection.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
