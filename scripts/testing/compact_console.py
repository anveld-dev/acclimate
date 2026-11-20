#!/usr/bin/env python3
"""Capture compact console surfaces using disposable persisted product fixtures."""
import argparse
import json
import re
from urllib.parse import urlsplit
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.editor import editor_value, expect_editor_value
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.interactions import open_files, draft_action, open_details
from scripts.bdd.layout import capture_layout, assert_compact_editor, assert_file_heading_metrics, inspect_layout, tab_to
from scripts.test_console_native_zoom import capture_native


INSTRUCTIONS='''# Code review instructions

Read the change and its surrounding code before reporting a finding.

## Review priorities

- Check retries for duplicate side effects.
- Preserve the original idempotency key after an ambiguous timeout.
- Confirm that saved snapshots remain reproducible.
- Cite the affected path and explain the observable consequence.

## Evidence

Run the smallest relevant checks. Describe any check that could not run.
'''
FILES=[dict(path='AGENTS.md',kind='instruction',text=INSTRUCTIONS),
       dict(path='skills/review/SKILL.md',kind='skill',text='---\nname: review\ndescription: Review changes for correctness.\n---\nRead references/checks.md before reviewing.\n'),
       dict(path='skills/review/references/checks.md',kind='skill',text='# Review checks\n\nVerify that retries keep their original operation identity.\n'),
       dict(path='memory/team.md',kind='memory',text='# Team context\n\nSaved drafts do not change the release. Publication requires explicit review.\n')]


def visit(page, fixture, path):
    response=page.goto(fixture.base+path,wait_until='networkidle')
    assert response and response.status==200, path


def reset_editor_view(page):
    """Use real keyboard/scroll input to present the initial source viewport."""
    editor=page.get_by_role('textbox', name='Content', exact=True)
    editor.press('ControlOrMeta+A')
    page.keyboard.press('ArrowLeft')
    # CodeMirror retains a small caret scroll margin at real browser zoom.
    # Reset the actual source scroller with a real wheel before resetting the page.
    scroller=page.locator('[data-code-editor] .cm-scroller, textarea#draft-text')
    scroller.hover()
    page.mouse.wheel(0,-scroller.evaluate('element => Math.max(innerHeight,element.scrollHeight)'))
    page.wait_for_function('document.querySelector("[data-code-editor] .cm-scroller, textarea#draft-text").scrollTop <= 1')
    page.get_by_role('heading',name='BDD bundle',exact=True).click()
    # A gutter scroll targets the document, not the source's inner scroller.
    page.mouse.move(1,1)
    page.mouse.wheel(0,-page.evaluate('Math.max(innerHeight,scrollY+visualViewport.offsetTop)'))
    try:
        page.wait_for_function('scrollY <= 1 && visualViewport.offsetTop <= 1 && document.querySelector("[data-code-editor] .cm-scroller, textarea#draft-text").scrollTop <= 1')
    except Exception as error:
        state=page.evaluate('({scrollY,offset:visualViewport.offsetTop,editorScroll:document.querySelector("[data-code-editor] .cm-scroller, textarea#draft-text").scrollTop,selection:getSelection()?.anchorOffset})')
        raise AssertionError('Source viewport did not reset with keyboard/scroll input: '+str(state)) from error


