#!/usr/bin/env python3
"""Actual syntax/editor/file-control proof on disposable PostgreSQL/OIDC fixtures.

No builds, servers outside the fixture, provider/model calls, auth injection or
DOM or focus mutation.
"""
import argparse
import json
import os
import subprocess
import uuid
from pathlib import Path
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.editor import editor_value, expect_editor_value
from scripts.bdd.interactions import open_content_actions
from scripts.bdd.layout import capture_layout, tab_to
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import Evidence, build_fingerprint

LONG_SOURCE = '# Exact large policy — café 👩‍💻\r\n' + ''.join(
    f'- Rule {index:04}: preserve the original request identity.' + ('\n' if index == 3 else '\r\n')
    for index in range(3000)
)
JSON_SOURCE = '{\n  "retry": false,\n  "requestId": "same-request"\n}\n'
HTML_SOURCE = '<script>window.__qaUnsafeSyntax = true</script>\n<img src="x" onerror="window.__qaUnsafeSyntax = true">\n'
FILES = [
    dict(path='AGENTS.md', kind='instruction', text=LONG_SOURCE),
    dict(path='skills/review/SKILL.md', kind='skill', text='---\nname: review\ndescription: Review retry contracts.\n---\nKeep request identity.\n'),
    dict(path='memory/context.json', kind='memory', text=JSON_SOURCE),
    dict(path='memory/untrusted.html', kind='memory', text=HTML_SOURCE),
]
assert len(LONG_SOURCE.encode()) < 256 * 1024


