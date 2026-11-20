#!/usr/bin/env python3
"""Supplemental browser regressions through production OIDC, TLS and private PostgreSQL.

The former fake-API/unconfigured-render probe is retired. Startup configuration
failure is covered by apps/console/tests/console-entrypoints.integration.ts; this command preserves literal
content, private caching, pagination, refresh, denial, redaction and read-only
browsing outcomes against the actual application.
"""
import argparse
import json
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from playwright.sync_api import expect


def business_snapshot(h):
    tables=['bundles','versions','channels','comparisons','proposals','promotions',
            'drafts','draft_snapshots','evaluation_requests','integrations',
            'integration_credentials','integration_receipts','idempotency','operation_records']
    return {table:h.sql(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM {table} t") for table in tables}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    args=parser.parse_args()
    w=World(pg_bin(args.pg_bin))
    try:
        w.start()
        w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        literal='<script data-untrusted>window.compromised=true</script>\nReview every retry.'
        w.publish_initial('',files=[
            dict(path='instructions/review.md',kind='instruction',text=literal),
            dict(path='skills/retry-review/SKILL.md',kind='skill',text='---\nname: retry-review\ndescription: Review retries.\n---\nCheck for duplicate side effects.'),
            dict(path='memory/project.md',kind='memory',text='Approved memory: use idempotency keys.')])
        # Model release history already present when upgrading this private database.
        from uuid import UUID
        bundle = UUID(w.setup['bundle']['id'])
        w.h.sql(f"""BEGIN;
            INSERT INTO promotions (id,project_id,bundle_id,channel,revision,version_id,previous_version_id,reviewer,unevaluated_reason)
            SELECT gen_random_uuid(),p.project_id,p.bundle_id,p.channel,n.revision,p.version_id,p.version_id,p.reviewer,'Historical release'
            FROM promotions p CROSS JOIN generate_series(2,22) n(revision)
            WHERE p.bundle_id='{bundle}' AND p.revision=1;
            UPDATE channels SET revision=22 WHERE bundle_id='{bundle}' AND name='stable'; COMMIT;""")
        b=w.browser()
        page=b.page
        secrets=[*w.h.tokens.values(),w.h.login_token,w.h.console_token,b.identity.client_secret]
        original=business_snapshot(w.h)
        page.goto(b.base+'/',wait_until='networkidle')
        expect(page).to_have_url(b.base+b.workspace_path())
        layouts=0
        for width in (1440,1024,768,390,320):
            page.set_viewport_size(dict(width=width,height=1000))
            for route in (b.workspace_path(),b.bundle_path('content'),b.bundle_path('releases')):
                response=page.goto(b.base+route,wait_until='networkidle')
                assert response.status==200
                assert 'no-store' in response.headers.get('cache-control','')
                assert not any(secret in page.content() for secret in secrets)
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth+1'),(width,route)
                layouts+=1
        page.set_viewport_size(dict(width=1440,height=1000))
        b.visit(b.bundle_path('content'))
        expect(page.get_by_test_id('entry-content')).to_contain_text(literal)
        assert page.locator('script[data-untrusted]').count()==0
        assert not page.evaluate('Boolean(window.compromised)')
        field=page.get_by_label('Published content',exact=True)
        field.fill('retry-review');field.press('Enter')
        page.get_by_role('treeitem',name='Open skills/retry-review/SKILL.md',exact=True).click()
        expect(page.get_by_test_id('entry-content')).to_contain_text('duplicate side effects')
        field=page.get_by_label('Published content',exact=True)
        field.fill('no-such-file');field.press('Enter')
        expect(page.get_by_text('No matching entries.',exact=False)).to_be_visible()
        b.visit(b.bundle_path('releases'))
        expect(page.get_by_test_id('release-decision')).to_have_count(20)
        page.get_by_role('button',name='Load older releases',exact=True).click()
        expect(page.get_by_test_id('release-decision')).to_have_count(22)
        expect(page.get_by_role('button',name='Load older releases',exact=True)).to_have_count(0)
        assert business_snapshot(w.h)==original,'Read-only browsing changed stored business state'
        page.reload(wait_until='networkidle')
        expect(page.get_by_role('article',name='Revision 22 · Current',exact=True)).to_be_visible()
        assert business_snapshot(w.h)==original,'Refresh wrote business state'
        for path in ['/setup','/access','/content','/improvement','/integrations','/releases','/not-a-page']:
            response=page.goto(b.base+path,wait_until='networkidle')
            assert response.status==404, (path,response.status)
            expect(page.get_by_role('heading',name='Page not found',exact=True)).to_be_visible()
        # Revoke the actual callback-issued browser session through the valid transport.
        cookie=next(row for row in b.context.cookies(b.base) if row['name']=='acclimate_session')
        w.sessions['_qa-browser']=dict(secret=cookie['value'])
        w.call('DELETE','/v1/auth/session',actor='_qa-browser')
        page.goto(b.base+b.bundle_path('releases'),wait_until='networkidle')
        assert page.url.startswith(b.identity.issuer+'/authorize?')
        expect(page.get_by_role('button',name='Sign in to fixture',exact=True)).to_be_visible()
        expect(page.get_by_test_id('release-decision')).to_have_count(0)
        assert not any(secret in page.content() for secret in secrets+[cookie['value']])
        assert business_snapshot(w.h)==original,'Denied read wrote business state'
        for asset in (ROOT/'apps/console/.output/public').rglob('*.js'):
            content=asset.read_text()
            assert 'node:crypto' not in content and not any(secret in content for secret in secrets)
        assert not b.errors,'Browser emitted runtime errors'
        print(json.dumps(dict(layouts=layouts,flows=['production OIDC + TLS','private no-store responses',
            'literal untrusted content','filtering','history cursor pagination','refresh','session denial',
            'secret redaction','404'],businessReadsOnly=True,externalOIDC='not qualified',errors=[]),indent=2))
    finally:
        w.close()


if __name__=='__main__': main()