def keyboard_workflow(w, b):
    p=b.page
    before_requests=w.call('GET',w.bundle+'/evaluation-requests')['items']
    b.visit(b.bundle_path('content'))
    entry=p.get_by_role('treeitem',name='Open memory/team.md',exact=True)
    tab_to(p,entry);p.keyboard.press('Enter')
    expect(p.get_by_test_id('entry-content')).to_contain_text('Team context')
    published=published_actions_acceptance(p,w.h.dir/'keyboard-published-memory.md')
    tab_to(p,p.get_by_role('link',name='Edit entry',exact=True));p.keyboard.press('Enter')
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), FILES[-1]['text'])
    actions=p.get_by_role('button',name='Entry actions',exact=True)
    tab_to(p,actions);p.keyboard.press('Enter')
    dialog=p.get_by_role('dialog',name='Entry actions',exact=True)
    expect(dialog).to_be_visible()
    path=p.get_by_label('Entry path (rename)',exact=True)
    tab_to(p,path)
    p.keyboard.press('ControlOrMeta+A');p.keyboard.insert_text('memory/review-team.md')
    p.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    expect(actions).to_be_focused()
    text=p.get_by_role('textbox', name='Content', exact=True)
    tab_to(p,text);p.keyboard.press('ControlOrMeta+End');p.keyboard.press('Enter');p.keyboard.insert_text('Keyboard review completed.');p.keyboard.press('Enter')
    tab_to(p,p.get_by_role('button',name='Save draft',exact=True))
    with p.expect_response(lambda response: response.request.method=='POST'):
        p.keyboard.press('Enter')
    p.wait_for_load_state('networkidle')
    expect(p.get_by_role('link',name='Continue to evaluation',exact=True)).to_be_visible()
    expect(p.get_by_role('link',name='Continue to evaluation',exact=True)).to_be_focused()
    drafts=w.call('GET',w.channel+'/drafts')['items']
    saved=next(row for row in drafts if row['id'] in p.url)
    actual=w.call('GET',w.bundle+'/versions/'+saved['snapshotVersion']['id']+'/payload')
    assert any(file['path']=='memory/review-team.md' and 'Keyboard review completed.' in file['text'] for file in actual['files'])
    tab_to(p,p.get_by_role('link',name='Continue to evaluation',exact=True));p.keyboard.press('Enter')
    expect(p.get_by_label('Saved change review',exact=True)).to_contain_text('Generation 1 saved')
    # Collapsing a configuration panel must keep its unsaved form value, while
    # removing the hidden form from keyboard navigation and accessible controls.
    setup=p.get_by_role('button',name='Set up evaluation request',exact=True)
    expect(setup).to_have_attribute('aria-expanded','true')
    config=p.get_by_label('Public evaluator configuration (JSON)',exact=True).filter(visible=True)
    original_config=editor_value(config)
    edited_config=original_config+'\n '
    config.focus(); p.keyboard.press('ControlOrMeta+A'); p.keyboard.press('Backspace')
    if original_config: p.keyboard.insert_text(original_config)
    p.keyboard.press('Enter'); p.keyboard.insert_text(' ')
    # Return to the preceding trigger with Shift+Tab. Traversing forward past
    # the last page control enters Sonner, which restores the prior control
    # when leaving its notification; that isn't a page-wide wraparound path.
    tab_to(p,setup,reverse=True);p.keyboard.press('Space')
    expect(setup).to_have_attribute('aria-expanded','false')
    expect(config).not_to_be_visible()
    p.keyboard.press('Tab')
    assert not p.locator('.evaluation-setup [data-slot=disclosure-content]').evaluate('e=>e.contains(document.activeElement)'), 'Collapsed form remains in the tab order'
    tab_to(p,setup,reverse=True);p.keyboard.press('Enter')
    expect(setup).to_have_attribute('aria-expanded','true')
    expect_editor_value(config, edited_config)
    config.fill(original_config)
    assert w.call('GET',w.channel)['version']==w.original['version']
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==before_requests, 'Keyboard review unexpectedly ran an evaluation'
    return dict(fileSelection=True,publishedActions=published,entryActions=True,renaming=True,editing=True,save=True,evaluationNavigation=True,disclosureKeyboard=True,collapsedEditsPreserved=True,releaseUnchanged=True)


def published_actions_acceptance(page, download_path):
    """Exercise the actual popover, clipboard permission denial and download."""
    trigger=page.get_by_role('button',name='Content actions',exact=True)
    panel=page.get_by_role('dialog',name='Published entry actions',exact=True)
    source=page.get_by_test_id('entry-content')
    expected=source.text_content()
    expect(page.get_by_role('link',name='Edit entry',exact=True)).to_be_visible()
    expect(page.get_by_role('button',name='Copy content',exact=True)).to_have_count(0)
    expect(page.get_by_role('button',name='Download published entry',exact=True)).to_have_count(0)
    tab_to(page,trigger);page.keyboard.press('Enter')
    expect(panel).to_be_visible()
    popover_metrics=inspect_layout(page)
    assert_file_heading_metrics(popover_metrics)
    page.keyboard.press('Escape')
    expect(panel).to_have_count(0)
    expect(trigger).to_be_focused()
    page.keyboard.press('Enter')
    copy=panel.get_by_role('button',name='Copy content',exact=True)
    cdp=page.context.new_cdp_session(page)
    context_id=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
    permission=dict(permission=dict(name='clipboard-write'),origin=page.evaluate('location.origin'),browserContextId=context_id)
    try:
        # This changes the browser's actual permission, leaving the application
        # and native clipboard implementation intact.
        cdp.send('Browser.setPermission',dict(permission,setting='denied'))
        tab_to(page,copy);page.keyboard.press('Enter')
        expect(panel.get_by_role('status')).to_have_text('Clipboard unavailable. Select and copy the text instead.')
        expect(source).to_have_text(expected)
        assert source.evaluate('el=>getComputedStyle(el).userSelect')!='none'
        download=panel.get_by_role('button',name='Download published entry',exact=True)
        tab_to(page,download)
        with page.expect_download() as event:
            page.keyboard.press('Enter')
        event.value.save_as(str(download_path))
        assert download_path.read_text()==expected
    finally:
        cdp.send('Browser.setPermission',dict(permission,setting='granted'))
        cdp.detach()
    page.keyboard.press('Escape')
    expect(panel).to_have_count(0)
    expect(trigger).to_be_focused()
    return dict(keyboardOpen=True,escapeRestoresFocus=True,clipboardPermissionDeniedFallback=True,sourceSelectable=True,downloadMatchesPublishedText=True,popover=popover_metrics['selectedHeader'])


