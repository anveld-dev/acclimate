import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.bdd.interactions import close_draft_details
from scripts.productization.qualify import ROOT, payload
from scripts.bdd.interactions import open_entry_actions, close_entry_actions, open_content_actions, open_details, reveal, submit_and_wait


def page(context):
    return context.world.browser().page


def saved_draft(w):
    return w.call('GET',w.channel+'/drafts')['items'][0]


def ensure_editor(context):
    p=page(context)
    if p.get_by_role('textbox', name='Content', exact=True).count()==0:
        p.get_by_role('link',name='Edit entry',exact=True).click()
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_visible()


def save_browser(context):
    w=context.world
    p=page(context)
    before=w.call('GET',w.channel+'/drafts')['items']
    old={(row['id'],row['generation']) for row in before}
    submit_and_wait(p,p.get_by_role('button',name='Save draft',exact=True))
    for _ in range(100):
        rows=w.call('GET',w.channel+'/drafts')['items']
        saved=rows[0] if rows else None
        if saved and (saved['id'],saved['generation']) not in old: break
        time.sleep(.05)
    else: raise AssertionError('Browser save did not commit a new draft generation')
    expect(p).to_have_url(re.compile(r'[?&]draft='+saved['id']))
    # The URL can change before the saved-draft component has finished opening.
    # Wait for that real navigation/read boundary before editing another generation.
    p.wait_for_load_state('networkidle')
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_enabled(timeout=30000)
    expect(p.get_by_role('button',name='Save draft',exact=True)).to_be_disabled(timeout=30000)
    expect(p.get_by_role('link',name='Continue to evaluation',exact=True)).to_be_focused(timeout=30000)
    open_details(p,'Draft details')
    details=p.get_by_role('dialog',name='Draft details',exact=True)
    expect(details).to_contain_text(saved['id'])
    expect(details).to_contain_text('generation '+str(saved['generation']))
    close_draft_details(p)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_visible()
    # Reopening a saved route also reads its snapshot and history.
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_enabled(timeout=30000)


@given('I opened an empty console workspace')
def empty(context):
    w=context.world
    w.browser().visit('/setup')
    expect(page(context).get_by_role('heading',name='Give your agents a place to start',exact=True)).to_be_visible()
    page(context).get_by_role('button',name='Create your first bundle',exact=True).click()


@when('I create content from {source} in Bundles')
def create(context,source):
    p=page(context)
    p.get_by_label('Bundle name',exact=True).fill('Explicit BDD content')
    p.get_by_role('radio',name=source,exact=True).check()
    if source=='Write instructions':
        p.get_by_label('Instructions',exact=True).fill('Review code.')
    elif source=='Import JSON':
        p.get_by_label('Bundle JSON',exact=True).fill(json.dumps(payload('Review code.')))
    elif source=='Import files':
        p.get_by_label('Individual files',exact=True).set_input_files(
            dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'Review code.'))
    else: raise AssertionError(source)
    if source!='Write instructions':
        p.get_by_label('Confirm these entries for import',exact=True).check()
    summary=p.get_by_label('Initial publication summary',exact=True)
    expect(summary).to_contain_text('Publishes ')
    expect(summary).to_contain_text('to stable.')
    expect(summary).to_contain_text('No evaluation is run.')
    expect(summary).to_contain_text('Native compatibility is unchecked.')
    open_details(p,'Publishing settings')
    expect(p.get_by_label('Compatibility target',exact=True)).to_have_value('generic')
    expect(p.get_by_text('Fixed after creation. Choose your agent for native compatibility checks.',exact=True)).to_be_visible()
    assert context.world.call('GET',context.world.root+'/bundles')['items']==[]
    p.get_by_role('button',name='Create and publish' if source=='Write instructions' else 'Import and publish',exact=True).click()
    expect(p.get_by_role('navigation',name='Bundle navigation',exact=True)).to_be_visible(timeout=30000)


@then('the bundle is selected and its stored origin is {origin}')
def selected_origin(context,origin):
    w=context.world
    entries=w.call('GET',w.root+'/bundles')['items']
    assert len(entries)==1 and entries[0]['origin']==origin
    assert '/w/'+w.h.project+'/bundles/'+entries[0]['id']+'/' in page(context).url
    bundle=w.root+'/bundles/'+entries[0]['id']
    releases=w.call('GET',bundle+'/channels/stable/releases')['items']
    assert len(releases)==1 and releases[0]['unevaluatedReason']
    assert releases[0].get('comparisonId') is None
    assert w.call('GET',bundle+'/evaluation-requests')['items']==[]
    expect(page(context).get_by_test_id('entry-content')).to_be_visible()


@when('I submit invalid setup and then correct it')
def corrected(context):
    p=page(context)
    p.get_by_label('Bundle name',exact=True).fill('Corrected content')
    open_details(p,'Publishing settings')
    p.get_by_label('Initial channel',exact=True).fill('invalid channel')
    p.get_by_label('Instructions',exact=True).fill('Review code.')
    p.get_by_role('button',name='Create and publish',exact=True).click()
    expect(p.get_by_text('Use a channel name with letters, numbers, hyphens or underscores.',exact=True)).to_be_visible()
    open_details(p,'Publishing settings')
    p.get_by_label('Initial channel',exact=True).fill('stable')
    p.get_by_role('button',name='Create and publish',exact=True).click()
    expect(p.get_by_role('navigation',name='Bundle navigation',exact=True)).to_be_visible(timeout=30000)


