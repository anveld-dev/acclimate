import unittest
import json
import tempfile
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from scripts.bdd.coverage import assess, catalog, merge_shards
from scripts.bdd.run import run_behave

class CoverageTests(unittest.TestCase):
    def test_parallel_report_retains_both_groups_and_propagates_worker_errors(self):
        for worker_code in [0, 1]:
            with self.subTest(worker_code=worker_code), tempfile.TemporaryDirectory() as temporary:
                out = Path(temporary)

                def worker(command, **kwargs):
                    console = '--include' in command
                    feature = 'console' if console else 'other'
                    Path(command[-1]).write_text(json.dumps([{'name': feature}]))
                    return subprocess.CompletedProcess(command, worker_code if console else 0, stdout='')

                with patch('scripts.bdd.run.subprocess.run', side_effect=worker):
                    self.assertEqual(run_behave(['behave'], out, True), worker_code)
                self.assertCountEqual(json.loads((out / 'results.json').read_text()),
                                      [{'name': 'console'}, {'name': 'other'}])

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
    def test_merge_shards_removes_filtered_placeholders_and_retains_duplicate_runs(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second = (Path(temporary) / name for name in ('first.json', 'second.json'))
            location = 'features/draft.feature:1'
            background = {'type':'background','steps':[]}
            first.write_text(json.dumps([dict(location=location, elements=[
                background, self.result('new'), self.result('saved', status='skipped')])]))
            second.write_text(json.dumps([dict(location=location, elements=[
                background, self.result('new', status='skipped'), self.result('saved')])]))
            merged = merge_shards([first, second])
            self.assertEqual(len(merged), 1)
            self.assertEqual(merged[0]['elements'].count(background), 1)
            self.assertTrue(assess(self.inventory, merged)['DRAFT-01']['covered'])
            for paths in ([first], [first, second, first]):
                self.assertFalse(assess(self.inventory, merge_shards(paths))['DRAFT-01']['covered'])
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