def narrow_files_acceptance(page):
    """Retain unsaved source through toggle, selection and breakpoint changes."""
    editor=page.get_by_role('textbox', name='Content', exact=True)
    original=editor_value(editor)
    edited=original+'\nKeep browser-only edits while choosing files.\n'
    editor.fill(edited)
    trigger=page.get_by_role('button',name='Files',exact=True)
    tab_to(page,trigger);page.keyboard.press('Enter')
    expect(trigger).to_have_attribute('aria-expanded','true')
    expect(page.get_by_role('treeitem',name='Open memory/team.md',exact=True)).to_be_visible()
    page.keyboard.press('Enter')
    expect(trigger).to_have_attribute('aria-expanded','false')
    expect(trigger).to_be_focused()
    expect_editor_value(editor, edited)
    expect(page.get_by_role('treeitem',name='Open memory/team.md',exact=True)).not_to_be_visible()
    page.keyboard.press('Enter')
    target=page.get_by_role('treeitem',name='Open memory/team.md',exact=True)
    tab_to(page,target);page.keyboard.press('Enter')
    expect(trigger).to_have_attribute('aria-expanded','false')
    expect(trigger).to_be_focused()
    expect_editor_value(editor, FILES[-1]['text'])
    open_files(page)
    page.get_by_role('treeitem',name='Open AGENTS.md',exact=True).click()
    expect_editor_value(editor, edited)
    page.set_viewport_size(dict(width=1440,height=844))
    expect(trigger).not_to_be_visible()
    target=page.get_by_role('treeitem',name='Open memory/team.md',exact=True)
    tab_to(page,target)
    page.set_viewport_size(dict(width=390,height=844))
    expect(trigger).to_be_visible()
    expect(trigger).to_have_attribute('aria-expanded','false')
    expect(trigger).to_be_focused()
    expect_editor_value(editor, edited)
    editor.fill(original)
    return dict(keyboardToggle=True,closedControlsHidden=True,selectionCloses=True,selectionRestoresFocus=True,unsavedSourcePreserved=True,resizeRestoresFocus=True)


def checked_capture(failures, page, output, name, *, coarse=False, cdp=None):
    try:
        metrics=capture_native(page,cdp,output,name) if cdp else capture_layout(page,output,name,coarse=coarse)
        return assert_file_heading_metrics(metrics)
    except AssertionError as error:
        failures.append(dict(surface=name,error=str(error)))
        return json.loads((output/(name+'.json')).read_text())


def sdk_acceptance(page, failures, output, prefix, *, coarse=False, cdp=None):
    """Keep package installation, required access and observed output discoverable."""
    capture=lambda suffix: checked_capture(failures,page,output,prefix+'-sdk-'+suffix,coarse=coarse,cdp=cdp)
    checkout=page.get_by_role('button',name='Install from this checkout',exact=True)
    install=page.get_by_label('SDK package install command',exact=True)
    environment=page.get_by_label('Required environment variables',exact=True)
    variables=page.get_by_role('button',name='Environment variables and private directories',exact=True)
    expect(checkout).to_have_attribute('aria-expanded','false')
    expect(variables).to_have_attribute('aria-expanded','false')
    expect(install).to_be_visible()
    expect(install).to_contain_text('npm install /absolute/path/to/acclimate-sdk.tgz')
    expect(page.get_by_label('SDK build commands',exact=True)).not_to_be_visible()
    for name in ('ACCLIMATE_URL','ACCLIMATE_TOKEN','ACCLIMATE_SCOPE'):
        expect(environment.get_by_text(name,exact=True)).to_be_visible()
    recipe=page.get_by_label('SDK delivery recipe',exact=True)
    expected=recipe.get_by_text('Expected: the resolved version stays pinned for this job.',exact=False)
    expect(page.get_by_label('TypeScript delivery recipe',exact=True)).to_be_visible()
    expect(expected).to_be_visible()
    expect(expected).to_contain_text('reads every prepared file')
    expect(expected).to_contain_text('prints the version, digest and checked file count')
    expect(expected).to_contain_text('cleans up its prepared files')
    expect(recipe).to_contain_text('This check makes no model calls.')
    checkout.click()
    expect(page.get_by_label('SDK build commands',exact=True)).to_contain_text('npm pack --workspace @acclimate/sdk')
    page.get_by_role('heading',name='1. Install the SDK',exact=True).scroll_into_view_if_needed()
    capture('typescript-checkout')
    checkout.click()
    page.get_by_text('Python',exact=True).click()
    expect(checkout).to_have_attribute('aria-expanded','false')
    expect(install).to_contain_text('python3 -m pip install /absolute/path/to/acclimate-sdk.whl')
    expect(page.get_by_label('SDK build commands',exact=True)).not_to_be_visible()
    expect(page.get_by_label('Python delivery recipe',exact=True)).to_be_visible()
    expect(expected).to_be_visible()
    page.get_by_role('heading',name='1. Install the SDK',exact=True).scroll_into_view_if_needed()
    capture('python-install')
    checkout.click()
    expect(page.get_by_label('SDK build commands',exact=True)).to_contain_text('python3 -m pip wheel --no-deps --wheel-dir artifacts ./python')
    checkout.click()
    environment.scroll_into_view_if_needed()
    capture('required-environment')
    variables.click()
    expect(page.get_by_role('button',name='Copy API URL',exact=True)).to_be_visible()
    expect(page.get_by_text('Existing directories must be owned by the current user',exact=False)).to_be_visible()
    variables.scroll_into_view_if_needed()
    capture('private-directories')
    variables.click()
    recipe.scroll_into_view_if_needed()
    capture('delivery-output')
    return dict(packageInstallOutsideDisclosure=True,languages=['typescript','python'],requiredVariables=5,recipeVisibleByDefault=True,expectedOutputOutsideAdvancedDetails=True)



