#!/usr/bin/env python3
"""Round 13 connection checks using disposable PostgreSQL and OIDC fixtures."""
import argparse
import json
import sys
import re
from datetime import datetime,timedelta,timezone
from urllib.parse import parse_qs,urlsplit,urlencode
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.testing.workspace_layouts import seed


def run(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    w = World(pg_bin(args.pg_bin))
    before = build_fingerprint()
    checks = []
    try:
        seed(w)
        w.sensitive_fixture = True
        duplicate_name='Duplicate background worker '+('long identity '*4)
        duplicates=[w.call('POST',w.root+'/connections',dict(displayName=duplicate_name,bundleId=w.setup['bundle']['id'],channel='stable')) for _ in range(2)]
        newer=w.call('POST',w.root+'/bundles/'+w.setup['bundle']['id']+'/versions',dict(parentVersionId=w.original['version']['id'],payload=dict(schemaVersion=1,files=[dict(path='AGENTS.md',kind='instruction',text='New current published fixture.')])) )
        w.call('POST',w.channel+'/releases',dict(versionId=newer['id'],expectedRevision=w.original['revision'],unevaluatedReason='Advance fixture for historical report distinction.'))
        delayed=w.delivery_event();now=datetime.now(timezone.utc)
        delayed.update(source='offline',stage='started',channel='stable',revision=w.original['revision'],stale=True,occurredAt=(now-timedelta(minutes=10)).isoformat(),resolvedAt=(now-timedelta(minutes=20)).isoformat())
        w.call('POST',w.integration_path+'/receipts',delayed,actor='receipt-writer')
        b = w.browser()
        p = b.page
        directory = b.workspace_path('connections')
        selected = directory + '?connection=' + w.integration['id']
        for width in (1440, 1024, 390, 320):
            p.set_viewport_size(dict(width=width, height=900))
            visit(p, b, selected)
            expect(p.get_by_role('heading', name=w.integration['displayName'], exact=True)).to_be_visible()
            expect(p.get_by_role('link', name='Back to connections', exact=True)).to_be_visible()
            assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
            report = p.get_by_test_id('delivery-report').first
            expect(report).to_be_visible()
            geometry=p.locator('.connection-detail').evaluate('e=>({width:e.clientWidth,columns:getComputedStyle(e.querySelector(".connection-status-strip")).gridTemplateColumns.split(" ").length})')
            assert geometry['columns']==(4 if geometry['width']>690 else 2),geometry
            if width == 1440: assert report.bounding_box()['y'] < 900, width
            p.get_by_role('tab',name='Setup',exact=True).click()
            expect(p.get_by_text('3 of 4 done',exact=True)).to_be_visible()
            p.get_by_role('button',name='3. First delivery',exact=False).click()
            expect(p.get_by_role('button',name='Refresh delivery reports',exact=True)).to_be_visible()
            assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
            expect(p.get_by_role('region',name='App-reported delivery',exact=True)).to_have_count(0)
            p.get_by_role('tab',name='Delivery reports',exact=True).click()
            if width in (1440,320):
                # Duplicate display names stay distinguishable by ID in the directory.
                visit(p, b, directory)
                for item in duplicates:
                    entry=p.locator('[id="connection-entry-'+item['id']+'"]')
                    expect(entry).to_be_visible()
                    expect(entry).to_contain_text(item['id'][:8])
                    assert entry.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
                p.screenshot(path=str(out/f'directory-duplicate-{width}.png'),full_page=True,mask=[p.locator('[data-sensitive=true]')])
                visit(p, b, selected)
            p.screenshot(path=str(out / f'selected-{width}.png'), full_page=True,
                         mask=[p.locator('[data-sensitive=true]')])
            checks.append(f'Selected connection fits {width}px with readable report access')
        p.set_viewport_size(dict(width=1440, height=900))
        root = p.locator('.workspace-connections')
        root.evaluate('e => e.style.width = "430px"')
        assert root.evaluate('e => e.scrollWidth <= e.clientWidth + 1')
        assert p.locator('.connection-status-strip').evaluate('e=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==2
        p.screenshot(path=str(out/'selected-embedded-430.png'),full_page=True,mask=[p.locator('[data-sensitive=true]')])
        root.evaluate('e=>e.style.width=""')
        checks.append('Selected connection fits a 430px container')
        visit(p, b, selected)
        p.get_by_role('link', name='Back to connections', exact=True).click()
        expect(p).to_have_url(b.base + directory)
        p.go_back(wait_until='networkidle')
        expect(p.get_by_role('heading', name=w.integration['displayName'], exact=True)).to_be_visible()
        p.go_forward(wait_until='networkidle')
        expect(p).to_have_url(b.base + directory)
        checks.append('Back to directory and browser history restore views')
        scoped=selected+'&bundleId='+w.setup['bundle']['id']+'&channel=stable'
        visit(p,b,scoped)
        p.get_by_role('link',name='Back to connections',exact=True).click()
        query=parse_qs(urlsplit(p.url).query);assert 'connection' not in query and query['bundleId']==[w.setup['bundle']['id']]
        p.locator('[id="connection-entry-'+w.empty_connection['id']+'"]').click()
        expect(p.get_by_role('heading', name=w.empty_connection['displayName'], exact=True)).to_be_visible()
        query=parse_qs(urlsplit(p.url).query);assert query['connection']==[w.empty_connection['id']] and query['bundleId']==[w.setup['bundle']['id']] and query['channel']==['stable']
        p.get_by_role('link',name='Back to connections',exact=True).click()
        query=parse_qs(urlsplit(p.url).query);assert 'connection' not in query and query['bundleId']==[w.setup['bundle']['id']]
        other=next(item for item in w.call('GET',w.root+'/bundles')['items'] if item['id']!=w.setup['bundle']['id'])
        outside=selected+'&bundleId='+other['id']+'&channel=stable'
        visit(p,b,outside);expect(p.get_by_role('heading', name=w.integration['displayName'], exact=True)).to_be_visible()
        expect(p.get_by_text('The selected connection is outside the current directory filters.',exact=True)).to_be_visible()
        p.get_by_role('tab',name='Setup',exact=True).click()
        p.get_by_role('button',name='1. Bundle & channel',exact=False).click()
        expect(p.get_by_role('link',name='Full setup guide',exact=True)).to_have_attribute('href',b.bundle_path('connect'))
        p.get_by_role('link',name='Clear filters',exact=True).click()
        query=parse_qs(urlsplit(p.url).query);assert query.get('connection')==[w.integration['id']] and 'bundleId' not in query and 'channel' not in query
        checks.append('Directory selection and Back retain origin filters; outside-filter selection and its setup binding remain explicit; clear filters retains selection')

        visit(p, b, selected)
        p.get_by_role('tab',name='Credentials',exact=True).click()
        expect(p.get_by_label('Issued reporting credentials', exact=True)).to_be_visible()
        p.get_by_role('tab',name='Delivery reports',exact=True).click()
        report = p.get_by_test_id('delivery-report').first
        trigger = report.get_by_role('button')
        trigger.focus()
        p.keyboard.press('Enter')
        expect(report.locator('.connection-report-details')).to_contain_text(w.original['version']['digest'])
        expect(trigger).to_have_accessible_name(re.compile(r'Stale mapping.*Delayed report.*'+re.escape(delayed['eventId'])))
        expect(report).to_contain_text('Stale mapping');expect(report).to_contain_text('Delayed report')
        expect(report.locator('.connection-report-details')).to_contain_text(delayed['eventId'])
        expect(report.locator('.connection-report-details')).to_contain_text('revision 1')
        expect(p.get_by_role('region',name='App-reported delivery',exact=True)).to_contain_text(newer['id'])
        p.screenshot(path=str(out/'report-provenance-both-qualifiers.png'),full_page=True,mask=[p.locator('[data-sensitive=true]')])
        p.keyboard.press('Enter')
        expect(trigger).to_be_focused()
        checks.append('Optional reporting and keyboard report details preserve provenance')
        for _ in range(21):
            w.call('POST', w.integration_path + '/receipts', w.delivery_event(), actor='receipt-writer')
        p.reload(wait_until='networkidle')
        expect(p.get_by_test_id('delivery-report')).to_have_count(3)
        p.get_by_role('button',name='Show all 20 loaded reports').click()
        expect(p.get_by_test_id('delivery-report')).to_have_count(20)
        # Fail only this load attempt; existing loaded reports must remain visible.
        def fail_post(route):
            if route.request.method=='POST':route.abort('failed')
            else:route.continue_()
        p.route('**/*',fail_post)
        try:
            p.get_by_role('button',name='Load older reports',exact=True).click()
            expect(p.get_by_role('alert')).to_be_visible()
            expect(p.get_by_test_id('delivery-report')).to_have_count(20)
        finally:p.unroute('**/*',fail_post)
        expect(p.get_by_role('button', name='Load older reports', exact=True)).to_be_enabled()
        p.get_by_role('button', name='Load older reports', exact=True).click()
        expect(p.get_by_test_id('delivery-report')).to_have_count(25,timeout=15000)
        times=p.locator('.connection-report-received time').evaluate_all('els=>els.map(e=>e.dateTime)');assert times==sorted(times,reverse=True)
        expect(p.get_by_role('region',name='App-reported delivery',exact=True)).to_contain_text('25 reports loaded')
        expect(p.get_by_role('button',name='Load older reports',exact=True)).to_have_count(0)
        checks.append('Cursor failure retains20 reports; retry loads25 in service-received order with an honest loaded count and no exhausted cursor')
        # A late page response must not overwrite the newly selected connection.
        p.reload(wait_until='networkidle');expect(p.get_by_test_id('delivery-report')).to_have_count(3)
        held=[]
        def hold_page(route):
            # This phase performs one known read command; navigation reads are GET.
            if route.request.method=='POST':held.append(route)
            else:route.continue_()
        p.route('**/*',hold_page)
        try:
            with p.expect_request(lambda r:r.method=='POST'):
                p.get_by_role('button',name='Load older reports',exact=True).click()
            expect(p.get_by_role('button',name='Load older reports',exact=True)).to_be_disabled()
            assert held,'Paging request was not intercepted'
            p.get_by_role('link',name='Back to connections',exact=True).click()
            p.locator('[id="connection-entry-'+w.empty_connection['id']+'"]').click()
            expect(p.get_by_role('heading',name=w.empty_connection['displayName'],exact=True)).to_be_visible()
            assert held,'Paging request was not intercepted'
            for route in held:route.fulfill(response=route.fetch())
            expect(p.get_by_role('tab',name='Setup',exact=True)).to_have_attribute('aria-selected','true')
            p.get_by_role('tab',name='Delivery reports',exact=True).click()
            expect(p.get_by_text('No delivery report received; status unknown.',exact=False)).to_be_visible()
            expect(p.get_by_test_id('delivery-report')).to_have_count(0)
        finally:
            p.unroute('**/*',hold_page)
            for route in held:
                try:route.abort('failed')
                except Exception:pass
        checks.append('Switching connection during a held report response keeps the new connection empty')
        visit(p, b, directory + '?connection=' + w.empty_connection['id'])
        expect(p.get_by_role('tab',name='Setup',exact=True)).to_have_attribute('aria-selected','true')
        p.get_by_role('tab',name='Delivery reports',exact=True).click()
        expect(p.get_by_text('No delivery report received; status unknown.', exact=False)).to_be_visible()
        checks.append('Empty reports show unknown status')
        # New connection lives in the directory header; the detail view leads with the selected app.
        visit(p, b, directory)
        new_trigger=p.get_by_role('button',name='New connection',exact=True)
        new_trigger.click();dialog=p.get_by_role('dialog',name='New connection',exact=True)
        dialog.get_by_label('Display name',exact=True).fill('Unsaved connection fixture')
        expect(dialog.get_by_label('Bundle',exact=True)).to_be_visible()
        for _ in range(8):p.keyboard.press('Tab');assert dialog.evaluate('e=>e.contains(document.activeElement)')
        p.keyboard.press('Escape');expect(dialog).to_be_hidden();expect(new_trigger).to_be_focused()
        visit(p, b, directory + '?connection=' + w.empty_connection['id'])
        create_read=p.get_by_role('button',name='Create read credential',exact=True)
        create_read.click();secret_dialog=p.get_by_role('dialog',name='Save this credential now',exact=True)
        secret=secret_dialog.get_by_label('One-time credential secret',exact=True)
        expect(secret).to_be_visible();assert secret.evaluate('e=>e.value.length>10')
        secret_dialog.get_by_role('button',name='Copy secret',exact=True).click()
        assert p.evaluate('async()=>{const e=document.querySelector("[data-sensitive=true]");return !!e && await navigator.clipboard.readText()===e.value}')
        p.screenshot(path=str(out/'one-time-credential-masked.png'),full_page=True,mask=[p.locator('[data-sensitive=true]')])
        p.keyboard.press('Escape');expect(secret_dialog).to_be_hidden();expect(secret).to_have_count(0);expect(create_read).to_be_focused()
        issued=w.call('GET',w.root+'/connections')['items'];entry=next(item for item in issued if item['id']==w.empty_connection['id']);public_id=entry['credentials'][0]['id']
        revoke=p.get_by_role('button',name='Revoke read credential '+public_id,exact=True)
        revoke.click();confirmation=p.get_by_role('dialog');expect(confirmation).to_contain_text(public_id)
        expect(confirmation).to_contain_text(w.setup['bundle']['id'])
        expect(confirmation.get_by_role('button',name='Cancel',exact=True)).to_be_focused()
        p.screenshot(path=str(out/'revoke-target-confirmation.png'),full_page=True,mask=[p.locator('[data-sensitive=true]')])
        p.keyboard.press('Escape');expect(confirmation).to_be_hidden();expect(revoke).to_be_focused()
        w.call('POST',w.root+'/connections/'+w.empty_connection['id']+'/credentials/'+public_id+'/revoke',{})
        p.get_by_role('tab',name='Credentials',exact=True).click()
        p.reload(wait_until='networkidle')
        p.get_by_role('button',name='Advanced credential actions',exact=True).click()
        advanced=p.get_by_label('Revoke by credential ID',exact=True);advanced.fill(public_id)
        expect(p.get_by_role('button',name='Revoke credential',exact=True)).to_be_disabled()
        expect(p.get_by_text('This credential is already revoked.',exact=True)).to_be_visible()
        advanced.fill('unknown-credential-id')
        expect(p.get_by_role('button',name='Revoke credential',exact=True)).to_be_enabled()
        checks.append('Create and revoke dialogs contain focus and cancel to their trigger; one-time reveal/copy is checked only as booleans with masked capture and no sensitive trace')
        reader=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1440,height=900))
        try:
            b.sign_in(reader,'opaque-member');rp=reader.new_page();visit(rp,b,directory+'?connection='+w.empty_connection['id'])
            expect(rp.get_by_text('A workspace administrator manages app connections.',exact=False)).to_be_visible()
            expect(rp.get_by_role('button',name='Create read credential',exact=True)).to_have_count(0)
            expect(rp.get_by_role('region',name='App-reported delivery',exact=True)).to_have_count(0)
            rp.screenshot(path=str(out/'readonly-connection.png'),full_page=True,mask=[rp.locator('[data-sensitive=true]')])
        finally:reader.close()
        w.call('POST',w.root+'/connections/'+w.empty_connection['id']+'/revoke',{})
        p.reload(wait_until='networkidle');expect(p.get_by_text('Access revoked',exact=True)).to_be_visible()
        expect(p.get_by_role('button',name='Create read credential',exact=True)).to_be_disabled()
        expect(p.get_by_text('This connection is revoked; new credentials cannot be issued.',exact=True)).to_be_visible()
        checks.append('Viewer is denied credential metadata and reports; revoked connection explains disabled creation without health claims')

        assert not b.errors, b.errors
        assert before == build_fingerprint(), 'Build changed during checks'
        summary = dict(passed=True, checks=checks, paidModelCalls=0, sourceBuildSha256=before,
                       limits=['Only listed checks exercised; native zoom and screen readers were not tested.'])
        (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2))
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True,mask=[w.browser_fixture.page.locator('[data-sensitive=true]')])
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:
        w.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--pg-bin')
    parser.add_argument('--verify', action='store_true', help='Run the checks')
    run(parser.parse_args())
