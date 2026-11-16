"""Read a real editor through its public host API; input stays native browser input."""
import re
import time

from playwright.sync_api import expect


def editor_value(editor):
    """Read all document bytes, including lines outside a virtualized viewport."""
    return editor.evaluate('''element => {
      const handle = element.codeEditor ?? element.closest('[data-code-editor]')?.codeEditor;
      if (handle) return handle.getValue();
      if (element instanceof HTMLTextAreaElement) return element.value;
      throw new Error('The labelled editor has no public document handle');
    }''')


def _wait_editor(editor, expected, predicate, timeout):
    expect(editor).to_be_attached(timeout=timeout)
    deadline = time.monotonic() + timeout / 1000
    actual = editor_value(editor)
    while not predicate(actual):
        if time.monotonic() >= deadline:
            preview = repr(expected)
            raise AssertionError(f'Editor document did not match {preview[:800]}; actual={actual[:800]!r}')
        editor.page.wait_for_timeout(50)
        actual = editor_value(editor)


def expect_editor_value(editor, expected, *, timeout=5000):
    """Compare exact bytes, never rendered/normalized/visible-line text."""
    match = (lambda actual: bool(expected.search(actual))) if isinstance(expected, re.Pattern) else (lambda actual: actual == expected)
    _wait_editor(editor, expected, match, timeout)


def expect_editor_contains(editor, expected, *, timeout=5000):
    _wait_editor(editor, expected, lambda actual: expected in actual, timeout)