@then('the corrected bundle is created once')
def once(context):
    w=context.world
    entries=w.call('GET',w.root+'/bundles')['items']
    assert [entry['name'] for entry in entries]==['Corrected content']


@given('a published bundle with instructions, a skill and reusable memory')
def mixed(context):
    context.world.publish_initial('',files=[dict(path='AGENTS.md',kind='instruction',text='Review code.'),dict(path='skills/review/SKILL.md',kind='skill',text='---\nname: review\ndescription: Review changes.\n---\nCheck retries.'),dict(path='memory/team.md',kind='memory',text='Reusable project notes.')])


@given('I opened its Content page')
def open_content(context):
    context.world.browser().select_bundle()
    expect(page(context).get_by_test_id('entry-content')).to_contain_text('Review code.')


@when('I filter published entries and download the memory file')
def filter_download(context):
    p=page(context)
    p.get_by_label('Published content',exact=True).fill('definitely-no-such-entry')
    p.get_by_role('button',name='Search published paths or content',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_text('No matching entries. Clear filters to see all content.',exact=True)).to_be_visible()
    p.get_by_role('button',name='Clear filters',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_label('Published content',exact=True)).to_have_value('')
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_be_visible()
    p.get_by_label('Published content',exact=True).fill('memory')
    p.get_by_role('button',name='Search published paths or content',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_role('treeitem',name='Open memory/team.md',exact=True)).to_be_visible()
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_have_count(0)
    p.get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
    actions=open_content_actions(p)
    with p.expect_download() as event:
        actions.get_by_role('button',name='Download published entry',exact=True).click()
    target=context.world.h.dir/'downloaded-memory.md'
    event.value.save_as(str(target))
    context.world.downloaded=target.read_text()


@then('the downloaded file contains the published memory')
def downloaded(context):
    assert context.world.downloaded=='Reusable project notes.'


@when('I add and rename an entry as shared memory')
def add_memory(context):
    ensure_editor(context)
    p=page(context)
    p.get_by_role('button',name='Add entry',exact=True).click()
    p.get_by_role('menuitem',name='Add instruction',exact=True).click()
    open_entry_actions(p)
    p.get_by_label('Entry path (rename)',exact=True).fill('memory/team.md')
    p.get_by_label('Entry kind',exact=True).select_option('memory')
    close_entry_actions(p)
    p.get_by_role('textbox', name='Content', exact=True).fill('Reusable project notes.')
    p.get_by_role('button',name='Review changes',exact=True).click()
    expect(p.get_by_text('Added: memory/team.md',exact=True)).to_be_visible()


@when('I save the browser draft')
def save(context):
    save_browser(context)


@then("reopening the draft preserves that entry's path, kind and text")
def memory_saved(context):
    w=context.world
    draft=saved_draft(w)
    w.browser().visit(w.browser_fixture.bundle_path('changes',draft=draft['id']))
    page(context).get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
    expect_editor_value(page(context).get_by_role('textbox', name='Content', exact=True), 'Reusable project notes.')
    assert w.call('GET',w.bundle+'/versions/'+draft['snapshotVersion']['id']+'/payload')['files'][-1]==dict(path='memory/team.md',kind='memory',text='Reusable project notes.')


@when('I add a skill with a support file and rename the package')
def rename_skill(context):
    ensure_editor(context)
    p=page(context)
    p.get_by_role('button',name='Add entry',exact=True).click()
    p.get_by_role('menuitem',name='Add skill package',exact=True).click()
    open_entry_actions(p)
    p.get_by_role('button',name='Add skill support file',exact=True).click()
    close_entry_actions(p)
    p.get_by_role('textbox', name='Content', exact=True).fill('Supporting review notes.')
    open_entry_actions(p)
    p.get_by_label('Rename entire skill package',exact=True).fill('review-rules')
    p.get_by_role('button',name='Apply package rename',exact=True).click()
    close_entry_actions(p)


@then('both skill paths and the manifest name use the new package name')
def renamed(context):
    w=context.world
    draft=saved_draft(w)
    files=w.call('GET',w.bundle+'/versions/'+draft['snapshotVersion']['id']+'/payload')['files']
    skills=[entry for entry in files if entry['kind']=='skill']
    assert len(skills)==2
    assert all(entry['path'].startswith('skills/review-rules/') for entry in skills)
    assert 'name: review-rules' in next(entry['text'] for entry in skills if entry['path'].endswith('SKILL.md'))


@when('I remove that skill package and save again')
def remove_skill(context):
    p=page(context)
    p.get_by_role('treeitem',name='Open skills/review-rules/SKILL.md',exact=True).click()
    open_entry_actions(p)
    p.get_by_role('button',name='Remove skill package',exact=True).click()
    close_entry_actions(p)
    save_browser(context)


@then('neither its manifest nor its support files remain')
def no_orphans(context):
    w=context.world
    draft=saved_draft(w)
    files=w.call('GET',w.bundle+'/versions/'+draft['snapshotVersion']['id']+'/payload')['files']
    assert files==[dict(path='AGENTS.md',kind='instruction',text='Review code.')]


