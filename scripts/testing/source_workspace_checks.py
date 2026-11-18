"""Focused actual-container, focus, source and review checks."""
import json
from urllib.parse import parse_qs, unquote, urlsplit
from playwright.sync_api import expect
from scripts.testing.compact_console import visit
from scripts.bdd.layout import capture_layout
from scripts.bdd.editor import editor_value, expect_editor_value


def verify(w,b,p,routes,out,checks):
    for name,path in routes.items():
        p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,path)
        frame=p.get_by_test_id('file-browser' if name=='content' else 'draft-file-browser')
        outer=frame.locator('..') if name=='content' else p.locator('.draft-workbench')
        nav=frame.locator('.file-navigator');toggle=nav.get_by_role('button',name='Files',exact=True)
        for width in [1002,901,902,900,432]:
            outer.evaluate('(e,width)=>e.style.width=width+"px"',width)
            compact=frame.evaluate('e=>e.clientWidth<=899')
            expect(nav).to_have_attribute('data-compact',str(compact).lower())
            expect(toggle).to_be_visible() if compact else expect(toggle).to_be_hidden()
            assert frame.evaluate('e=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==(1 if compact else 2)
            assert frame.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            capture_layout(p,out,f'{name}-actual-{frame.evaluate("e=>e.clientWidth")}')
        checks.append(name+': actual workspace widths around899px coordinate grid, picker, hidden state and usable source')
        outer.evaluate('e=>e.style.width="1102px"')
        expect(nav).to_have_attribute('data-compact','false')
        selected=frame.locator('[role=treeitem][aria-selected=true]')
        selected.focus()
        outer.evaluate('e=>e.style.width="432px"')
        expect(nav).to_have_attribute('data-compact','true')
        expect(toggle).to_be_focused()
        expect(nav.locator('.file-navigator-body')).to_be_hidden()
        toggle.press('Enter')
        expect(toggle).to_have_attribute('aria-expanded','true')
        expect(nav.locator('.file-tree')).to_be_visible()
        assert nav.locator('.file-tree').evaluate('e=>e.clientHeight<=240')
        target=nav.get_by_role('treeitem',name='Open AGENTS.md',exact=True)
        target.focus();target.press('Enter')
        expect(toggle).to_have_attribute('aria-expanded','false')
        expect(toggle).to_be_focused()
        expect(frame.locator('.content-entry-heading')).to_contain_text('AGENTS.md')
        capture_layout(p,out,name+'-selection-closed-432')
        # Contrasting viewport/container widths cannot make CSS and hidden state disagree.
        p.set_viewport_size(dict(width=700,height=900));outer.evaluate('e=>e.style.width="1102px"')
        expect(nav).to_have_attribute('data-compact','false')
        expect(toggle).to_be_hidden();expect(nav.locator('.file-navigator-body')).to_be_visible()
        assert nav.locator('.file-navigator-body').evaluate('e=>getComputedStyle(e).position')=='absolute'
        checks.append(name+': resize focus transfer, committed keyboard selection close and narrow-viewport/wide-container cascade')
    p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,routes['draft'])
    editor=p.get_by_role('textbox',name='Content',exact=True)
    text=editor_value(editor)
    edited=text+'\nUnsaved browser review.\n'
    editor.fill(edited)
    expect(p.locator('.draft-status')).to_contain_text('Evaluation uses saved generation 1')
    p.get_by_role('button',name='Review changes',exact=True).click()
    review=p.get_by_role('region',name='Review changes from the creation base')
    expect(review).to_contain_text('unsaved edits')
    expect(review.locator('.content-diff h3')).to_have_count(5)
    capture_layout(p,out,'whole-draft-review-1440')
    map=review.get_by_role('region',name='Changed artifact map',exact=True)
    change=map.get_by_role('button').first
    change.click()
    expect(review.get_by_role('combobox',name='Review scope')).to_have_value('path:AGENTS.md')
    merge=review.get_by_role('region',name='Changed lines in AGENTS.md')
    expect(merge.locator('.cm-mergeView .cm-content')).to_have_count(2)
    merge.get_by_role('button',name='Unified',exact=True).click()
    expect(merge.locator('.cm-content')).to_have_count(1)
    review.get_by_role('button',name='Show all file changes',exact=True).click()
    expect(review.locator('.content-diff h3')).to_have_count(5)
    href=review.get_by_role('link',name='Download current entry JSON',exact=True).last.get_attribute('href')
    entry=json.loads(unquote(href.split(',',1)[1]));assert entry['text']==edited
    review.evaluate('e=>e.style.width="430px"')
    assert review.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    assert map.evaluate("e=>getComputedStyle(e).gridTemplateColumns.split(' ').length")==1
    long_change=map.get_by_role('button').filter(has_text='ambiguous-outcome-operation-identity-checks.md')
    for button in map.get_by_role('button').all():
        assert button.locator('.artifact-change-path').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
        assert button.evaluate('e=>e.scrollHeight<=e.clientHeight+1')
    long_change.focus();p.keyboard.press('Enter')
    selected_path=parse_qs(urlsplit(routes['draft']).query)['path'][0]
    expect(review.get_by_role('combobox',name='Review scope')).to_have_value('path:'+selected_path)
    review.get_by_role('button',name='Show all file changes',exact=True).click()
    expect(review.locator('.content-diff h3')).to_have_count(5)
    capture_layout(p,out,'whole-draft-review-constrained-430')
    p.get_by_role('button',name='Edit entries',exact=True).click()
    # The source engine stays mounted or reconciles its exact source through review.
    current=p.get_by_role('textbox',name='Content',exact=True)
    expect_editor_value(current,edited)
    expect(current).to_be_focused()
    checks.append('Whole-draft browser review map/selection/show-all, parsed JSON exact source, constrained reflow and edit retention')
