"""Real browser recovery with faults restricted to this scenario's processes."""
import json
import re
from urllib.parse import quote
from behave import when, then
from playwright.sync_api import expect
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


@when('the browser loses a successful restore response')
def lose_operation(context):
    w = context.world
    w.upload_version('Release before rollback.')
    w.manual_release()
    b = w.browser()
    b.visit('/releases')
    p = b.page
    p.get_by_role('article', name='Revision 1', exact=True).get_by_role('button').click()
    p.get_by_role('region', name='Selected release', exact=True).get_by_role('button', name='Restore revision 1', exact=True).click()
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
    retry = 'Retry exact restore'
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
    settlement = 'Check result'
    reveal(p.get_by_role('button', name=settlement, exact=True, include_hidden=True))
    p.get_by_role('button', name=settlement, exact=True).click()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_have_count(0)
    assert records(p) == []
    current = w.call('GET', w.channel)
    assert current['revision'] == '3' and current['version'] == w.original['version']
