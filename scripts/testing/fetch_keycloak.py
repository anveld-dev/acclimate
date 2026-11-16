#!/usr/bin/env python3
"""Fetch the pinned official test distribution with its release-asset SHA256.

No global installation or service startup. The output directory must be new.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile
from urllib.request import Request, urlopen

VERSION = '26.8.2'
ROOT = Path(__file__).resolve().parents[2]
if sys.version_info < (3, 12):
    executable = ROOT/'.venv-bdd/bin/python'
    if executable.exists() and Path(sys.executable).resolve() != executable.resolve():
        os.execv(str(executable), [str(executable), __file__, *sys.argv[1:]])
    sys.exit('Keycloak fetch requires Python 3.12+; use a Python 3.12+ .venv-bdd.')


def fetch(output):
    # Exclusive creation prevents overwriting an installation or previous evidence.
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    api = f'https://api.github.com/repos/keycloak/keycloak/releases/tags/{VERSION}'
    with urlopen(Request(api, headers={'User-Agent': 'Acclimate-qualification'}), timeout=30) as response:
        release = json.load(response)
    name = f'keycloak-{VERSION}.tar.gz'
    asset = next(item for item in release['assets'] if item['name'] == name)
    expected = asset.get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', expected):
        raise RuntimeError('Official release SHA256 unavailable')
    url = asset['browser_download_url']
    if not url.startswith(f'https://github.com/keycloak/keycloak/releases/download/{VERSION}/'):
        raise RuntimeError('Unexpected official release location')
    archive = output/name
    with urlopen(url, timeout=60) as response, archive.open('xb') as target:
        shutil_copy(response, target)
    with archive.open('rb') as source:
        actual = 'sha256:'+hashlib.file_digest(source, 'sha256').hexdigest()
    if actual != expected:
        raise RuntimeError('Official release checksum mismatch')
    with tarfile.open(archive) as source:
        source.extractall(output, filter='data')
    (output/'verified-release.json').write_text(json.dumps(dict(
        version=VERSION, url=url, sha256=actual, bytes=archive.stat().st_size), indent=2)+'\n')
    return output/f'keycloak-{VERSION}'


def shutil_copy(source, target):
    # Bound the download; this pinned distribution is substantially smaller.
    size = 0
    while chunk := source.read(1024*1024):
        size += len(chunk)
        if size > 512*1024*1024:
            raise RuntimeError('Release archive exceeds size bound')
        target.write(chunk)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(fetch(args.output.resolve()))
