"""Rendered layout assertions used only by the disposable BDD browser fixture."""
import json
from pathlib import Path


def inspect_layout(page, *, coarse=False):
    """Check real rendered controls; intentional inner scrollers may overflow locally."""
    return page.evaluate('''({coarse}) => {
      const visible = el => {
        if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
        // Closed native disclosures may retain cached boxes for their children.
        for (let parent=el.parentElement;parent;parent=parent.parentElement) {
          if (parent.tagName==='DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false;
        }
        return true;
      };
      const task = [...document.querySelectorAll('button, a[href], [role=menuitem], main label, [role=textbox][contenteditable], input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, select')].filter(visible);
      const controls = task.map(el => ({name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 90) || el.id,
        tag: el.tagName, role:el.getAttribute('role'), font: parseFloat(getComputedStyle(el).fontSize), height: el.getBoundingClientRect().height,
        width: el.getBoundingClientRect().width, minHeight: getComputedStyle(el).minHeight,
        computedHeight: getComputedStyle(el).height, disabled:el.matches(':disabled'), ariaDisabled:el.getAttribute('aria-disabled')}));
      const rect = el => { if (!el || !visible(el)) return null; const r=el.getBoundingClientRect(); return {top:r.top,left:r.left,width:r.width,height:r.height,bottom:r.bottom,right:r.right}; };
      const bundleNav=document.querySelector('nav[aria-label="Bundle navigation"]');
      const heading=document.querySelector('.compact-selected-file');
      const navigator=document.querySelector('.file-navigator');
      const picker=navigator?.querySelector('.file-navigator-toggle');
      const source=document.querySelector('[data-code-editor] .cm-scroller, textarea#draft-text, [data-testid=entry-content]');
      const sourceRect=rect(source);
      const path=document.querySelector('.selected-file-path');
      const navigatorLines=navigator?.innerText.split(/\\n/).map(line=>line.trim()).filter(Boolean) ?? [];
      return {bundleHeaderRows:{back:rect(document.querySelector('.bundle-scope-return-row')),primary:rect(document.querySelector('.bundle-scope-primary')),secondary:rect(document.querySelector('.bundle-scope-secondary'))},
        bundleNavigation: bundleNav ? {bounds:rect(bundleNav),links:[...bundleNav.querySelectorAll('a')].filter(visible).map(el=>({name:el.textContent.trim(),...rect(el)}))} : null,
        hasDetailBackLink:[...document.querySelectorAll('.bundle-scope-return, .workspace-detail-back-link')].some(el=>(el.getAttribute('aria-label') || el.textContent.trim())==='Back to changes'),
        detailBackLinkCount:task.filter(el=>el.tagName==='A' && (el.getAttribute('aria-label') || el.textContent.trim())==='Back to changes').length,
        viewport: innerWidth, viewportHeight:innerHeight, width: document.documentElement.scrollWidth,
        editor: rect(document.querySelector('[data-code-editor] .cm-scroller, textarea#draft-text')),
        editorScrollTop: document.querySelector('[data-code-editor] .cm-scroller, textarea#draft-text')?.scrollTop ?? null,
        scrollY, visualViewportOffsetTop:visualViewport?.offsetTop ?? null,
        publishedContent: rect(document.querySelector('[data-testid=entry-content]')),
        sourceVisibleHeight:sourceRect ? Math.max(0,Math.min(innerHeight,sourceRect.bottom)-Math.max(0,sourceRect.top)) : null,
        selectedHeader:rect(heading), selectedIdentity:rect(heading?.firstElementChild),
        selectedActions:rect(heading?.lastElementChild),
        fileCountFooter:navigator ? {text:navigator.querySelector('.file-navigator-footer')?.textContent.trim(),bounds:rect(navigator.querySelector('.file-navigator-footer')),tree:rect(navigator.querySelector('.file-tree'))} : null,
        selectedPath:path ? {text:path.textContent.trim(),bounds:rect(path),lineHeight:parseFloat(getComputedStyle(path).lineHeight),scrollWidth:path.scrollWidth,clientWidth:path.clientWidth,whiteSpace:getComputedStyle(path).whiteSpace} : null,
        fileNavigator:navigator ? {bounds:rect(navigator),trigger:rect(picker),expanded:picker?.getAttribute('aria-expanded'),
          filesCaptions:navigatorLines.filter(line=>/^Files(?:\\s*\\(\\d+\\))?$/.test(line)),
          entryCountCaptions:navigatorLines.filter(line=>/^\\d+\\s+entr(?:y|ies)$/.test(line))} : null,
        fileRows: [...document.querySelectorAll('.content-file-button')].filter(visible).map(rect),
        pointerCoarse: matchMedia('(pointer: coarse)').matches, anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
        smallText: controls.filter(el => el.font < 14),
        smallReadingText:[...document.querySelectorAll('.draft-status p,.selected-file-path,.file-row-directory,.file-tree-label,.file-navigator-footer,.review-identity,.review-boundary,.content-diff pre,.cm-line')].filter(visible).filter(el=>parseFloat(getComputedStyle(el).fontSize)<14).map(el=>({text:el.textContent.slice(0,90),font:parseFloat(getComputedStyle(el).fontSize)})),
        smallTargets: coarse ? controls.filter(el => (['BUTTON','INPUT','TEXTAREA','SELECT','A'].includes(el.tag) || ['menuitem','textbox'].includes(el.role)) && (el.height < 44 || el.width < 44)) : [],
        controls};
    }''', dict(coarse=coarse))


