"""Regression checks for the no-write guard's TanStack request transport."""
import unittest

from scripts.testing.compact_console import (
    READ_IMPROVEMENT_ACTIONS,
    is_improvement_read,
    server_function_action,
)


ENDPOINT = '/_serverFn/fixture-improvement'
URL = 'https://console.invalid' + ENDPOINT


def seroval(action, nested=None):
    # Shape emitted by installed seroval.toJSONAsync({data: {action, ...}}).
    values = [{'t': 1, 's': action}]
    keys = ['action']
    if nested is not None:
        keys.append('payload')
        values.append(nested)
    return {'t': {'t': 10, 'i': 0, 'p': {'k': ['data'], 'v': [
        {'t': 10, 'i': 1, 'p': {'k': keys, 'v': values}, 'o': 0}
    ]}, 'o': 0}, 'f': 127, 'm': []}


class ImprovementReadClassification(unittest.TestCase):
    def test_known_reads_in_both_supported_transport_shapes(self):
        for action in READ_IMPROVEMENT_ACTIONS:
            for body in ({'data': {'action': action}}, seroval(action)):
                with self.subTest(action=action, encoding=body.keys()):
                    self.assertEqual(server_function_action(body), action)
                    self.assertTrue(is_improvement_read('POST', URL, body, ENDPOINT))

    def test_writes_are_not_excused_by_nested_read_strings(self):
        for action in ('evaluate', 'publish', 'propose', 'submitFrozen', 'interrupt'):
            for body in (
                {'data': {'action': action, 'payload': {'action': 'requests'}}},
                seroval(action, {'t': 1, 's': 'requests'}),
            ):
                with self.subTest(action=action):
                    self.assertFalse(is_improvement_read('POST', URL, body, ENDPOINT))

    def test_same_action_on_other_endpoint_or_write_verb_still_counts(self):
        body = seroval('requests')
        self.assertFalse(is_improvement_read('POST', URL + '-other', body, ENDPOINT))
        self.assertFalse(is_improvement_read('PUT', URL, body, ENDPOINT))
        self.assertFalse(is_improvement_read('DELETE', URL, body, ENDPOINT))

    def test_unknown_or_unrelated_payloads_fail_closed(self):
        for body in (None, '', [], {'action': 'requests'},
                     {'data': {'action': 'future-write'}},
                     {'data': {'payload': {'action': 'requests'}}},
                     {'context': {'action': 'requests'}}):
            with self.subTest(body=body):
                self.assertFalse(is_improvement_read('POST', URL, body, ENDPOINT))

    def test_ambiguous_or_unrecognized_seroval_nodes_fail_closed(self):
        duplicate = seroval('requests')
        properties = duplicate['t']['p']['v'][0]['p']
        properties['k'].append('action')
        properties['v'].append({'t': 1, 's': 'publish'})
        malformed = seroval('requests')
        malformed['t']['p']['v'].append({'t': 1, 's': 'extra'})
        reference = seroval('requests')
        reference['t']['p']['v'][0]['p']['v'][0] = {'t': 4, 'i': 99}
        mixed = dict(seroval('publish'), data={'action': 'requests'})
        for body in (duplicate, malformed, reference, mixed):
            with self.subTest(body=body):
                self.assertIsNone(server_function_action(body))
                self.assertFalse(is_improvement_read('POST', URL, body, ENDPOINT))


if __name__ == '__main__':
    unittest.main()
