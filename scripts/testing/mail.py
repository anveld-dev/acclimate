"""Owned Mailpit process for browser fixtures. Never shares the developer inbox."""
import os
import subprocess
import time
from urllib.request import urlopen
from scripts.mailpit import binary
from scripts.productization.qualify import port


class MailpitFixture:
    def __init__(self, directory):
        self.smtp_port, self.ui_port = port(), port()
        self.base = f'http://127.0.0.1:{self.ui_port}'
        self.log = (directory/'mailpit.log').open('w')
        self.process = subprocess.Popen([str(binary()), '--smtp', f'127.0.0.1:{self.smtp_port}', '--listen', f'127.0.0.1:{self.ui_port}', '--database', str(directory/'mailpit.db'), '--disable-version-check', '--quiet'], env={key:value for key,value in os.environ.items() if not key.startswith('MP_')}, stdout=self.log, stderr=self.log)
        try:
            for _ in range(100):
                try:
                    if urlopen(self.base+'/livez', timeout=1).status==200: return
                except OSError: time.sleep(.1)
            raise RuntimeError('Disposable Mailpit did not become ready')
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)
        self.log.close()