READ_IMPROVEMENT_ACTIONS = frozenset(('requests', 'proposals', 'proposal', 'candidate', 'comparison'))


def server_function_action(body):
    """Read only data.action from plain or Seroval JSON; unfamiliar shapes fail closed."""
    if not isinstance(body, dict):
        return None
    if 't' in body and 'data' in body:
        return None  # Ambiguous envelopes must never excuse a possible write.
    if isinstance(body.get('data'), dict):
        action = body['data'].get('action')
        return action if isinstance(action, str) else None

    def field(node, key):
        if not isinstance(node, dict) or node.get('t') != 10:
            return None
        properties = node.get('p')
        if not isinstance(properties, dict):
            return None
        keys, values = properties.get('k'), properties.get('v')
        if (not isinstance(keys, list) or not isinstance(values, list)
                or len(keys) != len(values) or not all(isinstance(k, str) for k in keys)
                or len(set(keys)) != len(keys) or key not in keys):
            return None
        return values[keys.index(key)]

    # TanStack serializes {data: input} through Seroval's JSON object/string nodes.
    # Do not search other fields: a nested read-like string cannot excuse a write.
    action = field(field(body.get('t'), 'data'), 'action')
    if isinstance(action, dict) and action.get('t') == 1 and isinstance(action.get('s'), str):
        return action['s']
    return None


def improvement_server_function_path():
    """Find this build's endpoint, without treating every call to it as a read."""
    ids = set()
    for module in (ROOT / 'apps/console/.output/server/_ssr').glob('improvement-actions-*.mjs'):
        ids.update(re.findall(
            r'id:\s*"([a-f0-9]+)",\s*name:\s*"runImprovement",\s*'
            r'filename:\s*"src/server/improvement-actions\.ts"', module.read_text()))
    assert len(ids) == 1, 'Cannot identify the built runImprovement transport; refusing read exemptions'
    return '/_serverFn/' + ids.pop()


def is_improvement_read(method, url, body, endpoint):
    return (method == 'POST' and urlsplit(url).path == endpoint
            and server_function_action(body) in READ_IMPROVEMENT_ACTIONS)


