#!/usr/bin/env python3
"""Record round 13 against disposable fixtures and the existing frozen build."""
import argparse
import json
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.testing.desktop_layouts import build_fingerprint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    world = World(pg_bin(args.pg_bin))
    session = 'round13-' + uuid.uuid4().hex[:8]
    prefix = ['agent-browser', '--session', session, '--ignore-https-errors']
    snapshots = []
    recording = False
    def run(*command):
        result = subprocess.run([*prefix, *command], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError(f'agent-browser {command[0]}: {result.stderr[:500]}')
        if command[0] == 'snapshot':
            snapshots.append(result.stdout)
        return result.stdout
    def view(path):
        run('open', browser.base + path)
        run('wait', '--load', 'networkidle')
        run('snapshot', '-i')
        run('wait', '1000')
    def click(name):
        run('snapshot', '-i')
        run('find', 'role', 'button', 'click', '--name', name, '--exact')
        run('wait', '800')
    before = build_fingerprint()
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.enable_email()
        world.sign_in('admin', 'operator')
        world.browser_actor = 'admin'
        world.create_workspace()
        world.publish_initial('Read the relevant skill before changing instructions.')
        for name in ['Support triage', 'Payment operations', 'Code review']:
            world.call('POST', world.root + '/bundle-setups', dict(name=name, channel='stable', origin='created', reason='Disposable video fixture.', payload=dict(schemaVersion=1, files=[dict(path='AGENTS.md', kind='instruction', text='Check the source evidence.')]), compatibilityTarget='generic'))
        world.create_integration()
        # Provision a disposable report writer before recording; never reveal it in UI.
        world.issue('receipt-write')
        for stage in ['verified', 'prepared', 'started']:
            world.call('POST', world.integration_path+'/receipts', dict(world.delivery_event(), stage=stage), actor='receipt-writer')
        draft=world.call('POST',world.channel+'/drafts',dict(baseVersionId=world.original['version']['id'],baseRevision=world.original['revision'],payload=dict(schemaVersion=1,files=[dict(path='AGENTS.md',kind='instruction',text='Check the original receipt before retrying.')])))
        candidate=draft['snapshotVersion']['id']
        world.call('POST', world.root + '/integrations', dict(displayName='Support production', bundleId=world.setup['bundle']['id'], channel='stable'))
        world.sensitive_fixture=True
        browser = world.browser()
        routes = dict(bundles=browser.workspace_path(), members=browser.workspace_path('members'), connections=browser.workspace_path('connections'), changes=browser.bundle_path('changes'))
        routes['detail'] = routes['connections'] + '?integration=' + world.integration['id']
        run('open', browser.base + '/auth/login')
        run('find', 'label', 'Fixture subject', 'fill', 'operator')
        click('Sign in to fixture')
        run('wait', '--load', 'networkidle')
        run('set', 'viewport', '1440', '1000')
        view(routes['bundles'])
        video = out / 'round13.webm'
        run('record', 'start', str(video)); recording = True
        run('wait', '1500')
        view(routes['members']); click('Invite member'); click('Cancel')
        view(routes['connections']); view(routes['detail'])
        run('snapshot','-i');run('find','label','App connection','click');run('wait','1200');run('press','Escape')
        click('Connection identity details'); click('Connection identity details')
        click('Optional delivery reports & credentials')
        run('scroll', 'down', '450'); run('wait', '1200')
        run('scrollintoview','.connection-reports-panel')
        run('snapshot','-i');run('find','first','.connection-report-trigger','click');run('wait','1500')
        view(routes['changes']); run('wait', '1500')
        run('snapshot','-i');run('find','first','[aria-label="Saved drafts"] [data-slot="disclosure-trigger"]','click');run('wait','1000')
        view(routes['changes']+'&candidate='+candidate)
        run('wait','--text','Create evaluation request');run('wait','1500')
        run('screenshot',str(out/'evaluation-setup.png'))
        run('record', 'stop'); recording = False
        mp4 = out / 'round13.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(mp4)], check=True)
        probes = {}
        for path in (video, mp4):
            probes[path.name] = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', str(path)], capture_output=True, text=True, check=True).stdout)
        assert before == build_fingerprint(), 'Frozen build changed during capture'
        (out / 'metadata.json').write_text(json.dumps(dict(tool='agent-browser', fixtureOnly=True, modelCalls=0, secretVisible=False,fixtureCredentialProvisioning=True, buildSha256=before, probes=probes, limitations=['Disposable data; no real workspace changes.', 'Reports and draft are explicit fixture data; no evaluation executed.']), indent=2) + '\n')
        (out / 'snapshots.txt').write_text('\n\n'.join(snapshots))
    finally:
        if recording:
            subprocess.run([*prefix, 'record', 'stop'], capture_output=True, timeout=30)
        subprocess.run([*prefix, 'close'], capture_output=True, timeout=30)
        world.close()

if __name__ == '__main__':
    main()