def assert_layout_metrics(metrics, *, coarse=False):
    if coarse:
        assert metrics['pointerCoarse'], 'Coarse acceptance must use a real coarse pointer context'
    assert metrics['controls'], 'Layout route rendered no task controls'
    assert metrics['width'] <= metrics['viewport'] + 1, metrics
    assert not metrics['smallText'], metrics['smallText']
    assert not metrics.get('smallReadingText'), metrics.get('smallReadingText')
    assert not metrics['smallTargets'], metrics['smallTargets']
    assert_navigation_metrics(metrics)
    assert_file_heading_metrics(metrics)
    return metrics


def assert_layout(page, *, coarse=False):
    return assert_layout_metrics(inspect_layout(page, coarse=coarse), coarse=coarse)


def capture_layout(page, directory, name, *, coarse=False):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Full-page screenshots can change Chromium's emulated viewport and pointer
    # media state across later captures. Capture the actual viewport instead.
    page.evaluate('''async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    }''')
    metrics = inspect_layout(page, coarse=coarse)
    (directory/(name+'.json')).write_text(json.dumps(metrics, indent=2)+'\n')
    page.screenshot(path=str(directory/(name+'.png')), full_page=False)
    return assert_layout_metrics(metrics, coarse=coarse)


def tab_to(page, target, limit=160, *, reverse=False, tree=False):
    """Use native Tab, then native tree keys for a roving treeitem target.

    Pass tree=True for an initially unrendered descendant of a folded folder.
    Existing visible treeitem locators are recognized without selector parsing.
    """
    exists=target.count()>0
    tree_target=tree or (exists and target.evaluate("el=>el.getAttribute('role')==='treeitem'"))
    if tree_target:
        return tree_tab_to(page,target,limit=limit,reverse=reverse)
    if exists and target.evaluate('el => el === document.activeElement'):
        assert_focus_visible(target)
        return
    trace=[]
    for _ in range(limit):
        page.keyboard.press('Shift+Tab' if reverse else 'Tab')
        if target.evaluate('el => el === document.activeElement'):
            assert_focus_visible(target)
            return
        trace.append(page.evaluate('''() => ({tag:document.activeElement?.tagName,id:document.activeElement?.id,label:document.activeElement?.getAttribute('aria-label'),role:document.activeElement?.getAttribute('role'),tabIndex:document.activeElement?.tabIndex})'''))
    target_state=target.evaluate('''el => ({disabled:el.matches(':disabled'),tabIndex:el.tabIndex,expanded:el.getAttribute('aria-expanded'),display:getComputedStyle(el).display})''')
    raise AssertionError('Control was not reachable using Tab: '+str(target)+'; target='+str(target_state)+'; last focus='+str(trace[-12:]))


def tree_tab_to(page,target,limit=160,*,reverse=False):
    """Reach treeitems without mouse clicks or programmatic focus injection."""
    tree=page.get_by_role('tree',name='Files',exact=True)
    assert tree.count()==1,'Expected one real Files tree'
    for _ in range(limit):
        if tree.evaluate('el=>el.contains(document.activeElement)'):break
        page.keyboard.press('Shift+Tab' if reverse else 'Tab')
    else:raise AssertionError('Files tree was not reachable through native Tab')
    if target.count() and target.evaluate('el=>el===document.activeElement'):
        assert_focus_visible(target);return
    page.keyboard.press('Home')
    last=None
    for _ in range(limit):
        if target.count() and target.evaluate('el=>el===document.activeElement'):
            assert_focus_visible(target);return
        active=tree.evaluate("el=>({inside:el.contains(document.activeElement),node:document.activeElement.getAttribute('data-tree-node-id'),expanded:document.activeElement.getAttribute('aria-expanded')})")
        assert active['inside'],'Native tree keys unexpectedly left Files'
        if active['expanded']=='false':
            page.keyboard.press('ArrowRight');last=None
        else:
            if active['node']==last:break
            last=active['node'];page.keyboard.press('ArrowDown')
    raise AssertionError('Tree target was not reachable using Tab/Home/ArrowRight/ArrowDown: '+str(target))