def readonly(w, b, evidence):
    p = b.page
    visit(p, b, b.bundle_path('content', path='memory/context.json'))
    source = p.get_by_test_id('entry-content')
    expect(source).to_have_attribute('data-highlighted', 'true', timeout=15000)
    assert source.text_content() == JSON_SOURCE
    panel = open_content_actions(p)
    panel.get_by_role('button', name='Copy content', exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()') == JSON_SOURCE
    p.keyboard.press('Escape')
    expect(p.get_by_label('Entry type', exact=True)).to_have_count(0)
    expect(p.locator('.file-navigator-footer')).to_have_text('4 files')
    capture_layout(p, evidence.output, 'published-json-highlighted')
    p.get_by_role('treeitem', name='Open memory/untrusted.html', exact=True).click()
    expect(source).to_have_attribute('data-syntax-language', 'html')
    expect(source).to_have_attribute('data-highlighted', 'true', timeout=15000)
    assert source.text_content() == HTML_SOURCE
    assert source.locator('script,img').count() == 0
    assert p.evaluate('window.__qaUnsafeSyntax === undefined')
    p.get_by_role('treeitem', name='Open AGENTS.md', exact=True).click()
    expect(source).to_have_attribute('data-syntax-language', 'markdown')
    expect(source).to_have_attribute('data-highlighted', 'false')
    # The HTML parser normalizes rendered line endings; Copy remains byte-exact.
    assert source.text_content().replace('\r\n','\n').replace('\r','\n') == LONG_SOURCE.replace('\r\n','\n').replace('\r','\n')
    panel = open_content_actions(p)
    panel.get_by_role('button', name='Copy content', exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()') == LONG_SOURCE
    p.keyboard.press('Escape')
    return dict(jsonSyntax=True, exactCopy=True, largePlainFallback=True, untrustedMarkupIsData=True, noKindFilter=True, footerCount=True)


def sdk_copied_recipes(w, b, evidence):
    p = b.page
    visit(p, b, b.bundle_path('connect'))
    outcomes = []
    for language, extension in [('TypeScript', 'ts'), ('Python', 'py')]:
        p.get_by_role('radio', name=language, exact=True).click()
        recipe = p.get_by_label(language+' delivery recipe', exact=True)
        expect(recipe).to_have_attribute('data-syntax-language', 'typescript' if extension == 'ts' else 'python')
        expect(recipe).to_have_attribute('data-highlighted', 'true', timeout=15000)
        expect(recipe).to_contain_text('checkedFiles')
        p.get_by_role('button', name='Copy recipe', exact=True).click()
        code = p.evaluate('navigator.clipboard.readText()')
        assert code == recipe.text_content(), 'Copied code differs from displayed code'
        assert 'createReceiptReporter' not in code and 'create_receipt_reporter' not in code
        local = ROOT/'.local'/('qa-copied-recipe-'+uuid.uuid4().hex+'.'+extension)
        local.parent.mkdir(exist_ok=True, mode=0o700)
        local.write_text(code)
        local.chmod(0o600)
        job = w.h.dir/('copied-'+extension+'-job')
        env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
        env.update(ACCLIMATE_URL=w.h.base, ACCLIMATE_TOKEN=w.h.tokens['operator'],
                   ACCLIMATE_SCOPE='qa-copied-'+extension, ACCLIMATE_CACHE=str(w.h.dir/('copied-'+extension+'-cache')),
                   ACCLIMATE_JOB_DIR=str(job))
        if extension == 'py':
            env['PYTHONPATH'] = str(ROOT/'python')
            command = [sys.executable, str(local)]
        else:
            command = ['node', '--import', 'tsx', str(local)]
        try:
            process = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        finally:
            local.unlink(missing_ok=True)
        if process.returncode:
            error = process.stderr
            for token in w.h.tokens.values(): error = error.replace(token, '[redacted]')
            raise AssertionError(language+' copied recipe failed: '+error[-1200:])
        assert w.original['version']['id'] in process.stdout
        assert w.original['version']['digest'] in process.stdout
        if extension == 'py': assert json.loads(process.stdout)['checkedFiles'] == len(FILES)
        else: assert 'checkedFiles: '+str(len(FILES)) in process.stdout
        assert all(not (job/file['path']).exists() for file in FILES), 'Prepared source was not cleaned up'
        capture_layout(p, evidence.output, 'sdk-'+extension+'-basic-recipe')
        outcomes.append(dict(language=language, displayedCopyExact=True, executable=True, preparedAndReadFiles=len(FILES), cleanup=True))
    advanced = p.get_by_role('button', name='Optional delivery reports', exact=True)
    expect(advanced).to_have_attribute('aria-expanded', 'false')
    advanced.click()
    expect(p.get_by_label('Python reporting recipe', exact=True)).to_be_visible()
    expect(p.get_by_role('button', name='Copy reporting recipe', exact=True)).to_be_visible()
    return dict(recipes=outcomes, advancedReportingSeparate=True, modelCalls=0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--expected-build-hash', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sdk', action='store_true', help='Execute actual copied minimal TS/Python recipes from the new setup page')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    evidence = Evidence(output, False)
    before = build_fingerprint()
    world = World(pg_bin(args.pg_bin))
    unchanged = False
    try:
        assert before == args.expected_build_hash
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('', files=FILES)
        original = world.call('GET', world.channel)
        b = world.browser()
        b.page.set_viewport_size(dict(width=1440, height=900))
        evidence.run('readonly-syntax-copy-and-safe-markup', b.page, lambda: readonly(world, b, evidence))
        if args.sdk:
            evidence.run('copied-typescript-python-basic-delivery', b.page, lambda: sdk_copied_recipes(world, b, evidence))
        assert world.call('GET', world.channel) == original, 'Inspection changed the release'
        assert not b.errors, b.errors
        unchanged = True
    except Exception as error:
        evidence.failures.append(dict(check='fixture-or-invariants', error=str(error)))
    finally:
        after = build_fingerprint()
        world.close()
        if before != after:
            evidence.failures.append(dict(check='frozen-build', error='Production output changed'))
        result = dict(passed=not evidence.failures, checks=evidence.checks, failures=evidence.failures, releaseUnchanged=unchanged, sourceBuildBeforeSha256=before, sourceBuildAfterSha256=after, paidModelCalls=0, providerCalls=0, domMutation=False, focusInjection=False, limits=['Disposable fixture service.'])
        (output/'summary.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