def evaluation_acceptance(w, b, failures, output):
    """Create one real request only after reviewing a separate disposable draft."""
    payload=dict(schemaVersion=1,files=[dict(file,text=file['text']+'\nReview the app-owned evaluation handoff.\n' if file['path']=='AGENTS.md' else file['text']) for file in FILES])
    draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=payload))
    path=b.bundle_path('changes',draft=draft['id'],candidate=draft['snapshotVersion']['id'],generation=draft['generation'])
    before=w.call('GET',w.bundle+'/evaluation-requests')['items']
    improvement_endpoint=improvement_server_function_path()
    transport=[]
    touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
    try:
        mobile=touch.new_page();mobile.on('pageerror',lambda error:b.errors.append(str(error)))
        surfaces=[(b.page,'desktop',False),(mobile,'mobile390',True)]
        for page,prefix,coarse in surfaces:
            visit(page,b,path)
            review=page.get_by_label('Saved change review',exact=True)
            expect(review).to_contain_text('Review the saved changes, then set up an evaluation to run in your app.')
            # A first-use review leads straight to setup, without an empty results panel.
            expect(page.get_by_label('Evaluation requests',exact=True)).to_have_count(0)
            setup=page.get_by_role('button',name='Set up evaluation request',exact=True)
            expect(setup).to_have_attribute('aria-expanded','true')
            create=page.get_by_role('button',name='Create evaluation request',exact=True)
            help=page.locator('[id="'+create.get_attribute('aria-describedby')+'"]')
            expect(help).to_be_visible()
            checked_capture(failures,page,output,prefix+'-saved-review-first-request',coarse=coarse)
            language=page.get_by_label('Evaluator language',exact=True)
            expect(language).to_have_value('javascript')
            expect(create).to_be_disabled()
            # Profile changes and disclosure controls may update local form state,
            # but must never submit a request or alter the published release.
            writes=[]
            def record(request):
                if request.method not in ('POST','PUT','PATCH','DELETE'):return
                # Read RPCs also use POST. Exempt only this build's improvement
                # endpoint with an explicitly decoded read action. Unknowns count.
                try:body=request.post_data_json
                except Exception:body=None
                action=server_function_action(body)
                read=is_improvement_read(request.method,request.url,body,improvement_endpoint)
                transport.append(dict(surface=prefix,method=request.method,
                    encoding='seroval-json' if isinstance(body,dict) and isinstance(body.get('t'),dict) else 'plain-or-unknown',
                    action=action if action in READ_IMPROVEMENT_ACTIONS else 'write-or-unknown',
                    knownRead=read))
                if not read:writes.append(dict(method=request.method,url=request.url,action=action))
            page.on('request',record)
            try:
                for value in ('python','javascript'):
                    language.select_option(value)
                    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==before
                config=page.get_by_label('Public evaluator configuration (JSON)',exact=True).filter(visible=True)
                expect(config).to_be_visible()
                edited_config=json.dumps(dict(datasetRevision='layout-public-v1',graderRevision='layout-grader-v1',runtime=dict(configId='layout-app',configRevision='1'),expectedCases=[dict(caseId='review',repetition=0)]),indent=2)
                config.fill(edited_config)
                expect(create).to_be_enabled()
                setup.scroll_into_view_if_needed()
                checked_capture(failures,page,output,prefix+'-saved-review-custom-setup',coarse=coarse)
                setup.click();expect(config).not_to_be_visible()
                setup.click();expect_editor_value(config, edited_config)
                assert not writes, 'Selecting or collapsing setup sent a mutation: '+str(writes)
                assert w.call('GET',w.bundle+'/evaluation-requests')['items']==before
                assert w.call('GET',w.channel)['version']==w.original['version']
            finally:
                page.remove_listener('request',record)
                (output/(prefix+'-request-transport.json')).write_text(json.dumps(transport,indent=2)+'\n')
        create=b.page.get_by_role('button',name='Create evaluation request',exact=True)
        tab_to(b.page,create)
        b.page.keyboard.press('Enter')
        expect(b.page.get_by_role('button',name='Create another evaluation request',exact=True)).to_have_attribute('aria-expanded','false')
        items=w.call('GET',w.bundle+'/evaluation-requests')['items']
        new=[row for row in items if row['id'] not in {item['id'] for item in before}]
        assert len(new)==1, 'Create must persist exactly one evaluation request'
        request=new[0]
        assert request['candidateVersionId']==draft['snapshotVersion']['id'] and request['status']=='requested'
        assert request['runtime']['configId']=='layout-app'
        created_trigger=b.page.locator('#evaluation-request-'+request['id'])
        expect(created_trigger).to_be_focused()
        for page,prefix,coarse in surfaces:
            visit(page,b,path)
            expect(page.get_by_label('Saved change review',exact=True)).to_contain_text('A request is ready. Run the evaluator in your app with its request ID and frozen configuration.')
            handoff=page.get_by_label('Evaluation request '+request['id'],exact=True)
            expect(handoff.get_by_role('button',name='Copy request ID',exact=True)).to_be_visible()
            expect(handoff.get_by_role('button',name='Copy handoff JSON',exact=True)).to_be_visible()
            expect(handoff).to_contain_text('Run in your app with the request ID and frozen public configuration.')
            handoff.scroll_into_view_if_needed()
            checked_capture(failures,page,output,prefix+'-evaluation-requested-handoff',coarse=coarse)
        w.call('POST',w.bundle+'/evaluation-requests/'+request['id']+'/start',dict(attemptId='compact-layout-v3-attempt'),actor='evaluator')
        total=len(request['expectedCases'])*2
        w.call('POST',w.bundle+'/evaluation-requests/'+request['id']+'/progress',
               dict(attemptId='compact-layout-v3-attempt',sequence=1,phase='grading',completed=1,total=total),actor='evaluator')
        for page,prefix,coarse in surfaces:
            visit(page,b,path)
            expect(page.get_by_label('Saved change review',exact=True)).to_contain_text('Your app last reported work running. Check the app for its current status.')
            handoff=page.get_by_label('Evaluation request '+request['id'],exact=True)
            expect(handoff).to_contain_text('App reported running')
            expect(handoff.get_by_role('region',name='Evaluator activity')).to_contain_text(f'grading · 1 / {total}', timeout=25000)
            expect(handoff).to_contain_text('Check the original worker before retrying.')
            expect(handoff).not_to_contain_text('Run in your app with the request ID and frozen public configuration.')
            expect(handoff.get_by_role('button',name='Copy handoff JSON',exact=True)).to_be_visible()
            expect(page.get_by_role('button',name='Create another evaluation request',exact=True)).to_have_attribute('aria-expanded','false')
            handoff.scroll_into_view_if_needed()
            checked_capture(failures,page,output,prefix+'-evaluation-running-handoff',coarse=coarse)
        assert w.call('GET',w.channel)['version']==w.original['version']
        assert len(w.call('GET',w.bundle+'/evaluation-requests')['items'])==len(before)+1
        return dict(firstRequestPrerequisites=True,languages=['javascript','python'],configurationAndDisclosureWrites=0,observedReadTransports=transport,createdRequests=1,createFocusHandoff=True,requestedAndRunningHandoff=True,releaseUnchanged=True)
    finally:touch.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--chrome-channel',default='chrome')
    args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,mode=0o700,exist_ok=False)
    w=World(pg_bin(args.pg_bin))
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        w.publish_initial('',files=FILES)
        candidate=dict(schemaVersion=1,files=[dict(file,text=file['text']+'\nUse a stable operation key.\n' if file['path']=='AGENTS.md' else file['text']) for file in FILES])
        w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=candidate))
        w.draft_path=w.channel+'/drafts/'+w.draft['id']
        w.request_evaluation();w.start_attempt();w.comparison();w.finish()
        w.create_integration()
        w.sign_in('_capture-operator','operator')
        w.call('POST','/v1/workspaces',dict(id='compact-secondary-'+w.h.project,name='Second fixture workspace'),actor='_capture-operator')
        b=w.browser();p=b.page
        keyboard=None;sdk_checks={};file_navigation={};geometry={}
        routes=dict(draft=b.bundle_path('changes',draft=w.draft['id'],path='AGENTS.md'),
            content=b.bundle_path('content'),
            evaluation=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=w.draft['generation']),
            releases=b.bundle_path('releases'),sdk=b.bundle_path('connect'),
            library=b.workspace_path(),members=b.workspace_path('members'),connections=b.workspace_path('connections'))
        p.set_viewport_size(dict(width=1440,height=900))
        desktop=[];failures=[]
        for name,path in routes.items():
            visit(p,b,path)
            if name=='draft':
                expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_enabled()
                p.get_by_role('textbox', name='Content', exact=True).fill(candidate['files'][0]['text']+'\nReview browser edits before saving.\n')
                expect(p.get_by_role('link',name='Evaluate saved generation 1',exact=True)).to_be_visible()
                expect(p.get_by_role('button',name='Save draft',exact=True)).to_be_enabled()
            metrics=checked_capture(failures,p,output,'desktop-'+name)
            if name=='draft':
                try:assert_compact_editor(metrics)
                except AssertionError as error:failures.append(dict(surface='desktop-draft-geometry',error=str(error)))
                geometry['desktopDraft']=dict(source=metrics['editor'],visibleSource=metrics['sourceVisibleHeight'],header=metrics['selectedHeader'])
                p.get_by_role('textbox', name='Content', exact=True).fill(candidate['files'][0]['text'])
            desktop.append(name)
        visit(p,b,routes['sdk'])
        sdk_checks['desktop']=sdk_acceptance(p,failures,output,'desktop')
        visit(p,b,routes['evaluation'])
        evidence_link=p.get_by_role('link',name=re.compile(r'^Inspect evidence for '))
        selected_evidence_url=b.base+evidence_link.get_attribute('href')
        evidence_link.click()
        expect(p).to_have_url(selected_evidence_url,timeout=30000)
        expect(p.get_by_role('region',name='Evaluation case comparison',exact=True)).to_be_visible(timeout=30000)
        checked_capture(failures,p,output,'desktop-selected-evidence')
        p.get_by_role('button',name='Review release with this evidence',exact=True).click()
        expect(p.get_by_role('dialog')).to_contain_text(w.draft['snapshotVersion']['id'])
        checked_capture(failures,p,output,'desktop-evidenced-release-dialog')
        p.keyboard.press('Escape')
        visit(p,b,routes['evaluation'])
        open_details(p,'Publish without evaluation')
        p.get_by_label('Manual release reason',exact=True).fill('Reviewing the saved snapshot without evaluation.')
        p.get_by_role('button',name='Review manual release',exact=True).click()
        expect(p.get_by_role('dialog')).to_contain_text('Reviewing the saved snapshot without evaluation.')
        checked_capture(failures,p,output,'desktop-manual-release-dialog')
        p.keyboard.press('Escape')
        p.get_by_label('Manual release reason',exact=True).fill('')
        assert w.call('GET',w.channel)['version']==w.original['version'], 'Opening release review published content'
        touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
        try:
            mobile=touch.new_page();mobile.on('pageerror',lambda error:b.errors.append(str(error)))
            for name,path in routes.items():
                visit(mobile,b,path)
                if name=='draft':
                    expect(mobile.get_by_role('textbox', name='Content', exact=True)).to_be_enabled()
                    expect(mobile.get_by_role('link',name='Back to changes',exact=True)).to_have_count(1)
                    mobile.get_by_role('textbox', name='Content', exact=True).fill(candidate['files'][0]['text']+'\nReview browser edits before saving.\n')
                    expect(draft_action(mobile,'Evaluate saved generation 1')).to_be_visible()
                    checked_capture(failures,mobile,output,'mobile390-draft-actions',coarse=True)
                    mobile.keyboard.press('Escape')
                    expect(mobile.get_by_role('button',name='Draft actions',exact=True)).to_be_focused()
                    draft_action(mobile,'Evaluate saved generation 1').click()
                    expect(mobile.get_by_role('alertdialog')).to_be_visible()
                    mobile.get_by_role('button',name='Keep editing',exact=True).click()
                    expect(mobile.get_by_role('button',name='Draft actions',exact=True)).to_be_focused()
                    expect_editor_value(mobile.get_by_role('textbox', name='Content', exact=True), candidate['files'][0]['text']+'\nReview browser edits before saving.\n')
                    expect(mobile.get_by_role('button',name='Save draft',exact=True)).to_be_enabled()
                    reset_editor_view(mobile)
                metrics=checked_capture(failures,mobile,output,'mobile390-'+name,coarse=True)
                if name=='draft' and metrics['editor']['top']>300:
                    failures.append(dict(surface='mobile390-source-start',editor=metrics['editor']))
                if name=='draft':mobile.get_by_role('textbox', name='Content', exact=True).fill(candidate['files'][0]['text'])
                if name=='content' and metrics['publishedContent']['top']>240:
                    failures.append(dict(surface='mobile390-published-source-start',source=metrics['publishedContent']))
                if name in ('draft','content'):
                    geometry['mobile390'+name.title()]=dict(source=metrics['editor'] or metrics['publishedContent'],visibleSource=metrics['sourceVisibleHeight'],header=metrics['selectedHeader'],files=metrics['fileNavigator'])
                    if name=='content':
                        before_drafts=w.call('GET',w.channel+'/drafts')['items']
                        file_navigation['mobilePublishedActions']=published_actions_acceptance(mobile,w.h.dir/'mobile-published-entry.md')
                        assert w.call('GET',w.channel+'/drafts')['items']==before_drafts, 'Published actions created or saved a draft'
            visit(mobile,b,routes['sdk'])
            sdk_checks['mobile390']=sdk_acceptance(mobile,failures,output,'mobile390',coarse=True)
            visit(mobile,b,routes['draft'])
            before_drafts=w.call('GET',w.channel+'/drafts')['items']
            file_navigation['mobile390']=narrow_files_acceptance(mobile)
            assert w.call('GET',w.channel+'/drafts')['items']==before_drafts, 'Responsive file navigation saved browser edits'
            visit(mobile,b,routes['draft']);open_files(mobile)
            checked_capture(failures,mobile,output,'mobile390-draft-files',coarse=True)
            mobile.get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
            expect(mobile.get_by_role('button',name='Files',exact=True)).to_have_attribute('aria-expanded','false')
            expect(mobile.get_by_role('button',name='Files',exact=True)).to_be_focused()
            mobile.get_by_role('button',name='Entry actions',exact=True).click()
            checked_capture(failures,mobile,output,'mobile390-entry-actions',coarse=True)
            mobile.keyboard.press('Escape')
            visit(mobile,b,routes['library'])
            menu=mobile.get_by_role('button',name='Open navigation',exact=True)
            menu.click()
            checked_capture(failures,mobile,output,'mobile390-navigation-open',coarse=True)
            mobile.keyboard.press('Escape');expect(menu).to_be_focused()
            mobile.set_viewport_size(dict(width=320,height=844))
            menu.click()
            checked_capture(failures,mobile,output,'mobile320-navigation-open',coarse=True)
            mobile.get_by_role('dialog').get_by_role('link',name='Members',exact=True).click()
            expect(mobile.get_by_role('dialog')).to_have_count(0)
            expect(mobile.get_by_role('main')).to_be_focused()
            visit(mobile,b,routes['draft'])
            checked_capture(failures,mobile,output,'mobile320-draft',coarse=True)
            tab_to(mobile,mobile.get_by_role('navigation',name='Bundle navigation',exact=True).get_by_role('link',name='Content',exact=True))
            checked_capture(failures,mobile,output,'mobile320-focused-tab',coarse=True)
            long_path='memory/release-guidelines/production-retry-contracts/provider-specific-evidence/retained-context.md'
            long_setup=w.call('POST',w.root+'/bundle-setups',dict(name='Production review instructions and reusable memory for background agent integrations',origin='created',channel='stable',payload=dict(schemaVersion=1,files=[dict(path=long_path,kind='memory',text='# Long path fixture\nKeep full paths readable without hover.\n')]),reason='Disposable long-name layout fixture.'))
            visit(mobile,b,b.bundle_path('content',bundle_id=long_setup['bundle']['id'],path=long_path))
            long_metrics=checked_capture(failures,mobile,output,'mobile320-long-scope',coarse=True)
            path_metrics=long_metrics['selectedPath']
            assert path_metrics and path_metrics['text']==long_path, path_metrics
            assert path_metrics['bounds']['height']>path_metrics['lineHeight']+1, path_metrics
            geometry['mobile320LongPath']=path_metrics
        finally:touch.close()
        with tempfile.TemporaryDirectory(prefix='acclimate-compact-zoom-') as profile:
            chrome=b.playwright.chromium.launch_persistent_context(profile,channel=args.chrome_channel,headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,800'])
            try:
                b.sign_in(chrome);zoom=chrome.pages[0]
                zoom.on('pageerror',lambda error:b.errors.append(str(error)))
                visit(zoom,b,routes['content']);baseline=zoom.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
                zoom.goto('chrome://settings/appearance',wait_until='domcontentloaded')
                zoom.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
                visit(zoom,b,routes['content'])
                zoom.wait_for_function('expected => Math.abs(innerWidth-expected)<2',arg=baseline['width']/2)
                assert zoom.evaluate('devicePixelRatio')==baseline['dpr']*2
                cdp=chrome.new_cdp_session(zoom)
                for name,path in routes.items():
                    visit(zoom,b,path)
                    if name=='draft':
                        editor=zoom.get_by_role('textbox', name='Content', exact=True)
                        editor.fill(candidate['files'][0]['text']+'\nReview browser edits before saving.\n')
                        reset_editor_view(zoom)
                    metrics=checked_capture(failures,zoom,output,'native200-'+name,cdp=cdp)
                    assert abs(metrics['viewport']-640)<=1,metrics
                    if name=='draft':
                        geometry['native200Draft']=dict(source=metrics['editor'],visibleSource=metrics['sourceVisibleHeight'],header=metrics['selectedHeader'],viewportHeight=metrics['viewportHeight'])
                        if metrics['sourceVisibleHeight']<115:failures.append(dict(surface='native200-first-source',editor=metrics['editor'],viewportHeight=metrics['viewportHeight']))
                        zoom.get_by_role('textbox', name='Content', exact=True).fill(candidate['files'][0]['text'])
                visit(zoom,b,routes['sdk'])
                sdk_checks['native200']=sdk_acceptance(zoom,failures,output,'native200',cdp=cdp)
            finally:chrome.close()
        keyboard=keyboard_workflow(w,b)
        evaluation=evaluation_acceptance(w,b,failures,output)
        assert not b.errors,b.errors
        summary=dict(passed=not failures,failures=failures,capturedStates=len(list(output.glob('*.png'))),desktop=desktop,mobile=dict(width=390,height=844,coarse=True),nativeZoom=dict(outerWidth=1280,outerHeight=800,zoom=2,cssWidth=640),geometry=geometry,fileNavigation=file_navigation,keyboard=keyboard,evaluation=evaluation,sdk=sdk_checks,fixture='disposable private PostgreSQL + real service, console, OIDC and TLS',paidModelCalls=0,browserErrors=[])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2))
        assert not failures, 'Layout acceptance failed; inspect screenshots/summary.json'
    finally:w.close()


if __name__=='__main__':main()