def assert_focus_visible(target):
    result = target.evaluate('''async el => {
      // Let a newly opened dialog finish moving before checking occlusion.
      const ancestors=[]; for(let parent=el;parent;parent=parent.parentElement) ancestors.push(parent);
      const animations=ancestors.flatMap(parent=>parent.getAnimations()).filter(animation=>animation.playState==='running');
      await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));

      // A virtualized editor's content canvas can be thousands of lines tall.
      // Hit-test the actual editor viewport while retaining the native focus check.
      const viewport=el.closest('[data-code-editor]')?.querySelector('.cm-scroller');
      const r=(viewport ?? el).getBoundingClientRect();
      const x=Math.max(0, Math.min(innerWidth-1, (r.left+r.right)/2));
      const y=Math.max(0, Math.min(innerHeight-1, (r.top+r.bottom)/2));
      const top=document.elementFromPoint(x,y);
      return {focused:el===document.activeElement, visible:r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth,
        uncovered:!!top && (el===top || el.contains(top) || viewport?.contains(top)), name:(el.getAttribute('aria-label')||el.textContent).trim().slice(0,160)};
    }''')
    assert result['focused'] and result['visible'] and result['uncovered'], result


def assert_compact_editor(metrics):
    """Keep the source usable beside the64px rail and Back/identity/tab header rows.

    At1440×900 the intended layout renders1092×646 at y245: the64px rail
    remains, and Back now has its own line above the title and bundle tabs.
    Retain the640px height floor and area advantage over the680056px² baseline.
    """
    assert metrics['viewport']==1440 and metrics['viewportHeight']==900, metrics
    editor=metrics['editor']
    assert editor, 'No editable draft surface was rendered'
    assert editor['top'] <= 250, editor
    assert editor['width'] >= 1080, editor
    assert editor['height'] >= 640, editor
    assert editor['width'] * editor['height'] > 680056, editor
    assert len(metrics['fileRows']) >= 4, metrics['fileRows']
    return metrics


def assert_navigation_metrics(metrics):
    """Keep every bundle tab fully visible and the narrow detail back-link unique."""
    navigation=metrics.get('bundleNavigation')
    rows=metrics.get('bundleHeaderRows',{})
    if metrics['viewport']>1000 and navigation:
        back,first,second=rows.get('back'),rows.get('primary'),rows.get('secondary')
        assert back and first and second, 'Back, identity and tabs must expose separate real rows'
        assert first['top']>=back['bottom']-1, dict(back=back,first=first)
        assert second['top']>=first['bottom']-1, dict(first=first,second=second)
        bounds=navigation['bounds']
        assert bounds and bounds['top']>=second['top']-1 and bounds['bottom']<=second['bottom']+1, dict(navigation=bounds,second=second)
    if metrics['viewport'] in (390,320) and navigation:
        bounds=navigation['bounds']
        assert bounds and len(navigation['links'])==4, navigation
        clipped=[link for link in navigation['links'] if link['left'] < bounds['left']-1 or link['right'] > bounds['right']+1 or link['top'] < bounds['top']-1 or link['bottom'] > bounds['bottom']+1]
        assert not clipped, dict(navigation=bounds,clippedTabs=clipped)
    if metrics['viewport']<=600 and metrics.get('hasDetailBackLink'):
        assert metrics['detailBackLinkCount']==1, dict(viewport=metrics['viewport'],visibleBackLinks=metrics['detailBackLinkCount'])
    return metrics


def assert_file_heading_metrics(metrics):
    """Check the persistent narrow Files trigger and readable selected identity."""
    navigator=metrics.get('fileNavigator')
    footer=metrics.get('fileCountFooter')
    if navigator and footer and footer['bounds'] and footer['tree']:
        assert footer['bounds']['top']>=footer['tree']['bottom']-1, footer
        assert footer['bounds']['bottom']<=navigator['bounds']['bottom']+1, dict(footer=footer,navigator=navigator)
    if navigator and metrics['viewport']<900:
        trigger=navigator['trigger']
        assert trigger, 'Narrow file navigation lost its persistent Files trigger'
        assert len(navigator['filesCaptions'])<=1, navigator
        assert len(navigator['filesCaptions'])+len(navigator['entryCountCaptions'])<=2, navigator
        header=metrics.get('selectedHeader')
        if header and navigator['expanded']=='false':
            assert trigger['top']>=header['top']-1 and trigger['bottom']<=header['bottom']+1, dict(trigger=trigger,header=header)
        identity=metrics.get('selectedIdentity')
        if identity:
            overlap=min(trigger['right'],identity['right'])-max(trigger['left'],identity['left'])>1 and min(trigger['bottom'],identity['bottom'])-max(trigger['top'],identity['top'])>1
            assert not overlap, dict(trigger=trigger,identity=identity)
    path=metrics.get('selectedPath')
    if path and path['bounds']:
        assert path['scrollWidth']<=path['clientWidth']+1, path
        assert path['whiteSpace']!='nowrap', path
    return metrics
