"""Exercise editor assertions against real browser mounting and document bytes."""
import re
import time
import unittest

from playwright.sync_api import Error, sync_playwright

from scripts.bdd.editor import expect_editor_contains, expect_editor_value


class EditorAssertionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.page.set_content('<div data-code-editor><div role="textbox" aria-label="Content"></div></div>')
        self.editor = self.page.get_by_role('textbox', name='Content', exact=True)

    def tearDown(self):
        self.context.close()

    def test_exact_value_waits_for_public_handle_after_mount(self):
        text = 'Recovered café\r\nSecond line\n'
        self.page.evaluate('''text => {
            setTimeout(() => {
                document.querySelector('[data-code-editor]').codeEditor = { getValue: () => text };
            }, 100);
        }''', text)
        expect_editor_value(self.editor, text, timeout=2000)

    def test_contains_waits_for_replacement_editor_handle(self):
        self.page.evaluate('''() => {
            const host = document.querySelector('[data-code-editor]');
            host.codeEditor = { getValue: () => 'Old document' };
            setTimeout(() => {
                const replacement = host.cloneNode(true);
                host.replaceWith(replacement);
                setTimeout(() => {
                    replacement.codeEditor = { getValue: () => 'New complete document' };
                }, 100);
            }, 20);
        }''')
        expect_editor_contains(self.editor, 'complete document', timeout=2000)

    def test_missing_handle_fails_within_the_assertion_timeout(self):
        with self.assertRaisesRegex(AssertionError, 'public document handle'):
            expect_editor_value(self.editor, '', timeout=150)

    def test_document_bytes_are_still_compared_exactly(self):
        self.page.evaluate('''() => {
            document.querySelector('[data-code-editor]').codeEditor = { getValue: () => 'line\\r\\n' };
        }''')
        with self.assertRaisesRegex(AssertionError, 'Editor document did not match'):
            expect_editor_value(self.editor, 'line\n', timeout=150)

    def test_regex_waits_for_a_real_document_handle(self):
        self.page.evaluate('''() => {
            window.editorReady = false;
            setTimeout(() => {
                document.querySelector('[data-code-editor]').codeEditor = { getValue: () => '' };
                window.editorReady = true;
            }, 100);
        }''')
        expect_editor_value(self.editor, re.compile('.*'), timeout=2000)
        self.assertTrue(self.page.evaluate('window.editorReady'))

    def test_textarea_fallback_still_works(self):
        self.page.set_content('<textarea aria-label="Content">Plain café text</textarea>')
        expect_editor_value(self.editor, 'Plain café text')

    def test_document_reader_errors_are_not_retried(self):
        self.page.evaluate('''() => {
            window.readerCalls = 0;
            document.querySelector('[data-code-editor]').codeEditor = {
                getValue() {
                    window.readerCalls += 1;
                    throw new Error('Document reader failed');
                }
            };
        }''')
        with self.assertRaisesRegex(Error, 'Document reader failed'):
            expect_editor_value(self.editor, 'anything', timeout=2000)
        self.assertEqual(self.page.evaluate('window.readerCalls'), 1)

    def test_removal_does_not_reset_the_assertion_timeout(self):
        self.page.evaluate('''() => {
            const host = document.querySelector('[data-code-editor]');
            host.codeEditor = { getValue: () => 'Old document' };
            setTimeout(() => host.remove(), 50);
        }''')
        started = time.monotonic()
        with self.assertRaises(AssertionError):
            expect_editor_value(self.editor, 'New document', timeout=200)
        self.assertLess(time.monotonic() - started, 2)


if __name__ == '__main__':
    unittest.main()
