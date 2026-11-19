"""Trust this checkout's local stack CA in the system and browser stores, after confirmation.

macOS adds the root to your login keychain. Linux adds it to the system store with
sudo and to any NSS databases (Chrome, Firefox) when certutil is installed. Pass
--remove to undo it.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import sys

from scripts.local.stack import ROOT, existing_file, locked_state, project_suffix, write_file


def fingerprints(certificate):
    der = ssl.PEM_cert_to_DER_cert(certificate.decode())
    return hashlib.sha1(der).hexdigest().upper(), hashlib.sha256(der).hexdigest().upper()


def nickname(root):
    return f'Acclimate local CA {project_suffix(root)}'


def nss_databases(home):
    candidates = [home / '.pki' / 'nssdb']
    for profiles in (home / '.mozilla' / 'firefox', home / 'snap' / 'firefox' / 'common' / '.mozilla' / 'firefox'):
        if profiles.is_dir():
            candidates.extend(sorted(path.parent for path in profiles.glob('*/cert9.db')))
    return [path for path in candidates if (path / 'cert9.db').exists()]


def plan(system, root, certificate_path, sha1, home, which=shutil.which, isdir=os.path.isdir):
    """Return (description, command) pairs for this platform, without running them."""
    name = nickname(root)
    if system == 'Darwin':
        keychain = str(home / 'Library' / 'Keychains' / 'login.keychain-db')
        return dict(
            add=[('Add the CA to your login keychain as a trusted root (macOS asks for your password)',
                  ['security', 'add-trusted-cert', '-r', 'trustRoot', '-k', keychain, str(certificate_path)])],
            remove=[('Remove its trust settings', ['security', 'remove-trusted-cert', str(certificate_path)]),
                    ('Delete it from your login keychain',
                     ['security', 'delete-certificate', '-Z', sha1, keychain])],
        )
    if system != 'Linux':
        raise ValueError('npm run local:trust supports macOS and Linux.')
    add, remove = [], []
    filename = f'acclimate-local-{project_suffix(root)}.crt'
    if which('update-ca-certificates') and isdir('/usr/local/share/ca-certificates'):
        target = '/usr/local/share/ca-certificates/' + filename
        add += [('Copy the CA into the system store (sudo)',
                 ['sudo', 'install', '-m', '0644', str(certificate_path), target]),
                ('Rebuild the system CA bundle (sudo)', ['sudo', 'update-ca-certificates'])]
        remove += [('Remove the CA from the system store (sudo)', ['sudo', 'rm', '-f', target]),
                   ('Rebuild the system CA bundle (sudo)', ['sudo', 'update-ca-certificates', '--fresh'])]
    elif which('trust'):
        add += [('Add the CA as a system trust anchor (sudo)',
                 ['sudo', 'trust', 'anchor', '--store', str(certificate_path)])]
        remove += [('Remove the system trust anchor (sudo)',
                    ['sudo', 'trust', 'anchor', '--remove', str(certificate_path)])]
    else:
        raise ValueError('Could not find update-ca-certificates or trust. '
                         'Import .local/stack/root.crt with your distribution’s tools.')
    if which('certutil'):
        for database in nss_databases(home):
            add.append((f'Trust it in the browser store at {database}',
                        ['certutil', '-d', 'sql:' + str(database), '-A', '-t', 'C,,', '-n', name,
                         '-i', str(certificate_path)]))
            remove.append((f'Remove it from the browser store at {database}',
                           ['certutil', '-d', 'sql:' + str(database), '-D', '-n', name]))
    return dict(add=add, remove=remove)


def confirm(prompt, answer):
    try:
        return input(prompt) == answer
    except EOFError:
        return False


def main(argv=None, system=None, run=subprocess.run, home=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remove', action='store_true', help='remove the CA added earlier')
    arguments = parser.parse_args(argv)
    system = system or platform.system()
    home = home or Path.home()
    try:
        with locked_state(ROOT) as state:
            record_path = state / 'trust.json'
            record = existing_file(record_path, 0o600)
            certificate_path = state / 'root.crt'
            certificate = existing_file(certificate_path, 0o644)
            if arguments.remove:
                if record is None:
                    print('This checkout’s local CA is not recorded as trusted. Nothing to remove.')
                    return 0
                saved = json.loads(record)
                if certificate is None:
                    raise ValueError(f'{certificate_path} is missing. Remove "{saved["name"]}" '
                                     f'(SHA-256 {saved["sha256"]}) with your system’s certificate tools.')
            elif certificate is None:
                raise ValueError('Start the stack first with npm run local:up.')
            sha1, sha256 = fingerprints(certificate)
            steps = plan(system, ROOT, certificate_path, sha1, home)['remove' if arguments.remove else 'add']
            action = 'stop trusting' if arguments.remove else 'trust'
            print(f'This will {action} the local stack CA for this checkout:\n'
                  f'  {certificate_path}\n  SHA-256 {":".join(sha256[i:i + 2] for i in range(0, 64, 2))}\n')
            if not arguments.remove:
                print('Any site that presents a certificate from this CA will be trusted by this account. '
                      'The CA key stays in this checkout’s Docker volume.\n')
            for description, command in steps:
                print(f'- {description}\n    {" ".join(command)}')
            word = 'remove' if arguments.remove else 'trust'
            if not confirm(f'\nType {word} to continue: ', word):
                print('Canceled. Nothing changed.')
                return 1
            for _, command in steps:
                run(command, check=True)
            if arguments.remove:
                record_path.unlink()
                print('Removed. Restart your browser if it still shows the old certificate.')
            else:
                write_file(record_path, (json.dumps(dict(
                    name=nickname(ROOT), sha256=sha256, system=system)) + '\n').encode())
                print('Trusted. Restart your browser, then open the console URL from npm run local:up.')
            return 0
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Local CA trust failed: {error}') from None
    except (OSError, ValueError) as error:
        raise SystemExit(f'Local CA trust failed: {error}') from None


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
