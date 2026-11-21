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
from scripts.bdd.run import pg_bin
from scripts.test_console_native_zoom import capture_native
from scripts.bdd.world import World
from scripts.bdd.layout import capture_layout, assert_compact_editor, assert_file_heading_metrics, inspect_layout, tab_to


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
       dict(path='memory/team.md',kind='memory',text='# Team context\n\nEach job keeps the version it resolved.\n')]


def visit(page, fixture, path):
    response=page.goto(fixture.base+path,wait_until='networkidle')
    assert response and response.status==200, path


def select_release(page, revision):
    row = page.locator(f'#revision-{revision}')
    option = row.get_by_role('button')
    if option.get_attribute('aria-pressed') != 'true':
        option.click()
    return row


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
        w.create_integration()
        w.sign_in('_capture-operator','operator')
        w.call('POST','/v1/workspaces',dict(id='compact-secondary-'+w.h.project,name='Second fixture workspace'),actor='_capture-operator')
        b=w.browser();p=b.page
        p.set_viewport_size(dict(width=1440,height=900))
        failures = []
        routes = {
            'content': b.bundle_path('content'), 'releases': b.bundle_path('releases'),
            'setup': b.bundle_path('connect'), 'connections': b.workspace_path('connections'),
            'members': b.workspace_path('members'), 'library': b.workspace_path(),
        }
        for width in (1440, 390, 320):
            p.set_viewport_size(dict(width=width, height=900))
            for name, route in routes.items():
                visit(p, b, route)
                checked_capture(failures, p, output, f'{width}-{name}')
        assert not failures and not b.errors, (failures, b.errors)
    finally:
        w.close()


if __name__=='__main__':main()
