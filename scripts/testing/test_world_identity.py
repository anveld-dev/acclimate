"""Browser setup must not attempt adoption when membership is on a later page."""
import unittest
from types import SimpleNamespace
from scripts.bdd.world import World


class BrowserMembershipPagination(unittest.TestCase):
    def world(self, pages):
        world = World.__new__(World)
        world.h = SimpleNamespace(project='people-current')
        world.sessions = {'admin': {}}
        world.subjects = {'admin': 'operator'}
        world.hosted = lambda: None
        world.sign_in = lambda *_: None
        calls = []
        def call(method, path, body=None, **options):
            calls.append((method, path, options.get('actor')))
            if method == 'GET': return pages.pop(0)
            self.fail('Existing workspace membership must never trigger adoption')
        world.call = call
        return world, calls

    def test_existing_operator_membership_on_later_page_prevents_adoption(self):
        world, calls = self.world([
            dict(items=[dict(id='bdd-earlier')],nextCursor='cursor&+opaque'),
            dict(items=[dict(id='people-current',role='admin')],nextCursor=None)])
        self.assertEqual(world.prepare_browser_identity(),'operator')
        self.assertEqual(calls, [
            ('GET','/v1/projects?limit=100','_browser-operator'),
            ('GET','/v1/projects?limit=100&cursor=cursor%26%2Bopaque','_browser-operator')])

    def test_repeated_cursor_fails_without_attempting_adoption(self):
        world, _ = self.world([
            dict(items=[],nextCursor='repeat'),dict(items=[],nextCursor='repeat')])
        with self.assertRaisesRegex(AssertionError,'repeated a cursor'):
            world.prepare_browser_identity()


if __name__ == '__main__': unittest.main()
