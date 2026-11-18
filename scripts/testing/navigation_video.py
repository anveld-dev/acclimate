#!/usr/bin/env python3
"""Record fixture-only account and workspace navigation with agent-browser."""
import argparse
import json
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.testing.navigation_chrome import seed


def main(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    world = World(pg_bin(args.pg_bin))
    prefix = ['agent-browser', '--session', 'navigation-' + uuid.uuid4().hex[:8], '--ignore-https-errors']
    snapshots = []
    active = False

    def run(*cmd):
        result = subprocess.run([*prefix, *cmd], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError('agent-browser ' + cmd[0] + ': ' + result.stderr[:500])
        if cmd[0] == 'snapshot':
            snapshots.append(result.stdout)
            (out / 'snapshots.txt').write_text('\n\n'.join(snapshots))
        return result.stdout

    def snap():
        return run('snapshot', '-i')

    def action(*cmd):
        snap()
        run(*cmd)
        run('wait', '700')

    def click(name, role='button'):
        action('find', 'role', role, 'click', '--name', name, '--exact')

    before = build_fingerprint()
    try:
        b, extra = seed(world)
        world.sensitive_fixture = True
        world.h.identity().next_token_claims={'name':'Morgan Lee'}
        # Authenticate through the disposable OIDC fixture before recording.
        run('open', b.base + '/auth/login')
        action('find', 'label', 'Fixture subject', 'fill', 'operator')
        click('Sign in to fixture')
        run('wait', '--load', 'networkidle')
        run('set', 'viewport', '1440', '900')
        run('open', b.base + b.workspace_path())
        run('wait', '--load', 'networkidle')
        snap()
        source = out / 'navigation.webm'
        run('record', 'start', str(source))
        active = True
        run('wait', '1000')
        # Keep one page and viewport throughout capture to preserve frame timestamps.
        action('find', 'role', 'button', 'hover', '--name', 'Account', '--exact')
        click('Account')
        run('wait', '1200')
        click('Sign-in details')
        run('wait', '1200')
        action('find', 'role', 'button', 'hover', '--name', 'Copy ID', '--exact')
        click('Copy ID')
        run('wait', '1000')
        click('Sign-in details')
        action('press', 'Escape')
        action('find', 'role', 'button', 'click', '--name', 'Workspaces')
        run('wait', '1800')
        action('press', 'End')
        action('press', 'Enter')
        run('wait', '--text', 'Create a workspace')
        action('find', 'label', 'Workspace name', 'fill', 'Design team')
        run('wait', '1200')
        # Escape dismisses the unsent form and restores focus; no creation request.
        action('press', 'Escape')
        action('find', 'role', 'button', 'click', '--name', 'Workspaces')
        run('wait', '1200')
        action('press', 'Escape')
        run('record', 'stop')
        active = False

        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(source)]))
        duration = float(probe['format']['duration'])
        assert duration > 2
        stretch = max(1, min(6, 40 / duration))
        video = out / 'navigation.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-vf', f'setpts={stretch}*PTS', '-an', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(video)], check=True)
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', str(video)]))
        assert before == build_fingerprint(), 'Build changed during recording'
        (out / 'summary.json').write_text(json.dumps(dict(
            tool='agent-browser', passed=True, fixtureOnly=True, modelCalls=0,
            sourceBuildSha256=before, rawDuration=duration, playbackStretch=stretch, probe=probe,
            states=['account tooltip', 'compact account', 'sign-in details and full identifiers', 'copy tooltip and confirmation', 'collapsed and closed account', 'workspace choices and roles', 'keyboard End and create dialog', 'unsent name and dismissal', 'workspace menu and close'],
            limits=['Disposable PostgreSQL and OIDC fixture; no live workspace writes or model calls.', 'The creation form is dismissed without submitting. Playback may be slowed for readability; viewport and page remain fixed during capture.', 'Fixture workspace roles reflect the seeded memberships; narrow layouts are qualified separately.'],
        ), indent=2) + '\n')
    finally:
        if active:
            subprocess.run([*prefix, 'record', 'stop'], capture_output=True, timeout=30)
        subprocess.run([*prefix, 'close'], capture_output=True, timeout=30)
        world.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', type=Path, required=True)
    main(parser.parse_args())
