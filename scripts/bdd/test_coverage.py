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

    inventory={'DRAFT-01':{'cases':2,'name':'Save and reopen',
                           'examples':[{'state':'new'},{'state':'saved'}]}}
    def result(self,state,status='passed',step='passed'):
        return {'tags':['DRAFT-01'],'example':{'state':state},'status':status,
                'steps':[{'result':{'status':step}}]}
    def covered(self,*rows):
        return assess(self.inventory,[{'elements':list(rows)}])['DRAFT-01']['covered']
    def test_all_variants_must_pass(self):
        self.assertTrue(self.covered(self.result('saved'),self.result('new')))
    def test_missing_or_extra_variant_cannot_pass(self):
        self.assertFalse(self.covered())
        self.assertFalse(self.covered(self.result('new')))
        self.assertFalse(self.covered(self.result('new'),self.result('saved'),self.result('new')))
    def test_duplicate_or_unexpected_example_cannot_replace_a_missing_example(self):
        for replacement in ['new','archived']:
            with self.subTest(replacement=replacement):
                self.assertFalse(self.covered(self.result('new'),self.result(replacement)))
    def test_skipped_undefined_or_failed_never_count(self):
        for status in ['skipped','undefined','failed','error']:
            with self.subTest(status=status):
                self.assertFalse(self.covered(self.result('new'),self.result('saved',status)))
                self.assertFalse(self.covered(self.result('new'),self.result('saved',step=status)))

    def test_new_or_untagged_story_cannot_silently_match_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'features').mkdir()
            feature=root/'features/new.feature'
            feature.write_text('Feature: Added behavior\n  @NEW-01\n  Scenario: New action\n    Given something\n')
            self.assertEqual(catalog(root)['NEW-01']['name'], 'New action')
            feature.write_text('Feature: Added behavior\n  Scenario: New action\n    Given something\n')
            with self.assertRaises(ValueError): catalog(root)
