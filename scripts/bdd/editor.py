"""Read a real editor through its public host API; input stays native browser input."""
import re
import time

from playwright.sync_api import Error, TimeoutError, expect


def editor_value(editor, *, timeout=None):
    """Read all document bytes, including lines outside a virtualized viewport."""
    return editor.evaluate('''element => {
      const handle = element.codeEditor ?? element.closest('[data-code-editor]')?.codeEditor;
      if (handle) return handle.getValue();
      if (element instanceof HTMLTextAreaElement) return element.value;
      throw new Error('The labelled editor has no public document handle');
    }''', timeout=timeout)


def _wait_editor(editor, expected, predicate, timeout):
    deadline = time.monotonic() + timeout / 1000
    expect(editor).to_be_attached(timeout=timeout)
    actual = None
    while time.monotonic() < deadline:
        remaining = max(1, int((deadline - time.monotonic()) * 1000))
        try:
            actual = editor_value(editor, timeout=remaining)
        except TimeoutError:
            # Acquiring a replacement used the remaining assertion budget.
            break
        except Error as error:
            # A navigation can unmount the acquired element before evaluation.
            # Retry only this readiness gap; actual reader/browser errors fail.
            if 'The labelled editor has no public document handle' not in error.message:
                raise
            actual = None
        if actual is not None and predicate(actual):
            return
        remaining = (deadline - time.monotonic()) * 1000
        if remaining > 0:
            editor.page.wait_for_timeout(min(50, remaining))
    if actual is None:
        raise AssertionError('Editor did not expose its public document handle before timeout')
    preview = repr(expected)
    raise AssertionError(f'Editor document did not match {preview[:800]}; actual={actual[:800]!r}')


def expect_editor_value(editor, expected, *, timeout=5000):
    """Compare exact bytes, never rendered/normalized/visible-line text."""
    match = (lambda actual: bool(expected.search(actual))) if isinstance(expected, re.Pattern) else (lambda actual: actual == expected)
    _wait_editor(editor, expected, match, timeout)


def expect_editor_contains(editor, expected, *, timeout=5000):
    _wait_editor(editor, expected, lambda actual: expected in actual, timeout)
