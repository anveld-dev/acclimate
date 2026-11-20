from behave import when, then
from playwright.sync_api import expect


@when('I reload a bookmark that used to create a draft')
def retired_bookmark(context):
    browser = context.world.browser()
    browser.visit(browser.bundle_path('changes', draft='new'))
    browser.page.reload()


@then('the console points to connections and has no release action')
def connected_settings(context):
    page = context.world.browser_fixture.page
    expect(page.get_by_role('link', name='Open connections')).to_be_visible()
    expect(page.get_by_role('button', name='Publish')).to_have_count(0)
