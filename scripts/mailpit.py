#!/usr/bin/env python3
"""Pinned, loopback-only development inbox. No SMTP relay or external delivery."""
import argparse
import hashlib
import io
import json
import os
import platform
import signal
import socket
import subprocess
import tarfile
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local/mailpit'
VERSION = '1.33.1'
DIGESTS = {
    'darwin-arm64': '15703838762355d42befeb1c942f3a5cc53bcf1fa3ba6abc216a05dd254a8ac2',
    'darwin-amd64': 'd8ca2a9da16c977189f2514a7fc28f8a47fe050bd2b0296a13c815288b5fe39f',
    'linux-arm64': '3c5f076cb676d6980e47da030861c6d60f1f5614103dea93cccbcdfc43198e12',
    'linux-amd64': '84d7fe375ebef25df26758984dc0d5d5e17d8c0734cb2e77be7873b14ab51716',
}


def binary():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = platform.system().lower() + '-' + {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine(), platform.machine())
    if target not in DIGESTS:
        raise RuntimeError('Unsupported native platform; use compose.mailpit.yaml')
    executable = STATE / ('mailpit-' + VERSION)
    receipt = executable.with_suffix('.json')
    if executable.exists():
        record = json.loads(receipt.read_text())
        if record['archiveSha256'] != DIGESTS[target] or record['binarySha256'] != hashlib.sha256(executable.read_bytes()).hexdigest():
            raise RuntimeError('Mailpit checksum changed; refusing to run')
        return executable
    url = f'https://github.com/axllent/mailpit/releases/download/v{VERSION}/mailpit-{target}.tar.gz'
    archive = urlopen(url, timeout=60).read(64 * 1024 * 1024)
    if hashlib.sha256(archive).hexdigest() != DIGESTS[target]:
        raise RuntimeError('Mailpit release checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        member = next(item for item in tar if item.name.removeprefix('./') == 'mailpit' and item.isfile())
        payload = tar.extractfile(member).read()
    temporary = executable.with_suffix('.tmp')
    with temporary.open('xb') as output:
        output.write(payload)
    temporary.chmod(0o700)
    temporary.replace(executable)
    receipt.write_text(json.dumps(dict(version=VERSION, url=url, archiveSha256=DIGESTS[target], binarySha256=hashlib.sha256(payload).hexdigest())) + '\n')
    return executable


def owned_pid():
    record = STATE / 'runtime.json'
    if not record.exists():
        return None
    pid = json.loads(record.read_text())['pid']
    command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
    if not command:
        return None
    if not command.startswith(str(STATE / ('mailpit-' + VERSION)) + ' '):
        raise RuntimeError('Recorded PID belongs to another process; leaving it alone')
    return pid


def ready():
    try:
        with urlopen('http://127.0.0.1:8025/livez', timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'status', 'stop'], default='start', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    pid = owned_pid()
    if args.action == 'stop':
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(100):
                if not ready():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Mailpit did not stop')
        (STATE / 'runtime.json').unlink(missing_ok=True)
        print('Mailpit stopped; captured messages preserved.')
        return
    if not pid and args.action == 'start':
        for port in (1025, 8025):
            with socket.socket() as probe:
                try:
                    probe.bind(('127.0.0.1', port))
                except OSError:
                    raise RuntimeError(f'Port {port} is occupied; no existing process was changed') from None
        executable = binary()
        with (STATE / 'mailpit.log').open('a') as log:
            # Ignore inherited MP_* settings: in particular no relay/release path.
            env = {key: value for key, value in os.environ.items() if not key.startswith('MP_')}
            process = subprocess.Popen([str(executable), '--smtp', '127.0.0.1:1025', '--listen', '127.0.0.1:8025',
                '--database', str(STATE / 'messages.db'), '--max', '1000', '--max-message-size', '5',
                '--allowed-hosts', 'localhost,127.0.0.1', '--disable-version-check', '--block-remote-css-and-fonts', '--quiet'],
                env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        (STATE / 'runtime.json').write_text(json.dumps(dict(pid=process.pid, version=VERSION)) + '\n')
        for _ in range(100):
            if ready():
                break
            if process.poll() is not None:
                raise RuntimeError('Mailpit stopped; inspect its private local log')
            time.sleep(.1)
    if not owned_pid() or not ready():
        raise RuntimeError('Mailpit is not ready; run npm run mail:start')
    print('Mailpit ready: http://localhost:8025 — SMTP 127.0.0.1:1025, local capture only.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(str(error))
