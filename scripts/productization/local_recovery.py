#!/usr/bin/env python3
"""Prove backend ownership recovery with real Rust, console and private PostgreSQL."""
import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.productization.qualify import Harness, payload, port


def wait_event(process, expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError('Local recovery fixture exited unexpectedly')
        if select.select([process.stdout], [], [], .1)[0]:
            row = json.loads(process.stdout.readline())
            if row['event'] == expected:
                return row
    raise AssertionError('Timed out waiting for ' + expected)


def wait_health(base):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if urlopen(base + '/health', timeout=1).read() == b'ok':
                return
        except OSError:
            pass
        time.sleep(.05)
    raise AssertionError('Backend did not recover')


def qualify(h, setup=None, world=None):
    process, suspended = None, None
    assert world is not None, "Recovery requires the shared production browser fixture world"
    try:
        setup = setup or h.call('POST', '/v1/projects/' + h.project + '/bundle-setups', dict(name='Recovery fixture', origin='created', channel='stable', payload=payload('Survives backend reconnect.'), reason='Explicit recovery fixture.'))
        bundle = setup['bundle']['id']
        channel_path = '/v1/projects/' + h.project + '/bundles/' + bundle + '/channels/stable'
        original = h.call('GET', channel_path)
        # Establish the issuer before the supervisor snapshots the service env.
        world.hosted()
        h.stop_service()
        content_path = '/w/' + h.project + '/bundles/' + bundle + '/channels/stable/content'
        config = h.dir / 'local-recovery.json'
        config.write_text(json.dumps(dict(root=str(ROOT), baseUrl=h.base)))
        config.chmod(0o600)
        with open(h.dir / 'recovery.log', 'w+') as log:
            process = subprocess.Popen(['node', '--import', 'tsx', str(ROOT / 'scripts/productization/local-recovery-fixture.mjs'), str(config)], cwd=ROOT, env=h.env, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, start_new_session=True)
            wait_event(process, 'ready')
            fixture = world.browser()
            web_pid = fixture.process.pid
            fixture.page.goto(fixture.base + content_path, wait_until='networkidle')
            assert 'Survives backend reconnect.' in fixture.page.inner_text('main')
            postgres_pid = int((h.dir / 'pg/postmaster.pid').read_text().splitlines()[0])
            observations = []
            for kind in ['timeout', 'terminated connection']:
                guard = int(h.sql("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND classid=169 AND objid=3333947977 LIMIT 1"))
                owner = int(subprocess.check_output(['ps', '-p', str(guard), '-o', 'ppid='], text=True).strip())
                assert owner == postgres_pid, 'Fault injection must only affect this private PostgreSQL cluster'
                if kind == 'timeout':
                    os.kill(guard, signal.SIGSTOP)
                    suspended = guard
                    time.sleep(2.6)
                    os.kill(guard, signal.SIGCONT)
                    suspended = None
                else:
                    assert h.sql('SELECT pg_terminate_backend(' + str(guard) + ')') == 't'
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    current_guard = h.sql(
                        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted "
                        "AND classid=169 AND objid=3333947977 LIMIT 1"
                    )
                    if current_guard and int(current_guard) != guard:
                        break
                    time.sleep(0.1)
                else:
                    raise AssertionError('The service did not reacquire its advisory lock')
                wait_health(h.base)
                assert process.poll() is None
                os.kill(web_pid, 0)
                current = h.call('GET', channel_path)
                assert current == original, 'Recovery changed the published version'
                response = fixture.page.goto(fixture.base + content_path, wait_until='networkidle')
                assert response.status == 200
                assert 'Survives backend reconnect.' in fixture.page.inner_text('main')
                observations.append(dict(fault=kind, channel=current, consoleStatus=response.status))
                print('Passed:', kind, '→ fresh ownership, same console process, exact stored release')
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=10) == 0, 'Intentional shutdown failed'
            fixture.close()
            assert fixture.process.poll() is not None, 'Console did not stop on intentional shutdown'
            world.browser_fixture = None
            print('Passed: intentional production fixture shutdown')
            return dict(original=original, observations=observations, shutdown=process.returncode, consoleStopped=True)
    finally:
        if suspended:
            try:
                os.kill(suspended, signal.SIGCONT)
            except ProcessLookupError:
                pass
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True)
    parser.add_argument('--skip-build', action='store_true')
    args = parser.parse_args()
    if not args.skip_build:
        subprocess.run(['cargo', 'build', '--locked'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'run', 'build:packages'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'run', 'build:console'], cwd=ROOT, check=True)
    from types import SimpleNamespace
    from scripts.bdd.world import World
    world = World(args.pg_bin)
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('Survives backend reconnect.')
        qualify(world.h, world.setup, world)
    finally:
        world.close()


if __name__ == '__main__':
    main()
