"""Real service controls with deterministic executor results in the private scenario database."""
import json
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from behave import given, when, then
from playwright.sync_api import expect

MODELS = ["task-fixture", "judge-fixture"]
MATERIAL = b"input,expected\nQuestion,Answer\n"


def trial_gateway(context):
    # Trial and conversion-status routes use the executor contract from the integration branch.
    world = context.world
    trial = str(uuid.uuid4())
    verified = dict(status="verified", checkedAt="2026-01-01T00:00:00Z",
                    models=[dict(model=m, ok=True, usage=True, message=None) for m in MODELS])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def dispatch(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path.startswith(world.bundle + "/learning/tasks/") and self.path.endswith("/try") and self.command == "POST":
                assert self.headers.get("x-acclimate-session")
                status, result = 200, json.dumps({"trialId": trial}).encode()
            elif self.path == world.bundle + "/learning/trials/" + trial and self.command == "GET":
                status, result = 200, json.dumps(dict(trialId=trial, status="scored", output="Answer",
                    gatewayLog=["fixture completion"], verdict=dict(passed=True, reasons=["Matches reference"]))).encode()
            elif self.path.startswith(world.learning + "/tasks/imports/") and self.command == "GET":
                status, result = 200, json.dumps(dict(importId=self.path.rsplit("/", 1)[1],
                    rows=1, converted=0, pending=0, setAside=[dict(row=1, source="conversations.txt", reason="no-reference")], status="completed")).encode()
            else:
                request = Request(world.h.base + self.path, method=self.command,
                    headers={key: value for key, value in self.headers.items() if key.lower() not in ("host", "connection")},
                    data=body or None)
                try:
                    upstream = urlopen(request, timeout=15)
                except HTTPError as error:
                    upstream = error
                with upstream:
                    status, result = upstream.status, upstream.read()
                if self.path == world.root + "/model-provider" and status == 200:
                    provider = json.loads(result)
                    if self.command == "PUT" and provider.get("verification"):
                        sql(world, f"""UPDATE workspace_model_providers SET verification='{json.dumps(verified)}'
                            WHERE project_id='{world.h.project}'""")
                    if self.command == "GET" and provider["hasKey"] and "verification" not in provider:
                        provider["verification"] = verified
                        result = json.dumps(provider).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = dispatch

    proxy = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    context.add_cleanup(proxy.server_close)
    context.add_cleanup(proxy.shutdown)
    return "http://127.0.0.1:" + str(proxy.server_port)


@given("a published chat bundle and a fixture executor")
def workspace(context):
    w = context.world
    w.h.env["ACCLIMATE_PROVIDER_ENCRYPTION_KEY"] = secrets.token_hex(32)
    w.h.restart()
    w.publish_initial("Answer the question.")
    w.prepare_browser_identity()
    w.learning = w.bundle + "/learning"
    w.console_service_base = trial_gateway(context)


@when("I connect two models and enroll the bundle through the console")
def configure_ui(context):
    w = context.world
    browser = w.browser()
    page = browser.page
    browser.visit("/access")
    page.get_by_label("OpenAI-compatible base URL").fill("https://fixture.invalid/v1")
    page.get_by_label("API key", exact=False).fill("fixture-key")
    page.get_by_label("Allowed models").fill(", ".join(MODELS))
    page.get_by_role("button", name="Save provider").click()
    expect(page.get_by_text("Provider saved.")).to_be_visible()
    expect(page.get_by_text("Provider verification: verified")).to_be_visible()
    w.learning_page = "/w/" + w.h.project + "/bundles/" + w.setup["bundle"]["id"] + "/learning"
    browser.visit(w.learning_page)
    expect(page.get_by_label("Task model")).to_have_value(MODELS[0])
    expect(page.get_by_label("Judge model")).to_have_value(MODELS[1])
    page.get_by_role("button", name="Save learning settings").click()
    expect(page.get_by_role("button", name="Start", exact=True)).to_be_disabled()


@when("I import a reference task and try it through the console")
def review(context):
    page = context.world.browser().page
    page.get_by_label("Spreadsheet, CSV or JSONL").set_input_files(dict(name="answers.csv", mimeType="text/csv", buffer=MATERIAL))
    page.get_by_role("button", name="Import tasks").click()
    expect(page.get_by_text("1 rows · 1 converted", exact=False)).to_be_visible()
    page.get_by_role("button", name="Try task").click()
    expect(page.get_by_text("Matches reference", exact=False)).to_be_visible()
    page.get_by_label("Spreadsheet, CSV or JSONL").set_input_files([])
    page.get_by_label("Paste conversations").fill("Question without a reference answer")
    page.get_by_role("button", name="Import tasks").click()
    expect(page.get_by_text("0 converted · 0 pending · 1 set aside", exact=False)).to_be_visible()
    expect(page.get_by_label("Set-aside rows")).to_contain_text("conversations.txt · Row 1: No usable reference answer")


def api(context, method, path, body=None, content_type="application/json"):
    w = context.world
    headers = {"Authorization": "Bearer " + w.console_token, "X-Acclimate-Session": w.sessions["_browser-operator"]["secret"],
               "Content-Type": content_type}
    data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
    with urlopen(Request(w.console_service_base + path, method=method, data=data, headers=headers)) as response:
        return json.load(response)


@when("I configure learning and import a reference task through the API")
def configure_api(context):
    w = context.world
    provider = api(context, "PUT", w.root + "/model-provider", dict(baseUrl="https://fixture.invalid/v1", apiKey="fixture-key", allowedModels=MODELS))
    assert provider["hasKey"] and "apiKey" not in provider
    loop = api(context, "PUT", w.learning, dict(channel="stable", taskModel=MODELS[0], judgeModel=MODELS[1],
               maxRoundsPerDay=4, setting=dict(domain="Support", benchmark="Service tasks")))
    assert loop["status"] == "paused"
    receipt = api(context, "POST", w.learning + "/tasks/import?filename=answers.csv", MATERIAL, "text/csv")
    assert receipt["converted"] == 1 and receipt["cards"][0]["sourceRow"] == 2


def sql(world, statement):
    world.h.pg("psql", world.h.env["DATABASE_URL"], "-v", "ON_ERROR_STOP=1", "-c", statement)


@when("the executor records admission results for both splits")
def admission(context):
    w = context.world
    project, bundle = w.h.project, w.setup["bundle"]["id"]
    for table in ("learning_tasks", "learning_held_out_tasks"):
        sql(w, f"""UPDATE {table} SET admission='set-aside', admission_reason='empty-passed'
                WHERE project_id='{project}' AND bundle_id='{bundle}';
            INSERT INTO {table}(project_id,bundle_id,task_id,"group",input,grader,source,confirmed_by,admission,added_revision)
                SELECT '{project}','{bundle}','{table}-'||i,i::text,to_jsonb('Input '||i),
                '{{"type":"exact","expected":"Answer"}}','import','fixture','admitted',1 FROM generate_series(1,20) i""")


@when("I start the admitted loop through the console")
def start_ui(context):
    w = context.world
    w.browser().visit(w.learning_page)
    page = w.browser().page
    expect(page.get_by_text("40 admitted · 1 set aside")).to_be_visible()
    page.get_by_role("button", name="Start", exact=True).click()
    expect(page.get_by_role("button", name="Pause", exact=True)).to_be_visible()


@when("I try the task and start the admitted loop through the API")
def start_api(context):
    w = context.world
    tasks = api(context, "GET", w.learning + "/tasks?admission=set-aside")["items"]
    assert tasks[0]["admissionReason"] == "empty-passed"
    trial = api(context, "POST", w.learning + "/tasks/" + tasks[0]["taskId"] + "/try")
    assert api(context, "GET", w.learning + "/trials/" + trial["trialId"])["verdict"]["passed"]
    assert api(context, "POST", w.learning + "/start")["status"] == "running"


@when("the executor records a release, usage and a production outcome")
def completed_round(context):
    w = context.world
    w.upload_version("Return the reference answer.")
    w.manual_release()
    project, bundle = w.h.project, w.setup["bundle"]["id"]
    w.round_id = str(uuid.uuid4())
    parent, adopted = w.original["version"]["id"], w.uploaded_version["id"]
    evaluation = str(uuid.uuid4())
    report = json.dumps({"cases": [{"caseId": "learning_tasks-1", "rollouts": [
        {"passed": i == 0, "score": int(i == 0), "trace": "Recorded judge reasoning"}
        for i in range(5)]}]})
    sql(w, f"""INSERT INTO learning_rounds(id,project_id,bundle_id,number,state,decision,parent_version_id,channel,
        channel_revision,evolve_revision,memory_revision,setting,adopted_sample,adopted_version_id,
        selection,incumbent_score,held_out_score,ended_at,reason) VALUES ('{w.round_id}','{project}','{bundle}',100,'completed',
        'kept','{parent}','stable',1,1,0,'{{}}',NULL,NULL,NULL,0.75,0.8,now(),'no-candidates');
        INSERT INTO learning_candidates(round_id,sample,status,rationale,changes,diagnosis,scan)
        VALUES('{w.round_id}',1,'generated','Answer precisely','{{"edits":[{{"path":"AGENTS.md","oldText":"Ask","newText":"Answer"}}],"files":[]}}',
        '{{"problem":{{"new":"Missing answer"}},"predicted":[]}}','{{"clean":true,"findings":[]}}');
        UPDATE learning_rounds SET decision='adopted',reason=NULL,adopted_sample=1,adopted_version_id='{adopted}',
        selection='{{"reason":"Better answers"}}' WHERE id='{w.round_id}';
        UPDATE learning_rounds SET task_revision=1 WHERE id='{w.round_id}';
        INSERT INTO learning_evaluations(id,round_id,role,sample,split,version_id,digest,evolve_revision,status,
            report,score,started_at) VALUES ('{evaluation}','{w.round_id}','candidate',1,'evolve',
            '{adopted}','{w.uploaded_version["digest"]}',1,'scored','{report}',0.2,now());
        INSERT INTO learning_rollouts(evaluation_id,task_id,rollout,input,grader,status,score,passed)
        SELECT '{evaluation}','learning_tasks-1',i,'"Input 1"','{{"type":"exact","expected":"Answer"}}',
            'scored',(i=1)::int,i=1 FROM generate_series(1,5) i;
        UPDATE learning_candidates SET evaluation_id='{evaluation}',version_id='{adopted}',status='evaluated',
            screen='{{"verdict":"evaluate","reason":"Fixture"}}',evolve_score=0.2 WHERE round_id='{w.round_id}';
        INSERT INTO learning_usage(project_id,bundle_id,day,rounds,rollouts,task_tokens)
        VALUES ('{project}','{bundle}',current_date,1,5,120) ON CONFLICT(project_id,bundle_id,day)
        DO UPDATE SET rounds=1,rollouts=5,task_tokens=120;
        UPDATE learning_loops SET alert='{{"roundId":"{w.round_id}","score":0.8,"previousScore":0.85,"flippedTasks":1}}'
        WHERE bundle_id='{bundle}';
        INSERT INTO learning_tasks(project_id,bundle_id,task_id,"group",input,grader,source,added_revision)
        VALUES('{project}','{bundle}','production-example','production','"New question"','{{"type":"exact","expected":"Answer"}}','outcome',1)""")


@then("I can inspect the release and roll it back through the console")
def monitor_ui(context):
    w = context.world
    browser = w.browser()
    browser.visit(w.learning_page)
    page = browser.page
    expect(page.get_by_text("Held-out score dropped", exact=False)).to_be_visible()
    page.get_by_label("Task source").select_option("outcome")
    expect(page.get_by_text("Production outcome", exact=False)).to_be_visible()
    page.get_by_label("Task source").select_option("")
    expect(page.get_by_text("5 rollouts · 120 tokens", exact=False)).to_be_visible()
    page.get_by_label("Flagged only").check()
    expect(page.get_by_text("Flagged · split-rollouts")).to_be_visible()
    page.get_by_role("button", name="Show last rollout").click()
    page.get_by_text("learning_tasks-1 · 1 of 5 passed").click()
    expect(page.get_by_text("Recorded judge reasoning").first).to_be_visible()
    page.get_by_text("Edit task", exact=True).click()
    page.get_by_label("Expected answer JSON").fill('"Revised reference"')
    page.get_by_role("button", name="Save task").click()
    expect(page.get_by_text("No flagged tasks.")).to_be_visible()
    page.get_by_role("link", name="Inspect round").click()
    expect(page.get_by_text("New root cause · Missing answer")).to_be_visible()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="Roll back", exact=True).click()
    expect(page.get_by_text("Previous version restored.")).to_be_visible()
    assert w.call("GET", w.channel)["version"]["id"] == w.original["version"]["id"]


@then("the API exposes the tasks, round and usage and rolls back the release")
def monitor_api(context):
    w = context.world
    assert api(context, "GET", w.learning + "/tasks?source=outcome")["items"][0]["source"] == "outcome"
    assert api(context, "GET", w.learning + "/rounds/" + w.round_id)["decision"] == "adopted"
    flagged = api(context, "GET", w.learning + "/tasks?flagged=true")["items"][0]
    assert flagged["flagReason"] == "split-rollouts"
    api(context, "PATCH", w.learning + "/tasks/" + flagged["taskId"], {"input": "Revised input"})
    assert api(context, "GET", w.learning + "/usage")["items"][0]["taskTokens"] == 120
    api(context, "POST", w.learning + "/rollback", dict(roundId=w.round_id))
    assert w.call("GET", w.channel)["version"]["id"] == w.original["version"]["id"]
