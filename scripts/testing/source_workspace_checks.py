"""Focused actual-container, focus, source and review checks."""
from playwright.sync_api import expect
from scripts.testing.compact_console import visit
from scripts.bdd.layout import capture_layout


def verify(w,b,p,routes,out,checks):
    for name,path in routes.items():
        p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,path)
        frame=p.get_by_test_id('file-browser')
        outer=frame.locator('..')
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
