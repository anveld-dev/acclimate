"""Focused checks for the workspace presentation, using the real test fixture."""
from playwright.sync_api import expect
from pathlib import Path
import re
from scripts.testing.compact_console import visit
from scripts.bdd.layout import capture_layout


def verify(w,b,p,routes,out,checks):
    p.set_viewport_size(dict(width=1440,height=1000))
    visit(p,b,routes['bundles'])
    search=p.get_by_label('Find a bundle',exact=True)
    search.fill('PAYMENT')
    expect(p.locator('.bundle-library-row')).to_have_count(1)
    expect(p.get_by_role('link',name='Payment operations',exact=True)).to_be_visible()
    row=p.locator('.bundle-library-row')
    reference=row.get_by_role('button',name='SDK reference for Payment operations',exact=True)
    reference.click()
    bundle_id=row.locator('.bundle-reference-details dd code').nth(1).inner_text()
    row.get_by_role('button',name='Copy bundle ID',exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()')==bundle_id
    channel_link=row.get_by_role('link',name='stable',exact=True).get_attribute('href')
    expect(row.get_by_role('link',name='App setup for stable',exact=True)).to_have_attribute('href',channel_link.removesuffix('/content')+'/connect')
    reference.click()
    search.fill(bundle_id.upper())
    expect(row).to_have_count(1)
    expect(row.get_by_role('heading',name='Payment operations')).to_be_visible()
    search.fill('no such content')
    expect(p.get_by_text('No bundles match “no such content”.',exact=True)).to_be_visible()
    search.fill('')
    expect(p.locator('.bundle-library-row')).to_have_count(5)
    expect(p.locator('.bundle-library-row').first.locator('h3 a')).to_have_attribute('href',re.compile('/channels/stable/content$'))
    link=p.locator('.bundle-library-row').filter(has=p.get_by_role('link',name='Payment operations',exact=True)).get_by_role('link',name='stable',exact=True)
    destination=link.get_attribute('href');link.click()
    expect(p).to_have_url(b.base+destination)
    expect(p.get_by_role('heading',name='Payment operations',exact=True)).to_be_visible()
    checks.append('Bundle search, query-specific empty state and actual channel destination')
    visit(p,b,routes['members'])
    duplicates=p.locator('.workspace-member-row').filter(has=p.get_by_text('Alex Rivera',exact=True))
    expect(duplicates).to_have_count(2)
    labels=[]
    for i in range(2):
        row=duplicates.nth(i)
        full_id=row.locator('.member-id').inner_text().removeprefix('User ID: ')
        assert full_id in row.locator('.member-role-trigger').get_attribute('aria-label')
        labels.append(row.locator('.member-actions-trigger').get_attribute('aria-label'))
        row.get_by_role('button',name='Identity details',exact=True).click()
        expect(row.locator('.member-details')).to_contain_text('Issuer:')
        expect(row.locator('.member-details')).to_contain_text('Subject:')
        row.get_by_role('button',name='Identity details',exact=True).click()
    assert labels[0]!=labels[1]
    row=duplicates.first
    user_id=row.locator('.member-id').inner_text().removeprefix('User ID: ')
    row.locator('.member-actions-trigger').click()
    p.get_by_role('menuitem',name='Copy user ID',exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()')==user_id
    expect(row.locator('.member-actions-trigger')).to_have_attribute('aria-expanded','false')
    row.locator('.member-actions-trigger').focus();p.keyboard.press('ArrowDown')
    p.get_by_role('menuitem',name='Remove access',exact=True).click()
    dialog=p.get_by_role('alertdialog',name='Remove workspace access?',exact=True)
    expect(dialog).to_contain_text(user_id)
    expect(dialog).to_contain_text('Issuer:')
    expect(dialog).to_contain_text('Subject:')
    capture_layout(p,out,'member-remove-identity')
    dialog.get_by_role('button',name='Keep member',exact=True).click()
    expect(row.locator('.member-actions-trigger')).to_be_focused()
    row.locator('.member-role-trigger').click()
    capture_layout(p,out,'member-role-menu')
    p.keyboard.press('Escape');expect(row.locator('.member-role-trigger')).to_be_focused()
    checks.append('Duplicate names expose full identities, distinct action names, exact copy and immutable removal confirmation')
    p.get_by_role('button',name='Invite member',exact=True).click()
    p.get_by_label('Email',exact=True).fill('jordan@')
    assert not p.get_by_label('Email',exact=True).evaluate('e=>e.checkValidity()')
    p.get_by_label('Workspace role',exact=True).select_option('editor')
    capture_layout(p,out,'invite-validation')
    p.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
    expect(p.get_by_role('button',name='Invite member',exact=True)).to_be_focused()
    checks.append('Invite email validity, role guidance, cancel and focus return')
    visit(p,b,routes['connection-detail'])
    expect(p.get_by_label('Issued read credentials',exact=True).get_by_text('Read credential · Active',exact=True)).to_be_visible()
    reporting=p.get_by_role('button',name='Optional delivery reports & credentials',exact=True)
    expect(reporting).to_have_attribute('aria-expanded','false')
    reporting.focus();p.keyboard.press('Enter')
    expect(p.get_by_label('Issued reporting credentials',exact=True)).to_be_visible()
    capture_layout(p,out,'connection-reporting-open')
    reporting.click()
    report=p.get_by_test_id('delivery-report').first
    trigger=report.get_by_role('button')
    expect(trigger).to_have_attribute('aria-expanded','false')
    assert 'source cache' in trigger.get_attribute('aria-label')
    assert w.original['version']['id'] in trigger.get_attribute('aria-label')
    trigger.focus();p.keyboard.press('Enter')
    expect(report.locator('.connection-report-details')).to_contain_text(w.original['version']['digest'])
    expect(report.locator('.connection-report-details')).to_contain_text('Event ID')
    capture_layout(p,out,'report-details-open')
    p.keyboard.press('Enter')
    expect(trigger).to_have_attribute('aria-expanded','false');expect(trigger).to_be_focused()
    checks.append('Read/report credential grouping and keyboard report disclosure retain full provenance')
    for _ in range(22):
        w.call('POST',w.integration_path+'/receipts',w.delivery_event(),actor='receipt-writer')
    p.reload(wait_until='networkidle')
    expect(p.get_by_test_id('delivery-report')).to_have_count(20)
    p.get_by_role('button',name='Load older reports',exact=True).click()
    expect(p.get_by_test_id('delivery-report')).to_have_count(25)
    times=p.locator('.connection-report-received time').evaluate_all('els=>els.map(e=>e.dateTime)')
    assert times==sorted(times,reverse=True)
    checks.append('25 independent reports page in received-time order')
    empty=b.workspace_path('connections')+'?integration='+w.empty_connection['id']
    visit(p,b,empty)
    expect(p.get_by_text('No delivery report received; status unknown.',exact=False)).to_be_visible()
    checks.append('No reports retains explicit unknown status and setup link')
    # A genuinely narrow content container inside a wide viewport exercises container rules.
    for name in ['bundles','members','connection-detail']:
        visit(p,b,routes[name])
        root=p.locator('.bundle-library' if name=='bundles' else '.workspace-members' if name=='members' else '.workspace-connections')
        root.evaluate('e=>e.style.width="430px"')
        assert root.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),name
        if name=='members':
            expect(p.get_by_role('table')).to_have_count(2)
            expect(p.get_by_label('Pending invitations',exact=True)).to_contain_text('Delivery')
        capture_layout(p,out,name+'-constrained-430')
    checks.append('Actual 430px containers reflow in a 1440px viewport, preserving table semantics and labels')
    coarse=b.browser.new_context(ignore_https_errors=True,has_touch=True,viewport=dict(width=1024,height=1000),storage_state=b.context.storage_state())
    try:
        touch=coarse.new_page()
        for name,path in routes.items():
            visit(touch,b,path)
            assert touch.evaluate('matchMedia("(pointer:coarse)").matches')
            controls=touch.locator('.workspace-members button,.workspace-connections button,.bundle-library button,.bundle-directory-channels a')
            assert controls.evaluate_all('els=>els.filter(e=>e.getBoundingClientRect().height).every(e=>e.getBoundingClientRect().height>=43.5)'),name
            capture_layout(touch,out,name+'-coarse-1024')
    finally:coarse.close()
    checks.append('Real coarse-pointer workspace controls retain 44px targets')

    # Invitation-only transport failure must not block successful member/access reads.
    root=Path(__file__).resolve().parents[2]
    modules=list((root/'apps/console/.output/server/_ssr').glob('invitation-actions-*.mjs'))
    identifiers=[]
    for module in modules:
        identifiers += re.findall(r'id:\s*"([a-f0-9]+)",\s*name:\s*"runInvitationCommand"',module.read_text())
    assert len(set(identifiers))==1
    pattern='**/_serverFn/'+identifiers[0]+'*'
    visit(p,b,routes['members'])
    w.call('PUT',w.root+'/memberships/'+w.sessions['member']['userId'],dict(role='admin'),actor='admin')
    p.route(pattern,lambda route:route.abort('failed'))
    try:
        w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject='opaque-other',displayName='Changed during invitation outage'),actor='login-authority')
        expect(p.get_by_text('Changed during invitation outage',exact=True)).to_be_visible(timeout=12000)
        expect(p.get_by_role('alert')).to_contain_text('Could not refresh invitations.')
        expect(p.get_by_label('Pending invitations',exact=True)).to_contain_text('jordan@example.test')
        capture_layout(p,out,'invitation-outage-members-updated')
        w.call('PUT',w.root+'/memberships/'+w.sessions['admin']['userId'],dict(role='viewer'),actor='member')
        expect(p.get_by_role('button',name='Invite member',exact=True)).to_have_count(0,timeout=12000)
        expect(p.locator('.member-role-trigger')).to_have_count(0)
        capture_layout(p,out,'invitation-outage-access-downgraded')
    finally:p.unroute(pattern)
    checks.append('Invitation-only outage retains last list with error while member updates and admin downgrade apply independently')
