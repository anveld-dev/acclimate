"""Capture the console screenshots used in the docs, in light and dark themes.

    npm run local:up
    .venv-bdd/bin/python scripts/docs/screenshots.py [name ...]

The script signs in to the local stack as its operator and writes PNG files to
apps/docs/public/screenshots. It never submits a form. It needs Playwright with Chromium,
and a stack where the support agent tutorial has run, so that the "Example agent" bundle
shows tasks, an adopted round and its candidates. Pass names to capture
only some screenshots.
"""

import json
import re
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
STACK = ROOT / ".local" / "stack"
OUT = ROOT / "apps" / "docs" / "public" / "screenshots"
WORKSPACE = "local-demo"
SUPPORT = "Example agent"
PANEL = "xpath=ancestor::*[self::section or contains(concat(' ', @class, ' '), ' workspace-panel ')][1]"


def console() -> str:
    port = json.loads((STACK / "ports.json").read_text())["port"]
    return f"https://localhost:{port}"


def sign_in(page: Page, base: str) -> None:
    page.goto(f"{base}/w/{WORKSPACE}/bundles")
    page.wait_for_load_state("networkidle")
    if page.locator("#username").count():
        credentials = json.loads((STACK / "credentials.json").read_text())
        page.fill("#username", "operator@acclimate.invalid")
        page.fill("#password", credentials["operator"])
        page.click("#kc-login")
        page.wait_for_url(f"**/w/{WORKSPACE}/**", timeout=60_000)
        page.wait_for_load_state("networkidle")


def bundle_id(page: Page, base: str, name: str) -> str:
    page.goto(f"{base}/w/{WORKSPACE}/bundles")
    page.wait_for_load_state("networkidle")
    href = page.get_by_role("link", name=name).first.get_attribute("href")
    return href.split("/bundles/")[1].split("/")[0]


def open_page(page: Page, url: str) -> None:
    page.goto(url)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)


def panel(page: Page, heading: str):
    return page.get_by_role("heading", name=heading, exact=True).first.locator(PANEL)


def page_box(locator) -> dict:
    """The element's box in page coordinates, independent of scrolling."""
    return locator.evaluate(
        "e => { const r = e.getBoundingClientRect();"
        " return {x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height}; }"
    )


def shoot_box(page: Page, path: Path, top, bottom) -> None:
    """Capture from the top of one element to the bottom of another."""
    a, b = page_box(top), page_box(bottom)
    left = min(a["x"], b["x"])
    right = max(a["x"] + a["width"], b["x"] + b["width"])
    clip = {"x": left, "y": a["y"], "width": right - left, "height": b["y"] + b["height"] - a["y"]}
    page.screenshot(path=str(path), clip=clip, full_page=True)


def model_provider(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/settings/members")
    panel(page, "Model provider").screenshot(path=str(path))


def issue_token(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/settings/members")
    page.get_by_role("button", name="Issue token").click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    page.wait_for_timeout(300)
    dialog.screenshot(path=str(path))


def learning_setup(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/bundles/{ids['support']}/learning")
    panel(page, "Learning setup").screenshot(path=str(path))


def import_material(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/bundles/{ids['support']}/learning")
    panel(page, "Import material").screenshot(path=str(path))


def task_card(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/bundles/{ids['support']}/learning")
    tasks = panel(page, "Tasks")
    card = tasks.get_by_role("button", name="Copy ID").first.locator(
        "xpath=ancestor::*[.//button[normalize-space(.)='Try task']][1]"
    )
    shoot_box(page, path, tasks, card)


def rounds(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/bundles/{ids['support']}/learning")
    shoot_box(page, path, panel(page, "Scores by round"), panel(page, "Rounds"))


def round_candidate(page, base, ids, path):
    open_page(page, f"{base}/w/{WORKSPACE}/bundles/{ids['support']}/learning?round=1")
    title = page.get_by_text(re.compile(r"^Sample \d+ · Adopted$")).first
    card = title.locator("xpath=ancestor::*[.//button[normalize-space(.)='Show per-task results']][1]")
    card.screenshot(path=str(path))


SHOTS = {
    "model-provider": model_provider,
    "issue-token": issue_token,
    "learning-setup": learning_setup,
    "import-material": import_material,
    "task-card": task_card,
    "rounds": rounds,
    "round-candidate": round_candidate,
}


def main(names: list[str]) -> int:
    unknown = [n for n in names if n not in SHOTS]
    if unknown:
        raise SystemExit(f"Unknown screenshot: {', '.join(unknown)}. Choose from {', '.join(SHOTS)}.")
    OUT.mkdir(parents=True, exist_ok=True)
    base = console()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for scheme in ("light", "dark"):
            context = browser.new_context(
                ignore_https_errors=True, color_scheme=scheme, viewport={"width": 1180, "height": 900}, device_scale_factor=2
            )
            page = context.new_page()
            sign_in(page, base)
            ids = {"support": bundle_id(page, base, SUPPORT)}
            for name in names or SHOTS:
                path = OUT / f"{name}-{scheme}.png"
                SHOTS[name](page, base, ids, path)
                print(f"Wrote {path.relative_to(ROOT)}")
            context.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
