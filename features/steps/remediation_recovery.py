"""Real browser recovery with faults restricted to this scenario's processes."""
import json
import re
from urllib.parse import quote
from behave import when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from features.steps.console import ensure_editor, save_browser, saved_draft
from scripts.bdd.interactions import reveal


TEXT_A = 'Snapshot A: reviewed submitted text.'
TEXT_B = 'Snapshot B: later unsaved browser text.'


def records(page):
    return page.evaluate("Object.entries(sessionStorage).filter(([key])=>key.startsWith('acclimate:operation:v1:'))")


def lose_response(page, click):
    dropped = []
    def drop(route):
        if route.request.method == 'POST' and not dropped:
            response = route.fetch()
            assert response.ok
            dropped.append(True)
            route.abort('failed')
        else:
            route.continue_()
    page.route('**/*', drop)
    try:
        click()
        expect(page.get_by_text(re.compile(r'^(Submission needs confirmation|Restore needs confirmation)$'))).to_be_visible()
        # Wait until the response rejection has reached the UI before editing/retrying.
        expect(page.get_by_role('button', name='Check result', exact=True)).to_be_enabled()
        retry=page.get_by_role('button', name='Retry exact request', exact=True, include_hidden=True).or_(page.get_by_role('button', name='Retry exact restore', exact=True, include_hidden=True))
        reveal(retry)
        expect(retry).to_be_visible()
        expect(retry).to_be_enabled()
    finally:
        page.unroute('**/*', drop)
    assert dropped


@when('the browser loses a successful {command} snapshot response for text A')
def lose_snapshot(context, command):
    w = context.world
    p = w.browser().page
    ensure_editor(context)
    if command == 'save':
        p.get_by_role('textbox', name='Content', exact=True).fill('Initial saved fixture.')
        save_browser(context)
    else:
        assert command == 'create'
        expect(p).to_have_url(__import__('re').compile(r'[?&]draft=new'))
    w.before_retry_url = p.url
    p.get_by_role('textbox', name='Content', exact=True).fill(TEXT_A)
    lose_response(p, lambda: p.get_by_role('button', name='Save draft', exact=True).click())
    w.recovered_draft = saved_draft(w)
    assert w.draft_text(w.recovered_draft) == TEXT_A
    w.recovery_records = records(p)
    assert len(w.recovery_records) == 1


@when('I edit the uncertain snapshot to text B and retry the exact request')
def edit_retry(context):
    p = context.world.browser_fixture.page
    p.get_by_role('textbox', name='Content', exact=True).fill(TEXT_B)
    p.get_by_role('textbox', name='Content', exact=True).evaluate("element => element.dataset.recoveryInstance = 'same-editor'")
    held = []
    def hold(route):
        if route.request.method == 'POST' and not held:
            response = route.fetch()
            held.append(True)
            # A successful save/retry response is held at the browser boundary.
            # Selecting another file here could supersede saved-draft navigation.
            expect(p.get_by_role('treeitem', name='Open AGENTS.md', exact=True)).to_be_disabled()
            expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_disabled()
            route.fulfill(response=response)
        else:
            route.continue_()
    p.route('**/*', hold)
    try:
        p.get_by_role('button', name='Retry exact request', exact=True).click()
        expect(p.get_by_text('Your later browser edits are preserved.', exact=False)).to_be_visible()
    finally:
        p.unroute('**/*', hold)
    assert held


@then('the service retains only text A and the same editor keeps unsaved text B')
def retained_editor(context):
    w = context.world
    p = w.browser_fixture.page
    expect(p).to_have_url(w.before_retry_url)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), TEXT_B)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_have_attribute('data-recovery-instance', 'same-editor')
    expect(p.locator('.draft-status p[data-unsaved="true"]')).to_contain_text(f"Generation {w.recovered_draft['generation']} saved · Unsaved changes")
    assert records(p) == []
    current = saved_draft(w)
    assert current == w.recovered_draft
    assert w.draft_text(current) == TEXT_A
    expect(p.get_by_role('button', name='Save draft', exact=True)).to_be_enabled()


