import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dx_qualification', DIRECTORY / 'qualify_dx.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class QualificationIntegrityTests(unittest.TestCase):
    def fixture(self, root):
        digest = hashlib.sha256(b'[]').hexdigest()
        data = {
            'SOURCE.json': json.dumps({'files': [], 'sha256': digest}).encode(),
            'release-metadata.json': b'{}',
            'sdk.tgz': b'fixture package',
            'starter.tgz': b'fixture starter',
        }
        artifacts = []
        for name, content in data.items():
            (root / name).write_bytes(content)
            artifacts.append({'name': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        manifest = {'artifacts': artifacts, 'packages': [{'file': 'sdk.tgz'}],
                    'starters': [{'file': 'starter.tgz'}], 'source': {'file': 'SOURCE.json', 'sha256': digest}}
        (root / 'manifest.json').write_text(json.dumps(manifest))
        (root / 'SHA256SUMS').write_text(''.join(f"{item['sha256']}  {item['name']}\n" for item in artifacts))
        return manifest

    def test_verified_inventory_and_checksums_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            qualification.verify_release(root)
            (root / 'SHA256SUMS').write_text('')
            with self.assertRaisesRegex(ValueError, 'checksums'):
                qualification.verify_release(root)

    def test_unhashed_starter_and_mismatched_source_claim_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.fixture(root)
            manifest['starters'].append({'file': 'unhashed-starter.tgz'})
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'declared artifacts'):
                qualification.verify_release(root)
            manifest = self.fixture(root)
            manifest['source']['sha256'] = '0' * 64
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'source fingerprint'):
                qualification.verify_release(root)

    def test_symlink_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            (root / 'sdk.tgz').rename(root / 'other.tgz')
            (root / 'sdk.tgz').symlink_to(root / 'other.tgz')
            with self.assertRaisesRegex(ValueError, 'regular file'):
                qualification.verify_release(root)

    def test_optimization_cannot_disable_qualification_assertions(self):
        for script in ('qualify_dx.py', 'verify-wheel.py'):
            result = subprocess.run([sys.executable, '-O', str(DIRECTORY / script), '--help'],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('requires Python assertions', result.stderr)


if __name__ == '__main__':
    unittest.main()