@when('I select a bundle folder containing a skill and support file')
def folder(context):
    ensure_editor(context)
    w=context.world
    root=w.h.dir/'import-root'
    (root/'skills/import-review/references').mkdir(parents=True)
    (root/'skills/import-review/SKILL.md').write_text('---\nname: import-review\ndescription: Review imported changes.\n---\nCheck retries.')
    (root/'skills/import-review/references/notes.md').write_text('Supporting import notes.')
    page(context).get_by_role('button',name='Import files into this draft',exact=True).click()
    expect(page(context).get_by_role('dialog',name='Import files into this draft',exact=True)).to_be_visible()
    page(context).get_by_label('Bundle folder',exact=True).set_input_files(str(root))


@then('both relative skill paths appear in the import preview')
def preview(context):
    p=page(context)
    expect(p.get_by_role('heading',name='Ready to add · 2 files',exact=True)).to_be_visible()
    for path in ['skills/import-review/SKILL.md','skills/import-review/references/notes.md']:
        row=p.get_by_role('listitem').filter(has=p.get_by_text(path,exact=True))
        expect(row.get_by_text(path,exact=True)).to_be_visible()
        expect(row.get_by_text('skill',exact=True)).to_be_visible()


@when('I apply the preview and save the browser draft')
def apply(context):
    page(context).get_by_role('button',name=re.compile(r'^Add \d+ files? to draft$')).click()
    save_browser(context)


@then('the saved bundle contains the complete skill package')
def imported(context):
    w=context.world
    draft=saved_draft(w)
    paths=[entry['path'] for entry in w.call('GET',w.bundle+'/versions/'+draft['snapshotVersion']['id']+'/payload')['files']]
    assert set(paths)=={'AGENTS.md','skills/import-review/SKILL.md','skills/import-review/references/notes.md'}


@when('I select an import with {invalid}')
def bad_import(context,invalid):
    ensure_editor(context)
    if invalid=='a collision': name,content='AGENTS.md',b'Do not replace published instructions.'
    elif invalid=='invalid UTF-8': name,content='invalid.md',b'\xff\xfe'
    elif invalid=='a flat skill': name,content='SKILL.md',b'---\nname: review\ndescription: Review changes.\n---\nCheck.'
    else: raise AssertionError(invalid)
    page(context).get_by_role('button',name='Import files into this draft',exact=True).click()
    expect(page(context).get_by_role('dialog',name='Import files into this draft',exact=True)).to_be_visible()
    page(context).get_by_label('Individual files',exact=True).set_input_files(dict(name=name,mimeType='text/plain',buffer=content))


@then('the import is rejected and the original text remains')
def rejected_import(context):
    p=page(context)
    expect(p.get_by_role('alert').filter(has_text='Nothing was imported.')).to_be_visible()
    expect(p.get_by_role('button',name=re.compile(r'^Add \d+ files? to draft$'))).to_have_count(0)
    # Modal isolation correctly removes the background editor from the accessible tree.
    # Dismiss the rejected import through native Escape before checking its exact bytes.
    p.keyboard.press('Escape')
    expect(p.get_by_role('dialog',name='Import files into this draft',exact=True)).to_have_count(0)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Review code.')


@when('I edit text and try to navigate away')
def leave(context):
    ensure_editor(context)
    p=page(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Unsaved browser edits.')
    p.get_by_role('link',name='Releases',exact=True).click()
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()


@when('I choose to {choice}')
def navigation_choice(context,choice):
    page(context).get_by_role('button',name='Keep editing' if choice=='keep editing' else 'Leave editor',exact=True).click()


@then('the unsaved edit is {outcome}')
def navigation_result(context,outcome):
    w=context.world
    p=page(context)
    if outcome=='preserved':
        expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Unsaved browser edits.')
    else:
        expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.bundle_path('releases'))
        w.browser_fixture.visit('/content')
        expect(p.get_by_test_id('entry-content')).to_contain_text('Review code.')


