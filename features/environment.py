from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def before_all(context):
    if context.config.dry_run:
        return
    # Tool-launched shells can inherit ignored SIGINT. Restore interruption so
    # Behave unwinds registered test-owned process/database cleanup.
    import signal
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    from scripts.bdd.world import World
    context.world = World(context.config.userdata['pg_bin'])
    context.world.dev_console = context.config.userdata.get('console_mode') == 'dev'
    context.add_cleanup(context.world.close)
    context.world.start()


def before_scenario(context, scenario):
    context.world.fresh_scenario(scenario)
    # One-time credential values must never enter trace snapshots or responses.
    context.world.sensitive_fixture = bool(set(scenario.effective_tags) & {
        'UI-INTEGRATION-01', 'UI-ACCESS-05', 'UI-ACCESS-06',
    })


def after_scenario(context, scenario):
    if not context.config.dry_run:
        browser=getattr(context.world,'browser_fixture',None)
        if browser and scenario.status.name in ('failed','error'):
            import re
            directory=Path(context.config.userdata.get('artifact_dir',ROOT/'artifacts/bdd'))/'failures'
            directory.mkdir(parents=True,exist_ok=True,mode=0o700)
            name=re.sub(r'[^a-zA-Z0-9_-]+','-',scenario.name)[:150]
            try:
                browser.page.screenshot(path=str(directory/(name+'.png')),full_page=True,mask=[browser.page.locator('[data-sensitive=true]')])
                if getattr(browser,'trace_enabled',True):
                    browser.context.tracing.stop(path=str(directory/(name+'.zip')))
            except Exception:
                # Preserve the original assertion if the browser itself has crashed.
                pass
        context.world.close_scenario()
