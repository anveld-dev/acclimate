"""Human-visible progressive disclosure for browser acceptance steps."""
import re
from playwright.sync_api import expect


def open_details(page, name):
    trigger=page.locator('[data-slot=disclosure-trigger]').filter(has_text=re.compile(r'^\s*'+re.escape(name)+r'\s*$'))
    if trigger.count()==0:
        trigger=page.locator('[data-slot=disclosure-trigger]').filter(has_text=name)
    expect(trigger).to_have_count(1)
    if trigger.get_attribute('aria-expanded') == 'false':
        trigger.click()
    expect(trigger).to_have_attribute('aria-expanded', 'true')


def reveal(locator):
    """Expand enclosing panels by their real disclosure buttons, outermost first."""
    # Toggling a panel may rerender recovery controls into a different
    # disclosure surface. Recompute the live ancestor list after every click.
    for _ in range(20):
        closed=locator.locator('xpath=ancestor::*[@data-slot="disclosure" and @data-state="closed"]')
        if closed.count()==0:
            return
        # Resolve the first currently closed ancestor at click time. Reading a
        # count then indexing every ancestor can race a recovery-panel rerender.
        closed.first.locator(':scope > [data-slot=disclosure-trigger]').click()
    raise AssertionError('Disclosure ancestors did not settle')


def submit_and_wait(page, control, method='POST'):
    """Submit a known server action, then wait for its response and dependent reads."""
    with page.expect_response(lambda response: response.request.method == method, timeout=30000):
        control.click()
    page.wait_for_load_state('networkidle')


def open_entry_actions(page):
    """Open the selected entry's real dialog without replacing its editor state."""
    dialog=page.get_by_role('dialog', name='Entry actions', exact=True)
    if dialog.count()==0:
        page.get_by_role('button', name='Entry actions', exact=True).click()
    expect(dialog).to_be_visible()
    return dialog


def close_entry_actions(page):
    dialog=page.get_by_role('dialog', name='Entry actions', exact=True)
    if dialog.count():
        dialog.get_by_role('button', name='Close', exact=True).click()
        expect(dialog).to_have_count(0)


def open_content_actions(page):
    """Reveal published Copy/Download through the selected entry's real popover."""
    panel=page.get_by_role('dialog', name='Published entry actions', exact=True)
    if not panel.count():
        page.get_by_role('button', name='Content actions', exact=True).click()
    expect(panel).to_be_visible()
    return panel


def open_files(page):
    """Use the responsive disclosure when file controls are collapsed."""
    toggle=page.get_by_role('button', name='Files', exact=True)
    if toggle.count() and toggle.is_visible() and toggle.get_attribute('aria-expanded')=='false':
        toggle.click()
        expect(toggle).to_have_attribute('aria-expanded', 'true')


def workspace_menu(page):
    """Open the desktop rail's actual workspace menu, preserving route guards."""
    menu=page.get_by_role('menu')
    if not menu.count():
        page.get_by_role('button',name='Workspaces').click()
    expect(menu).to_be_visible()
    return menu


def choose_workspace(page,workspace_id):
    """Use either the labelled narrow selector or desktop workspace menu."""
    selector=page.get_by_role('combobox',name='Workspace',exact=True).filter(visible=True)
    if selector.count():
        selector.select_option(workspace_id)
    else:
        choice=workspace_menu(page).locator('[role=menuitemradio][data-workspace-id="'+workspace_id+'"]')
        expect(choice).to_have_count(1)
        choice.click()


def assert_workspace_selected(page,workspace_id):
    selector=page.get_by_role('combobox',name='Workspace',exact=True).filter(visible=True)
    if selector.count():
        expect(selector).to_have_value(workspace_id)
    else:
        choice=workspace_menu(page).locator('[role=menuitemradio][data-workspace-id="'+workspace_id+'"]')
        expect(choice).to_have_attribute('aria-checked','true')
        page.keyboard.press('Escape')
        expect(page.get_by_role('menu')).to_have_count(0)


def create_workspace_action(page):
    """Find New workspace in the visible Sheet or bottom rail menu."""
    button=page.get_by_role('button',name='New workspace',exact=True).filter(visible=True)
    if button.count():return button
    item=workspace_menu(page).get_by_role('menuitem',name='New workspace',exact=True)
    expect(item).to_be_visible()
    return item
