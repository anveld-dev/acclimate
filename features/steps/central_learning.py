"""Exercise the learning loop against a real service, worker and no-network runners."""
import json
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from behave import given, when, then
from playwright.sync_api import expect

from executor.tests.sandbox import build_test_image
from executor.tests.worker import start_worker
from scripts.productization.qualify import ROOT, port

MODELS = ["task", "judge"]
MATERIAL = ("input,expected\n" + "".join(f"Review request {i},checked\n" for i in range(43))).encode()
CONVERSION = b"question,answer\nReview one more request,checked\nMissing reference,\n"


def wait_for(read, accepts, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if accepts(value):
            return value
        assert time.monotonic() < deadline, "Timed out waiting for " + read.__name__
        time.sleep(.4)


def upstream(w, body):
    if body.get("max_completion_tokens") == 1:
        return "Hi"
    system, user = [m["content"] for m in body["messages"]]
    if body["model"] == "task":
        if "Double-check the evidence." in system and user in w.monitor_inputs:
            return "unchecked"
        return "checked" if "Check the evidence." in system else "unchecked"
    if body["model"] == "judge":
        data = json.loads(user)
        if "criteria" in data:
            e = data["evidence"]
            output = e["response"]["choices"][0]["message"]["content"] if "response" in e else e["output"]
            return json.dumps({"criteria": [{"passed": output == "checked", "reason": "Compared the response to the reference."}]})
        return json.dumps({"inputPath": "/material/question", "referencePath": "/material/answer", "drafted": ["Matches the requested finding."]} if data["material"].get("answer") else {})
    assert body["model"] == "optimizer"
    data = json.loads(user.split("\n", 1)[1].rsplit("\n", 1)[0])
    assert not any(json.dumps(task) in user for task in w.monitor_inputs)
    candidates = data.get("candidates")
    if candidates is None:
        text = "Check the evidence." + (" Double-check the evidence." if data["history"] else "")
        return json.dumps(dict(schemaVersion=2, rationale="Validate the response.", edits=[],
            files=[dict(op="write", path="instructions/review.md", text=text)],
            diagnosis=dict(problem={"new": "Missing evidence."}, predicted=[data["feedback"]["cases"][0]["caseId"]])))
    if "evolve" in candidates[0]:
        return json.dumps(dict(decision="adopt", sample=candidates[0]["sample"], reason="Review evidence."))
    return json.dumps({"samples": [dict(sample=c["sample"], verdict="evaluate" if i == 0 else "skip",
                                         reason="Review one distinct edit.") for i, c in enumerate(candidates)]})


@given("a published chat bundle and a real executor")
def workspace(context):
    w = context.world
    w.monitor_inputs = set()
    w.fixture_key = secrets.token_hex(24)
    w.errors = []

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                assert self.headers["Authorization"] == "Bearer " + w.fixture_key
                answer = upstream(w, json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(dict(choices=[dict(finish_reason="stop", message=dict(content=answer))],
                    usage=dict(prompt_tokens=8, completion_tokens=2, total_tokens=10))).encode())
            except Exception as error:
                w.errors.append(error)
                self.send_error(500)

    server = ThreadingHTTPServer(("0.0.0.0", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    context.add_cleanup(server.server_close)
    context.add_cleanup(server.shutdown)
    internal = port()
    w.provider_url = f"http://host.docker.internal:{server.server_port}/v1"
    w.h.env.update(ACCLIMATE_INTERNAL_BIND=f"0.0.0.0:{internal}",
                   ACCLIMATE_PROVIDER_HTTP_HOSTS="host.docker.internal",
                   ACCLIMATE_PROVIDER_ENCRYPTION_KEY=secrets.token_hex(32),
                   ACCLIMATE_MODEL="optimizer", ACCLIMATE_MODEL_TOKEN=w.fixture_key,
                   ACCLIMATE_MODEL_ENDPOINT=f"http://127.0.0.1:{server.server_port}/v1/chat/completions")
    w.h.restart()
    w.publish_initial("Answer the question.")
    w.prepare_browser_identity()
    token = json.loads(subprocess.check_output([ROOT / "target/debug/acclimate-service", "--create-executor-token"],
                                                env=w.h.env))["token"]
    runner = build_test_image(context.add_cleanup, "executor/runner")
    image = build_test_image(context.add_cleanup, "-f", "executor/Dockerfile", ".")
    start_worker(context.add_cleanup, runner, image, token, internal, concurrency=8)
    w.learning = w.bundle + "/learning"
    w.learning_page = "/w/" + w.h.project + "/bundles/" + w.setup["bundle"]["id"] + "/learning"


def session(w, method, path, body=None, **kw):
    return w.call(method, path, body, actor="_browser-operator", **kw)


def import_csv(w, name, content):
    headers = {"Authorization": "Bearer " + w.console_token, "X-Acclimate-Session": w.sessions["_browser-operator"]["secret"],
               "Content-Type": "text/csv"}
    request = Request(w.h.base + w.learning + "/tasks/import?filename=" + name, headers=headers, data=content)
    with urlopen(request) as response:
        return json.load(response)


@when("I configure learning and import material through the API")
def configure_api(context):
    w = context.world
    path = w.root + "/model-provider"
    config = dict(baseUrl=w.provider_url, allowedModels=MODELS)
    session(w, "PUT", path, dict(config, apiKey=w.fixture_key))
    assert session(w, "PUT", path, config)["hasKey"]
    wait_for(lambda: session(w, "GET", path), lambda p: p["verification"]["status"] == "verified")
    session(w, "PUT", w.learning, dict(channel="stable", taskModel="task", judgeModel="judge",
                                      maxRoundsPerDay=2, setting=dict(domain="review", benchmark="support")))
    import_csv(w, "answers.csv", MATERIAL)
    receipt = import_csv(w, "conversations.csv", CONVERSION)
    status = wait_for(lambda: session(w, "GET", w.learning + "/tasks/imports/" + receipt["importId"]),
                      lambda job: not job["pending"])
    assert status["converted"] == 1 and status["setAside"][0]["reason"] == "no-reference", status


@when("I configure learning and import material through the console")
def configure_ui(context):
    w = context.world
    browser = w.browser()
    page = browser.page
    browser.visit("/access")
    page.get_by_label("OpenAI-compatible base URL").fill(w.provider_url)
    page.get_by_label("API key", exact=False).fill(w.fixture_key)
    page.get_by_label("Allowed models").fill(", ".join(MODELS))
    page.get_by_role("button", name="Save provider").click()
    expect(page.get_by_text("Provider verification: verified")).to_be_visible(timeout=60000)
    browser.visit(w.learning_page)
    page.get_by_label("Task model").select_option("task")
    page.get_by_label("Judge model").select_option("judge")
    page.get_by_label("Maximum rounds per day").fill("2")
    page.get_by_role("button", name="Save learning settings").click()
    for name, content, summary in [("answers.csv", MATERIAL, "43 converted"), ("conversations.csv", CONVERSION, "1 set aside")]:
        page.get_by_label("Spreadsheet, CSV or JSONL").set_input_files(dict(name=name, mimeType="text/csv", buffer=content))
        page.get_by_role("button", name="Import tasks").click()
        expect(page.get_by_text(summary, exact=False).first).to_be_visible(timeout=60000)
    expect(page.get_by_label("Set-aside rows")).to_contain_text("No usable reference answer", timeout=60000)


@when("the imported cards pass admission")
def admission(context):
    w = context.world
    cards = session(w, "GET", w.learning + "/tasks?limit=100")["items"]
    for card in cards:
        if card["split"] == "held-out":
            w.monitor_inputs.add(card["input"])
            if not card["confirmedBy"]:
                session(w, "PATCH", w.learning + "/tasks/" + card["taskId"], {"confirm": True})
    w.card = next(c for c in cards if c["split"] == "evolve")
    session(w, "PATCH", w.learning + "/tasks/" + w.card["taskId"], {
        "grader": {"type": "criteria", "criteria": ["Matches the requested finding."], "reference": "checked"}
    })
    counts = wait_for(lambda: w.call("GET", w.learning),
                      lambda loop: loop["admittedEvolve"] + loop["admittedHeldOut"] == len(cards))
    assert min(counts["admittedEvolve"], counts["admittedHeldOut"]) >= 20


@when("I try an admitted card and start through the API")
def start_api(context):
    w = context.world
    trial = session(w, "POST", w.learning + "/tasks/" + w.card["taskId"] + "/try")
    result = wait_for(lambda: session(w, "GET", w.learning + "/trials/" + trial["trialId"]), lambda t: t["status"] == "scored")
    assert result["gatewayLog"] and result["output"] == "unchecked"
    session(w, "POST", w.learning + "/start")


@when("I try an admitted card and start through the console")
def start_ui(context):
    w = context.world
    w.browser().visit(w.learning_page)
    page = w.browser().page
    page.get_by_role("button", name="Try task").first.click()
    expect(page.get_by_label("Trial result")).to_contain_text("unchecked", timeout=60000)
    page.get_by_role("button", name="Start", exact=True).click()


@when("the service releases an adoption and confirms a held-out regression")
def finished(context):
    w = context.world

    def rounds():
        if w.errors:
            raise w.errors[0]
        result = w.call("GET", w.learning + "/rounds")["items"]
        assert all(r["state"] != "failed" for r in result), [(r["state"], r["reason"]) for r in result]
        return result

    second, first = wait_for(rounds, lambda r: len(r) == 2 and all(x["state"] == "completed" for x in r), timeout=2400)
    assert first["decision"] == second["decision"] == "adopted"
    assert second["parentVersionId"] == first["adoptedVersionId"]
    assert second["reverted"] and w.call("GET", w.learning)["alert"]["reverted"]
    assert w.call("GET", w.channel)["version"]["id"] == first["adoptedVersionId"]
    version = w.call("GET", w.bundle + "/versions/" + second["adoptedVersionId"])
    blocked = w.call("GET", w.learning + "/blocked-versions")
    assert version["digest"] in [entry["digest"] for entry in blocked]
    w.adoption = first["id"]
    w.stale_round = second["id"]


@when("I inspect the round evidence and token usage")
def evidence(context):
    w = context.world
    path = w.learning + "/rounds/" + w.adoption
    detail = w.call("GET", path)
    candidate = next(e for e in detail["evaluations"] if e["role"] == "candidate")
    detail = w.call("GET", path + "?evaluation=" + candidate["id"])
    report = next(e["report"] for e in detail["evaluations"] if e["id"] == candidate["id"])
    case = next(c for c in report["cases"] if c["caseId"] == w.card["taskId"])
    assert len(case["rollouts"]) == 5
    assert all(r["gatewayLog"] and "Compared the response to the reference." in r["reasons"]
               for r in case["rollouts"])
    if "browser" in context.scenario.effective_tags:
        browser = w.browser()
        browser.visit(w.learning_page + "?round=" + w.adoption)
        browser.page.get_by_role("button", name="Show per-task results").click()
        summary = browser.page.locator("summary").filter(has_text=w.card["taskId"])
        summary.click()
        card = summary.locator("..")
        expect(card.get_by_text("Compared the response to the reference.", exact=True).first).to_be_visible()
        gateway = card.locator("details").first
        gateway.locator("summary").click()
        expect(gateway.locator("pre")).to_contain_text("checked")
    assert w.call("GET", w.learning + "/usage")["items"][0]["taskTokens"] > 0
    refusal = session(w, "POST", w.learning + "/rollback", {"roundId": w.stale_round}, expected=409)
    assert refusal["error"]["code"] == "round-not-at-head"


@when("a production job reports an outcome")
def outcome(context):
    sys.path.insert(0, str(ROOT / "python"))
    from acclimate import Acclimate
    w = context.world
    client = Acclimate(w.h.base, w.h.project, w.h.tokens["other"], cache_dir=w.h.dir / "sdk-cache")
    job = client.job("BDD bundle", input="Answer a production request")
    job.expect("checked", output="unchecked")
    cards = session(w, "GET", w.learning + "/tasks?source=outcome")["items"]
    assert any(c["outcomeId"] == job.outcome_id and c["input"] == "Answer a production request" for c in cards)


@then("I roll back the live round and stop through the API")
def stop_api(context):
    w = context.world
    session(w, "POST", w.learning + "/rollback", {"roundId": w.adoption})
    assert session(w, "POST", w.learning + "/stop")["status"] == "stopped"
    assert w.call("GET", w.channel)["version"]["id"] == w.original["version"]["id"]


@then("I inspect the alert, roll back the live round and stop through the console")
def stop_ui(context):
    w = context.world
    w.browser().visit(w.learning_page)
    page = w.browser().page
    expect(page.get_by_text("Held-out score dropped", exact=False)).to_be_visible()
    for label in ("Roll back", "Stop learning"):
        page.get_by_role("button", name=label, exact=True).click()
        page.get_by_role("alertdialog").get_by_role("button", name=label, exact=True).click()
    assert w.call("GET", w.channel)["version"]["id"] == w.original["version"]["id"]
    wait_for(lambda: w.call("GET", w.learning), lambda loop: loop["status"] == "stopped")