@when('I save two browser draft generations')
def generations(context):
    ensure_editor(context)
    w=context.world
    p=page(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Review retries.')
    save_browser(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Review duplicate retries.')
    save_browser(context)
    w.browser_saved=saved_draft(w)
    w.browser_bookmark=p.url


@when('I close the browser and restart the service')
def browser_restart(context):
    w=context.world
    w.browser_fixture.restart_browser()
    w.h.restart()


@then('the saved generation reopens with its exact snapshot and history')
def browser_reopened(context):
    w=context.world
    w.browser_fixture.visit(w.browser_bookmark.removeprefix(w.browser_fixture.base))
    p=page(context)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Review duplicate retries.')
    open_details(p,'Draft details')
    details=p.get_by_role('dialog',name='Draft details',exact=True)
    expect(details).to_contain_text(w.browser_saved['id'])
    expect(details).to_contain_text(w.browser_saved['snapshotVersion']['id'])
    expect(details.get_by_role('heading',name='Saved snapshot history',exact=True)).to_be_visible()
    expect(p.get_by_text('Generation 1:',exact=False)).to_be_visible()
    expect(details.get_by_text('Generation 2:',exact=False)).to_be_visible()
    close_draft_details(p)


@when('I edit text and choose to leave the editor during refresh')
def discard_refresh(context):
    ensure_editor(context)
    p=page(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Unsaved browser edits.')
    p.once('dialog',lambda dialog:dialog.accept())
    p.reload(wait_until='networkidle')


@then('the unsaved text is replaced with the published content')
def refresh_discarded(context):
    expect_editor_value(page(context).get_by_role('textbox', name='Content', exact=True), 'Review code.')


@given('I opened a new draft for that entry')
def new_editor(context):
    ensure_editor(context)


@when('another operator publishes "{text}"')
def other_release(context,text):
    w=context.world
    current = w.call('GET', w.channel)
    version=w.call('POST',w.bundle+'/versions',dict(parentVersionId=current['version']['id'],payload=payload(text)))
    w.external_promotion = w.manual_release(version)


@when('I refresh the console')
def refresh(context):
    page(context).once('dialog',lambda dialog:dialog.accept())
    page(context).reload(wait_until='networkidle')


@then('a new browser draft starts with "{text}"')
def fresh_new(context,text):
    expect_editor_value(page(context).get_by_role('textbox', name='Content', exact=True), text)


def install_browser_evaluator(w, p):
    from scripts.packaging.fixture_application import install_test_application

    app = w.h.dir / ('evaluation-app-' + w.h.project)
    app.mkdir(mode=0o700)
    cases = install_test_application(app, "python")
    w.evaluator_app = app
    w.evaluator_env = dict(w.h.env, PYTHONPATH=str(ROOT/'python'), PYTHONDONTWRITEBYTECODE='1',
                           ACCLIMATE_EVALUATOR_CASES=cases, SSL_CERT_FILE=str(w.browser_fixture.ca_path))
    described = subprocess.run([sys.executable, '-m', 'acclimate', 'describe'], cwd=app,
                               env=w.evaluator_env, text=True, capture_output=True, check=True)
    section = p.get_by_role('region', name='Create evaluation request', exact=True)
    section.get_by_label('Evaluator language', exact=True).select_option('python')
    section.get_by_label('Public evaluator configuration (JSON)', exact=True).filter(visible=True).fill(described.stdout)


@when('I save a browser draft and request its evaluation')
def browser_evaluation(context):
    ensure_editor(context)
    w=context.world
    p=page(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Review retries.')
    save_browser(context)
    w.browser_saved=saved_draft(w)
    p.get_by_role('link',name='Continue to evaluation',exact=True).click()
    open_details(p,'Set up evaluation request')
    expect(p.get_by_role('button',name='Create evaluation request',exact=True)).to_be_disabled()
    install_browser_evaluator(w, p)
    p.get_by_role('button',name='Create evaluation request',exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
    w.browser_request=w.call('GET',w.bundle+'/evaluation-requests')['items'][0]


@when('the test application runs the downloaded handoff using the displayed command')
def external_app(context):
    w=context.world
    import json
    config_root=w.evaluator_app
    config_root.mkdir(mode=0o700,exist_ok=True)
    config_path=config_root/'evaluator.json'
    config=dict(schemaVersion=1,serviceUrl=w.browser_fixture.base,projectId=w.h.project,
                evaluatorToken=w.h.tokens['evaluator'],evaluatorPrincipalId='evaluator',
                journalRoot=str(config_root/'journal'))
    config_path.write_text(json.dumps(config))
    config_path.chmod(0o600)
    p=w.browser_fixture.page
    p.get_by_role('button',name='Copy instructions for evaluator owner',exact=True).click()
    instructions=p.evaluate('navigator.clipboard.readText()')
    assert w.browser_fixture.base+'/evaluator-setup.html#python' in instructions and 'python -m acclimate doctor' in instructions
    assert json.loads(instructions[instructions.index('{'):])['requestId']==w.browser_request['id']
    guide=p.request.get(w.browser_fixture.base+'/evaluator-setup.html')
    assert guide.ok and 'def execute(run)' in guide.text() and 'def grade(run)' in guide.text()
    p.get_by_role('button',name='Copy request ID',exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()') == w.browser_request['id']
    p.get_by_role('button',name='Copy request JSON',exact=True).click()
    handoff=json.loads(p.evaluate('navigator.clipboard.readText()'))
    assert handoff['projectId']==w.h.project and handoff['bundleId']==w.setup['bundle']['id']
    assert handoff['requestId']==w.browser_request['id']
    assert not any(key in handoff for key in ('evaluatorToken','journalRoot','consoleToken','loginToken'))
    with p.expect_download() as pending_download:
        p.get_by_role('button',name='Download request JSON',exact=True).click()
    download=pending_download.value
    assert download.suggested_filename=='evaluation-request.json'
    downloaded_path=config_root/'downloaded-evaluation-request.json'
    download.save_as(downloaded_path)
    downloaded_text=downloaded_path.read_text()
    downloaded=json.loads(downloaded_text)
    assert downloaded==handoff, 'Downloaded public request must equal the clipboard handoff'
    forbidden={'evaluatorToken','journalRoot','consoleToken','loginToken','readToken',
               'configPath','privateJobDirectory','stateRoot','journalPath'}
    def assert_public_fields(value):
        if isinstance(value,dict):
            assert not forbidden.intersection(value), 'Download contains private configuration fields'
            for nested in value.values(): assert_public_fields(nested)
        elif isinstance(value,list):
            for nested in value: assert_public_fields(nested)
    assert_public_fields(downloaded)
    for private_value in [*w.h.tokens.values(),w.console_token,w.login_token,
                          str(config_path),config['journalRoot']]:
        assert private_value not in downloaded_text, 'Download contains private fixture material'
    p.get_by_role('button', name='Copy evaluator run command', exact=True).click()
    command=shlex.split(p.evaluate('navigator.clipboard.readText()'))
    assert command == ['python','-m','acclimate','compare','--config','/absolute/private/evaluator.json',
                       '--handoff','evaluation-request.json','--live']
    command[0]=sys.executable
    command[command.index('--config')+1]=str(config_path)
    command[command.index('--handoff')+1]=str(downloaded_path)
    # This evaluator directory contains only the test application installed above.
    result=subprocess.run(command,cwd=w.evaluator_app,env=w.evaluator_env,capture_output=True,text=True,timeout=60)
    assert result.returncode==0,'Installed app evaluator failed: '+result.stderr[-1500:]



def inspect_case_and_scores(p):
    workspace = p.get_by_role('region',name='Evaluation case comparison',exact=True)
    matrix = workspace.get_by_role('table',name='Selected parent and candidate outcomes')
    expect(matrix).to_be_visible(timeout=30000)
    expect(matrix.get_by_role('columnheader',name=re.compile(r'^Parent'))).to_be_visible()
    expect(matrix.get_by_role('columnheader',name=re.compile(r'^Candidate'))).to_be_visible()
    workspace.get_by_role('button',name='View case JSON',exact=True).click()
    case = json.loads(workspace.get_by_label('Case evidence JSON').inner_text())
    assert case['comparisonId'] and case['parentVersionId'] and case['candidateVersionId']
    workspace.get_by_role('button',name='View case JSON',exact=True).click()
    p.get_by_role('tab',name='Details',exact=True).click()
    return p.get_by_role('region',name='Observed paired rewards',exact=True)


@when('I review the failed policy and publish with an override reason')
def review_publish(context, expected_verdict='fail'):
    p=page(context)
    p.reload()
    # The review opens on the newest completed result; return to its runs to inspect it.
    expect(p).to_have_url(re.compile(r'[?&]comparison='),timeout=30000)
    p.get_by_role('tab',name=re.compile(r'^Evaluation runs')).click()
    evidence=p.get_by_role('link',name=re.compile(r'^Inspect evidence for '))
    href=evidence.get_attribute('href')
    evidence.click()
    expect(p).to_have_url(context.world.browser_fixture.base+href,timeout=30000)
    rewards=inspect_case_and_scores(p)
    expect(rewards.get_by_text('Complete evidence',exact=True)).to_be_visible(timeout=30000)
    expect(rewards.get_by_text('Missing grades · expected outcomes',exact=True).locator('..').locator('dd')).to_have_text('0')
    expected_pairs=len(context.world.browser_request['expectedCases'])
    expect(rewards.get_by_text('Scored pairs',exact=True).locator('..').locator('dd')).to_have_text(f'{expected_pairs} / {expected_pairs}')
    expect(rewards.get_by_text('Execution failures · expected outcomes',exact=True).locator('..').locator('dd')).to_have_text('0')
    p.get_by_role('tab',name='Evaluation runs',exact=False).click()
    policy=p.get_by_label('Application policy check', exact=True)
    policy.get_by_role('button',name='Policy check command',exact=True).click()
    expect(policy.get_by_label('Evaluator language', exact=True)).to_have_value('python')
    expect(policy.get_by_text('No policy verdict has been reported for this comparison.',exact=True)).to_be_visible()
    policy.get_by_role('button',name='Copy policy check command',exact=True).click()
    command=shlex.split(p.evaluate('navigator.clipboard.readText()'))
    assert command == ['python','-m','acclimate','check','--config','/absolute/private/evaluator.json',
                       '--handoff','evaluation-request.json','--policy','quality-policy.json']
    w=context.world
    command[0]=sys.executable
    command[command.index('--config')+1]=str(w.evaluator_app/'evaluator.json')
    command[command.index('--handoff')+1]=str(w.evaluator_app/'downloaded-evaluation-request.json')
    result=subprocess.run(command,cwd=w.evaluator_app,env=w.evaluator_env,capture_output=True,text=True,timeout=60)
    assert result.returncode=={'fail':2,'pass':0}[expected_verdict] and json.loads(result.stdout)['verdict']==expected_verdict
    policy.get_by_role('button',name='Refresh policy checks',exact=True).click()
    expect(policy.get_by_text({'fail':'Failed','pass':'Passed'}[expected_verdict],exact=True)).to_be_visible()
    if expected_verdict=='fail':
        expect(policy.get_by_text('Minimum mean improvement',exact=True)).to_be_visible()
    p.get_by_role('button',name='Review release with this evidence',exact=True).click()
    dialog=p.get_by_role('dialog',name='Publish to stable?',exact=True)
    expect(dialog).to_contain_text('generation')
    if expected_verdict=='fail':
        publish=dialog.get_by_role('button',name='Override policy and publish',exact=True)
        expect(publish).to_be_disabled()
        dialog.get_by_label('Reason for overriding policy',exact=True).fill('Reviewer accepted the unchanged score for a scoped rollout.')
    else:
        expect(dialog.get_by_label('Reason for overriding policy',exact=True)).to_have_count(0)
        publish=dialog.get_by_role('button',name='Publish with selected evidence',exact=True)
    submit_and_wait(p,publish)
    expect(p.get_by_role('status').filter(has_text='Release recorded.')).to_be_visible()


@then('the release records the evaluated snapshot, overridden policy and reviewer reason')
def exact_published(context):
    w=context.world
    assert w.call('GET',w.channel)['version']==w.browser_saved['snapshotVersion']
    promotion=w.call('GET',w.channel+'/releases')['items'][0]
    receipt=w.call('GET',w.bundle+'/comparisons/'+promotion['comparisonId']+'/policy-receipts')['items'][0]
    assert promotion['policyOverride']=={'reason':'Reviewer accepted the unchanged score for a scoped rollout.',
        'receipts':[{'comparisonId':receipt['comparisonId'],'policyDigest':receipt['policy']['sha256']}]}
    p=page(context)
    expect(p.get_by_role('button',name='Review release with this evidence',exact=True,include_hidden=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Review manual release',exact=True,include_hidden=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Publish without evaluation',exact=True,include_hidden=True)).to_have_count(0)
    expect(p.get_by_label('Manual release reason',exact=True)).to_have_count(0)
    expect(p.locator('[data-slot=disclosure-trigger]').filter(has_text='Publish without evaluation')).to_have_count(0)


@given('a draft with a comparison that has no returned grades')
def no_grades(context):
    w=context.world
    w.publish_initial('Review code.')
    w.save_new('Review retries.')
    w.request_evaluation()
    w.start_attempt()
    w.comparison(outcome='missing grades')
    w.finish()
    endpoint=w.bundle+'/comparisons/'+w.report['id']+'/policy-receipts'
    receipt={'requestId':w.evaluation['id'],'attemptId':w.attempt,
             'policy':{'id':'coverage','revision':'1','sha256':'sha256:'+'1'*64},
             'verdict':'indeterminate','checks':[{'code':'evidence.incomplete','result':'unknown'}]}
    denied=w.call('POST',endpoint,receipt,actor='other',expected=409)
    assert denied['error']['code']=='policy_binding_mismatch'
    saved=w.call('POST',endpoint,receipt,actor='evaluator')
    assert saved==w.call('POST',endpoint,receipt,actor='evaluator'), 'Same evidence and policy must yield the original receipt'
    invalid=dict(receipt,checks=[{'code':'private.output','result':'unknown'}])
    w.call('POST',endpoint,invalid,actor='evaluator',expected=400)
    w.call('POST',endpoint,dict(receipt,policy=dict(receipt['policy'],revision='changed')),actor='evaluator',expected=409)
    assert w.call('GET',endpoint)['items']==[saved]
    assert w.call('GET',w.bundle+'/versions/'+w.draft['snapshotVersion']['id']+'/policy-receipts')['items']==[saved]



@when('I inspect that comparison in the console')
def inspect_partial(context):
    w=context.world
    w.browser().select_bundle()
    w.browser_fixture.visit(w.browser_fixture.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=w.draft['generation'],comparison=w.report['id']))
    p=page(context)
    rewards=inspect_case_and_scores(p)
    expect(rewards.get_by_text('Partial evidence',exact=True)).to_be_visible()


@then('the page shows 4 missing grades and unknown cost')
def honest_incomplete(context):
    p=page(context)
    rewards=p.get_by_role('region',name='Observed paired rewards',exact=True)
    expect(rewards.get_by_text('Missing grades · expected outcomes',exact=True).locator('..').locator('dd')).to_have_text('4')
    expect(rewards.get_by_text('Reported cost · expected outcomes',exact=True).locator('..').locator('dd')).to_have_text('Unknown')


@then('measured publication is unavailable')
def no_measured(context):
    expect(page(context).get_by_role('button',name='Review release with this evidence',exact=True)).to_be_disabled()


@when('I inspect the old release and restore it through the console')
def restore(context):
    w=context.world
    w.browser().select_bundle()
    w.browser_fixture.visit('/releases')
    p=page(context)
    p.get_by_role('button',name=re.compile(r'^Compare Revision 1\b',re.I)).click()
    detail=p.get_by_role('region',name='Comparison for revision 1',exact=True)
    detail.get_by_role('button',name='Inspect content for revision 1',exact=True).click()
    expect(p.get_by_role('heading',name='Version content',exact=True)).to_be_visible()
    expect(p.get_by_label('Content of AGENTS.md',exact=True)).to_contain_text('Review code.')
    with p.expect_download() as event:
        p.get_by_role('dialog').get_by_role('button',name='Download',exact=True).click()
    target=w.h.dir/'old-release.md'
    event.value.save_as(str(target))
    assert target.read_text()=='Review code.'
    p.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
    detail.get_by_role('button',name='Restore revision 1',exact=True).click()
    p.get_by_label('Reason for restoring',exact=True).fill('BDD operator rollback.')
    p.get_by_role('button',name='Restore version',exact=True).click()
    expect(p.get_by_role('article',name='Revision 3 · Current',exact=True)).to_be_visible()


@then('the original content is current at revision 3 with the restore reason')
def restored(context):
    w=context.world
    current=w.call('GET',w.channel)
    assert current['revision']=='3' and current['version']==w.original['version']
    latest=w.call('GET',w.channel+'/releases')['items'][0]
    assert latest['unevaluatedReason'].endswith('BDD operator rollback.')


def open_restore_review(p, current_revision):
    p.get_by_role('button', name=re.compile(r'^Compare Revision 1\b', re.I)).click()
    p.get_by_role('button', name='Restore revision 1', exact=True).click()
    dialog = p.get_by_role('dialog', name='Restore revision 1?', exact=True)
    expect(dialog).to_contain_text(f'current stable release (revision {current_revision})')
    expect(dialog.get_by_label('Reason for restoring')).to_have_value('')
    return dialog


@when('I open a restore of revision 1 against revision 2')
def review_original_restore(context):
    w = context.world
    w.browser().visit('/releases')
    dialog = open_restore_review(page(context), '2')
    dialog.get_by_label('Reason for restoring').fill('Reviewed the second release.')


@when('I confirm the restore I reviewed')
def submit_original_restore(context):
    page(context).get_by_role('dialog').get_by_role('button', name='Restore version', exact=True).click()


@then("the console explains the conflict and the other operator's revision 3 still serves")
def stale_restore_rejected(context):
    w = context.world
    dialog = page(context).get_by_role('dialog', name='Restore revision 1?')
    expect(dialog.get_by_role('alert')).to_contain_text(re.compile('release changed', re.I))
    expect(dialog.get_by_role('button', name='Review current release', exact=True)).to_be_enabled()
    current = w.call('GET', w.channel)
    assert current['revision'] == '3' and current['version'] == w.external_promotion['version']
    w.history_before_retry = w.call('GET', w.channel + '/releases')['items']
    assert w.history_before_retry[0]['id'] == w.external_promotion['id']


@when('I review the current release and confirm a new restore against revision 3')
def review_new_restore(context):
    p = page(context)
    p.get_by_role('button', name='Review current release', exact=True).click()
    expect(p.get_by_role('article', name='Revision 3 · Current', exact=True)).to_be_visible()
    current = p.get_by_role('region', name='Comparison for revision 3', exact=True)
    expect(current).to_be_visible()
    current.get_by_role('button', name='Inspect content for revision 3', exact=True).click()
    expect(p.get_by_label('Content of AGENTS.md', exact=True)).to_contain_text('Review retry limits.')
    p.get_by_role('dialog').get_by_role('button', name='Close', exact=True).click()
    dialog = open_restore_review(p, '3')
    dialog.get_by_label('Reason for restoring').fill('Reviewed revision 3 before restoring.')
    dialog.get_by_role('button', name='Restore version', exact=True).click()


@then("exactly one restore follows the other operator's release in history")
def restore_after_new_review(context):
    w = context.world
    expect(page(context).get_by_role('article', name='Revision 4 · Current', exact=True)).to_be_visible()
    current = w.call('GET', w.channel)
    assert current['revision'] == '4' and current['version'] == w.original['version']
    restored, *previous = w.call('GET', w.channel + '/releases')['items']
    assert previous == w.history_before_retry
    assert restored['revision'] == '4' and restored['version'] == w.original['version']
    assert restored['previousVersionId'] == w.external_promotion['version']['id']
    assert restored['unevaluatedReason'].endswith('Reviewed revision 3 before restoring.')


@when('I create an integration and issue a read credential in the console')
def ui_issue(context):
    w=context.world
    w.browser().select_bundle()
    w.browser_fixture.visit('/integrations')
    p=page(context)
    p.get_by_role('button',name='New connection',exact=True).click()
    p.get_by_label('Display name',exact=True).fill('BDD browser app')
    p.get_by_label('Bundle',exact=True).select_option(w.setup['bundle']['id'])
    p.get_by_label('Channel',exact=True).select_option('stable')
    p.get_by_role('button',name='Create connection',exact=True).click()
    p.get_by_role('button',name='Create read credential',exact=True).click()
    expect(p.get_by_role('heading',name='Save this credential now',exact=True)).to_be_visible()
    w.ui_secret=p.get_by_role('dialog').get_by_label('One-time credential secret',exact=True).input_value()
    w.ui_credential_id=p.get_by_role('dialog').locator('code').inner_text()
    w.h.tokens['issued-browser']=w.ui_secret


@then('its secret is shown once and missing delivery is labelled unknown')
def secret_once(context):
    w=context.world
    assert w.ui_secret.startswith('aci_')
    p=page(context)
    expect(p.get_by_role('dialog')).to_contain_text('secret appears only once')
    # The status underneath remains factual; closing the dialog makes it visible.


@when('I close the secret dialog and revoke that credential')
def ui_revoke(context):
    p=page(context)
    p.get_by_role('button',name='I saved it · close',exact=True).click()
    p.get_by_role('tab',name='Delivery reports',exact=True).click()
    expect(p.get_by_text('No delivery report received; status unknown.',exact=False)).to_be_visible()
    p.get_by_role('tab',name='Credentials',exact=True).click()
    p.get_by_role('button',name=re.compile(r'^Revoke (read|reporting) credential ')).click()
    submit_and_wait(p,p.get_by_role('dialog').get_by_role('button',name='Revoke',exact=True))
    row=p.locator('code').filter(has_text=re.compile('^'+re.escape(context.world.ui_credential_id)+'$')).locator('../..')
    expect(row.get_by_text('Read credential · Revoked',exact=True)).to_be_visible()
    expect(row.get_by_role('button',name=re.compile(r'^Revoke (read|reporting) credential '))).to_be_disabled()


@then('the closed secret is not displayed and its next fetch is denied')
def revoked_secret(context):
    w=context.world
    expect(page(context).get_by_label('One-time credential secret',exact=True)).to_have_count(0)
    expect(page(context).get_by_text(w.ui_secret,exact=True)).to_have_count(0)
    w.call('GET',w.channel,actor='issued-browser',expected=403)


@then('the page shows the last read and unknown current state without editable content')
def failed_read(context):
    p=page(context)
    expect(p.get_by_text('Could not connect',exact=True)).to_be_visible()
    expect(p.get_by_text(re.compile(r'Last read at .*Content is hidden until a verified refresh succeeds\.'))).to_be_visible()
    expect(p.get_by_test_id('entry-content')).to_have_count(0)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Save draft',exact=True)).to_have_count(0)


@when('I visit every main route at desktop and mobile sizes')
def routes(context):
    w=context.world
    p=page(context)
    from scripts.bdd.layout import capture_layout
    artifact_dir=Path(context.config.userdata['artifact_dir'])/'ui-layout'
    # Wait for a data-backed result or route action before measuring each layout.
    routes = {
        '/content': lambda page: page.get_by_test_id('entry-content'),
        '/improvement': lambda page: page.get_by_role('link', name='New draft', exact=True),
        '/releases': lambda page: page.get_by_test_id('release-decision').first,
        '/setup': lambda page: page.get_by_role('link', name='BDD bundle', exact=True),
        '/integrations': lambda page: page.get_by_role('button', name='New connection', exact=True),
        '/connect': lambda page: page.get_by_role('button', name='Copy install command', exact=True),
    }

    def visit_route(page, route):
        w.browser_fixture.visit(route, page=page)
        expect(routes[route](page)).to_be_visible()
        page.evaluate('document.fonts.ready.then(() => true)')

    for width in (1440,1024,768,390,320):
        p.set_viewport_size(dict(width=width,height=1000))
        for route in routes:
            visit_route(p, route)
            capture_layout(p,artifact_dir,f'{width}-{route[1:]}')
        if width==390:
            trigger=p.get_by_role('button',name='Open navigation',exact=True)
            trigger.click()
            capture_layout(p,artifact_dir,'390-navigation-open')
            p.get_by_role('dialog').get_by_role('link',name='Bundles',exact=True).click()
            expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.workspace_path())
    p.set_viewport_size(dict(width=1440,height=1000))
    for route in routes:
        visit_route(p, route)
        # Chromium's CSS zoom exercises 200% text/control scaling and reflow in
        # headless acceptance; native browser zoom is also checked interactively.
        p.evaluate("document.documentElement.style.zoom='2'")
        capture_layout(p,artifact_dir,'zoom200-'+route[1:])
    p.evaluate("document.documentElement.style.zoom=''")
    # A fresh touch context makes CSS pointer:coarse rules real, rather than
    # overriding matchMedia or testing the desktop targets at a narrow width.
    b=w.browser_fixture
    touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=1000),has_touch=True,
                                storage_state=b.context.storage_state())
    try:
        touch_page=touch.new_page()
        touch_page.on('pageerror',lambda error:b.errors.append(str(error)))
        for route in routes:
            visit_route(touch_page, route)
            capture_layout(touch_page,artifact_dir,'coarse390-'+route[1:],coarse=True)
    finally:
        touch.close()


@then('the routes have no browser errors or horizontal overflow')
def readable(context):
    w=context.world
    assert w.browser_fixture.errors==[],w.browser_fixture.errors


@then('the published entry becomes "{text}" without a refresh control')
def automatically_updated_content(context,text):
    p=page(context)
    expect(p.get_by_test_id('entry-content')).to_contain_text(text,timeout=22000)
    expect(p.get_by_role('button',name=re.compile(r'^Refresh'))).to_have_count(0)
    expect(p.get_by_role('alertdialog')).to_have_count(0)


@when('I type "{text}" in a new draft')
def pending_background_edit(context, text):
    ensure_editor(context)
    page(context).get_by_role('textbox', name='Content', exact=True).fill(text)


def leave_draft_for_content(context, choice):
    p = page(context)
    p.get_by_role('navigation', name='Bundle navigation').get_by_role('link', name='Content', exact=True).click()
    p.get_by_role('alertdialog', name='Leave current edits?').get_by_role('button', name=choice, exact=True).click()


@when('I return to Content but choose to keep editing')
def keep_unsaved_edit(context):
    leave_draft_for_content(context, 'Keep editing')


@then('the draft editor still contains "{text}"')
def still_editing(context, text):
    expect_editor_value(page(context).get_by_role('textbox', name='Content', exact=True), text)


@when('I discard the unsaved edit and return to Content')
def discard_unsaved_edit(context):
    leave_draft_for_content(context, 'Leave editor')


@then('the published entry shows "{text}" and no draft was saved')
def discarded_to_current(context, text):
    w = context.world
    expect(page(context).get_by_test_id('entry-content')).to_contain_text(text)
    assert w.call('GET', w.channel + '/drafts')['items'] == []