@when('the browser loses a successful {operation} response')
def lose_operation(context, operation):
    w = context.world
    w.recovery_kind = operation
    if operation == 'draft':
        w.browser().select_bundle()
        lose_snapshot(context, 'create')
        return
    assert operation == 'restore'
    w.save_new('Release before rollback.')
    w.manual_release()
    b = w.browser()
    b.visit('/releases')
    p = b.page
    row = p.get_by_role('article').filter(has=p.get_by_role('heading', name='Revision 1', exact=True))
    row.get_by_role('button', name=re.compile(r'^Restore revision ')).click()
    p.get_by_label('Reason for restoring', exact=True).fill('Explicit recovery fixture rollback.')
    lose_response(p, lambda: p.get_by_role('button', name='Restore version', exact=True).click())
    w.recovery_records = records(p)
    assert len(w.recovery_records) == 1
    p.get_by_role('dialog').get_by_role('button', name='Close dialog', exact=True).click()
    assert records(p) == w.recovery_records, 'Closing the dialog must preserve the exact unresolved restore'
    assert w.call('GET', w.channel)['revision'] == '3'


@when('the operator loses mutation rights and retries or looks up that pending operation')
def lose_rights(context):
    w = context.world
    p = w.browser_fixture.page
    # Browser authority follows current membership, independently of SDK grants.
    w.sign_in('_rights-admin', 'recovery-role-admin')
    w.call('PUT',w.root+'/memberships/'+w.sessions['_rights-admin']['userId'],
           dict(role='admin'),actor='_browser-operator')
    w.call('PUT',w.root+'/memberships/'+w.sessions['_browser-operator']['userId'],
           dict(role='viewer'),actor='_rights-admin')
    record = json.loads(w.recovery_records[0][1])
    lookup = w.root + '/operations/' + record['key'] + '?operationPath=' + quote(record['action'], safe='')
    w.call('GET', lookup, actor='_browser-operator', expected=403)
    retry = 'Retry exact request' if w.recovery_kind == 'draft' else 'Retry exact restore'
    reveal(p.get_by_role('button', name=retry, exact=True, include_hidden=True))
    p.get_by_role('button', name=retry, exact=True).click()
    expect(p.get_by_role('button', name=retry, exact=True)).to_be_enabled()
    assert records(p) == w.recovery_records
    p.get_by_role('button', name='Check result', exact=True).click()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_be_enabled()
    assert records(p) == w.recovery_records


@then('the exact recovery record remains until rights return and the commit is reconciled')
def reconcile_rights(context):
    w = context.world
    p = w.browser_fixture.page
    w.call('PUT',w.root+'/memberships/'+w.sessions['_browser-operator']['userId'],
           dict(role='admin'),actor='_rights-admin')
    # Close must return the already committed draft and safely hand off to its
    # saved route, rather than fence it or leave an old editor permanently busy.
    settlement = 'Close unresolved operation' if w.recovery_kind == 'draft' else 'Check result'
    reveal(p.get_by_role('button', name=settlement, exact=True, include_hidden=True))
    p.get_by_role('button', name=settlement, exact=True).click()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_have_count(0)
    assert records(p) == []
    if w.recovery_kind == 'draft':
        expect(p).to_have_url(__import__('re').compile(r'[?&]draft='+w.recovered_draft['id']))
        p.wait_for_load_state('networkidle')
        expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_enabled()
        p.get_by_role('textbox', name='Content', exact=True).fill(TEXT_B)
        expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), TEXT_B)
        expect(p.locator('.draft-status p[data-unsaved="true"]')).to_contain_text(f"Generation {w.recovered_draft['generation']} saved · Unsaved changes")
        assert saved_draft(w) == w.recovered_draft
        assert w.draft_text(w.recovered_draft) == TEXT_A
    else:
        current = w.call('GET', w.channel)
        assert current['revision'] == '3' and current['version'] == w.original['version']
