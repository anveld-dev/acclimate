#!/usr/bin/env python3
"""Read-only branded Keycloak layout checks. No credentials or form submission."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--url',default='https://localhost:3443/auth/login');parser.add_argument('--output',required=True,type=Path);args=parser.parse_args()
    assert urlsplit(args.url).hostname in ('localhost','127.0.0.1')
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700)
    states=[];errors=[]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        try:
            for width,coarse in [(1440,False),(390,True),(320,True)]:
                context=browser.new_context(ignore_https_errors=True,viewport=dict(width=width,height=900),has_touch=coarse)
                page=context.new_page();page.on('pageerror',lambda error:errors.append(type(error).__name__))
                page.goto(args.url,wait_until='networkidle')
                expect(page.locator('[data-acclimate-theme="keycloakify"]')).to_be_visible()
                expect(page.get_by_role('heading',name='Sign in to Acclimate',exact=True)).to_be_visible()
                username=page.locator('input[name="username"]');password=page.locator('input[name="password"]')
                expect(username).to_have_attribute('autocomplete','username');expect(password).to_have_attribute('autocomplete','current-password')
                # Only an invented local value is used to test the visibility control.
                password.fill('layout check only')
                page.get_by_role('button',name='Show password',exact=True).click();expect(password).to_have_attribute('type','text')
                page.get_by_role('button',name='Hide password',exact=True).click();expect(password).to_have_attribute('type','password')
                password.fill('');username.click();page.keyboard.press('Tab');expect(password).to_be_focused()
                page.keyboard.press('Tab');expect(page.get_by_role('button',name='Show password',exact=True)).to_be_focused()
                page.keyboard.press('Tab');expect(page.locator('#kc-login')).to_be_focused()
                metrics=page.evaluate('''()=>({width:innerWidth,pageWidth:document.documentElement.scrollWidth,card:document.querySelector('.auth-card').getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('input:not([type=hidden]),button')].filter(el=>el.getClientRects().length).map(el=>({height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,font:parseFloat(getComputedStyle(el).fontSize)}))})''')
                assert metrics['pageWidth']<=width+1,metrics
                assert all(c['height']>=(43.5 if coarse else 39.5) and c['font']>=14 for c in metrics['controls']),metrics
                assert metrics['card']['x']>=12 and metrics['card']['right']<=width-12,metrics
                page.screenshot(path=str(args.output/(str(width)+'-sign-in.png')))
                states.append(dict(width=width,coarse=coarse,keyboardOrder=True,passwordVisibility=True,geometry=metrics));context.close()
        finally:browser.close()
    assert not errors,errors
    report=dict(passed=True,states=states,browserErrors=0,credentialsUsed=False,formSubmissions=0,modelCalls=0)
    (args.output/'summary.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))

if __name__=='__main__':main()
