"""Real isolated console/browser fixture; all assertions live in readable step files."""
import os
import re
import subprocess
import time
import ssl
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import quote, urlencode
from playwright.sync_api import sync_playwright, expect
from scripts.productization.qualify import ROOT, port
from scripts.testing.identity import TLSProxy


class BrowserFixture:
    def __init__(self, world):
        self.world = world
        self.errors = []
        self.console_port = port()
        self.internal_base = 'http://127.0.0.1:' + str(self.console_port)
        subject = world.prepare_browser_identity()
        self.identity = world.h.identity()
        self.proxy = TLSProxy(world.h.dir / ('proxy-' + str(self.console_port)), self.internal_base, world.h.base)
        self.base = self.origin = self.proxy.base
        self.identity.register_client(self.origin)
        self.ca_path = world.h.dir / ('console-ca-' + str(self.console_port) + '.pem')
        self.ca_path.write_bytes(self.identity.ca_path.read_bytes() + self.proxy.ca_path.read_bytes())
        self.log = open(world.h.dir / ('console-' + str(self.console_port) + '.log'), 'w+')
        env = {key: value for key,value in world.h.env.items() if not key.startswith('CONSOLE_')}
        env.update(PORT=str(self.console_port),HOST='127.0.0.1',CONSOLE_SERVICE_URL=world.h.base,
                   CONSOLE_SERVICE_TOKEN=world.console_token, CONSOLE_LOGIN_TOKEN=world.login_token,
                   CONSOLE_ORIGIN=self.origin, CONSOLE_PUBLIC_API_URL=self.origin,
                   CONSOLE_OIDC_ISSUER=self.identity.issuer, CONSOLE_OIDC_CLIENT_ID=self.identity.client_id,
                   CONSOLE_OIDC_CLIENT_SECRET=self.identity.client_secret,
                   NODE_EXTRA_CA_CERTS=str(self.ca_path),CONSOLE_PROJECT=world.h.project,CONSOLE_ALLOW_EDITS='true')
        self.env = env
        dev = getattr(world, 'dev_console', False)
        command = (['node', str(ROOT/'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
                    '--port', str(self.console_port), '--strictPort'] if dev
                   else ['node','.output/server/index.mjs'])
        self.process = subprocess.Popen(command,cwd=ROOT/'apps/console',env=env,stdout=self.log,stderr=self.log)
        try:
            for _ in range(150):
                try:
                    urlopen(self.base,timeout=1,context=ssl.create_default_context(cafile=str(self.ca_path)))
                    break
                except OSError:
                    if self.process.poll() is not None:
                        self.log.seek(0)
                        raise AssertionError('Console stopped before readiness; inspect private console fixture log.')
                    time.sleep(.1)
            else:
                raise AssertionError('Console startup timed out')
            self.playwright = sync_playwright().start()
            self.browser = self.playwright.chromium.launch(headless=True)
            self.context = self.browser.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1000},accept_downloads=True,permissions=['clipboard-read','clipboard-write'])
            self.context.tracing.start(screenshots=True, snapshots=True, sources=True)
            self.sign_in(self.context, subject)
            self.new_page()
            if dev:
                self.page.goto(self.base, wait_until='networkidle')
                # Dev ESM loads barrel exports eagerly; production tree shaking
                # can hide Node-only SDK exports accidentally imported by UI.
                self.page.evaluate('''async () => {
                    for (const name of ['bundle-library', 'import-content', 'draft-workspace', 'improvement-workspace'])
                        await import('/src/components/' + name + '.tsx');
                }''')
                assert not self.errors, 'Development browser errors: ' + '\n'.join(self.errors)
        except BaseException:
            self.close()
            raise

    def sign_in(self, context=None, subject='operator'):
        """Normal browser login through discovery/code/JWKS, including native Chrome contexts."""
        context = context or self.context
        page = context.new_page()
        page.set_default_timeout(15000)
        response = page.goto(self.base + '/auth/login')
        assert response and response.status == 200, 'OIDC fixture authorization did not load'
        page.get_by_label('Fixture subject').fill(subject)
        page.get_by_role('button', name='Sign in to fixture').click()
        page.wait_for_url(self.base + '/**', timeout=15000)
        page.wait_for_load_state('networkidle')
        assert any(cookie['name'] == 'acclimate_session' and cookie.get('secure') and cookie.get('httpOnly')
                   for cookie in context.cookies(self.base)), 'Verified OIDC callback did not set a secure session'
        page.close()

    def new_page(self):
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))

    def workspace_path(self, view='bundles', project_id=None):
        project=quote(project_id or self.world.h.project,safe='')
        return '/w/'+project+('/settings/members' if view=='members' else '/'+view)

    def bundle_path(self, view='content', bundle_id=None, channel='stable', **search):
        project=quote(self.world.h.project,safe='')
        bundle=quote(bundle_id or self.world.setup['bundle']['id'],safe='')
        path='/w/'+project+'/bundles/'+bundle
        if view=='changes':
            path+='/changes'
            search=dict(channel=channel,**search)
        else:
            path+='/channels/'+quote(channel,safe='')+'/'+view
        return path+('?' + urlencode({k:v for k,v in search.items() if v is not None}) if search else '')

    def canonical(self, path):
        if path in ('/setup','/'): return self.workspace_path()
        if path=='/access': return self.workspace_path('members')
        if path=='/integrations': return self.workspace_path('connections')
        if path=='/improvement': return self.bundle_path('changes')
        if path in ('/content','/releases','/connect'): return self.bundle_path(path[1:])
        return path

    def visit(self, path):
        path=self.canonical(path)
        response=self.page.goto(self.base+path)
        assert response and response.status==200, 'Console route did not load: '+path
        self.page.wait_for_load_state('networkidle')

    def select_bundle(self):
        path=self.bundle_path('content')
        self.visit(path)
        expect(self.page).to_have_url(self.base+path)
        expect(self.page.get_by_test_id('entry-content')).to_be_visible()

    def restart_browser(self):
        state=self.context.storage_state()
        self.browser.close()
        self.browser=self.playwright.chromium.launch(headless=True)
        self.context=self.browser.new_context(ignore_https_errors=True,storage_state=state,viewport={'width':1440,'height':1000},accept_downloads=True,permissions=['clipboard-read','clipboard-write'])
        self.context.tracing.start(screenshots=True, snapshots=True, sources=True)
        self.new_page()

    def close(self):
        try:
            browser=getattr(self,'browser',None)
            if browser: browser.close()
        finally:
            try:
                driver=getattr(self,'playwright',None)
                if driver: driver.stop()
            finally:
                try:
                    process=getattr(self,'process',None)
                    if process and process.poll() is None:
                        process.terminate()
                        try: process.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                finally:
                    try:
                        log=getattr(self,'log',None)
                        if log: log.close()
                    finally:
                        proxy=getattr(self,'proxy',None)
                        if proxy: proxy.close()
