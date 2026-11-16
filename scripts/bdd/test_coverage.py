import hashlib
import json
import unittest
import tempfile
import subprocess
import sys
from pathlib import Path
from scripts.bdd.coverage import assess, catalog

class CoverageTests(unittest.TestCase):
    def test_import_without_site_packages_does_not_reexecute_the_behavior_runner(self):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run([sys.executable, '-S', '-c',
            'import scripts.bdd.run; print("import-only")'], cwd=root,
            text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'import-only')

    inventory={'DRAFT-01':{'cases':2,'name':'Save and reopen'}}
    def result(self,status='passed',step='passed'):
        return {'tags':['DRAFT-01'],'status':status,'steps':[{'result':{'status':step}}]}
    def covered(self,*rows):
        return assess(self.inventory,[{'elements':list(rows)}])['DRAFT-01']['covered']
    def test_all_variants_must_pass(self):
        self.assertTrue(self.covered(self.result(),self.result()))
    def test_missing_or_extra_variant_cannot_pass(self):
        self.assertFalse(self.covered())
        self.assertFalse(self.covered(self.result()))
        self.assertFalse(self.covered(self.result(),self.result(),self.result()))
    def test_skipped_undefined_or_failed_never_count(self):
        for status in ['skipped','undefined','failed','error']:
            with self.subTest(status=status):
                self.assertFalse(self.covered(self.result(),self.result(status)))
                self.assertFalse(self.covered(self.result(),self.result(step=status)))

    def test_new_or_untagged_story_cannot_silently_match_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'features').mkdir()
            feature=root/'features/new.feature'
            feature.write_text('Feature: Added behavior\n  @NEW-01\n  Scenario: New action\n    Given something\n')
            self.assertNotEqual(catalog(root),self.inventory)
            feature.write_text('Feature: Added behavior\n  Scenario: New action\n    Given something\n')
            with self.assertRaises(ValueError): catalog(root)

    def test_original_behavior_inventory_is_preserved(self):
        # Reviewed production additions are explicit; the original story IDs,
        # names, lanes and variant counts cannot disappear in a fixture migration.
        root=Path(__file__).resolve().parents[2]
        current=catalog(root)
        production_additions={f'ACCESS-{number:02}' for number in range(13,19)}
        ux_additions={f'UX-{number:02}' for number in range(1,7)}
        polling_additions={"UI-POLL-01", "UI-POLL-02"}
        additions=production_additions | ux_additions | polling_additions
        baseline={key:value for key,value in current.items() if key not in additions}
        self.assertEqual(len(baseline),141)
        self.assertEqual(sum(row['cases'] for row in baseline.values()),183)
        self.assertEqual(hashlib.sha256(json.dumps(baseline,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
                         '8e293b31b437c88ad0ddbdf349793babc9195c57cbf7962435b48a7d32683aec')
        self.assertEqual(set(current)-set(baseline),additions)
        self.assertEqual(sum(current[key]['cases'] for key in production_additions),7)
        self.assertEqual(sum(current[key]['cases'] for key in ux_additions),6)
        self.assertEqual(sum(current[key]['cases'] for key in polling_additions),2)
