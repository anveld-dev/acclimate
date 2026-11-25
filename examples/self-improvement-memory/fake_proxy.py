"""Loopback OpenAI-compatible server for model-free driver runs."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Lock, Thread

API_KEY = "sim-fixture-key"


def optimizer_output(system, data):
    if system.startswith("Each candidate is a proposed change"):
        return {"samples": [{"sample": entry["sample"], "verdict": "evaluate",
                             "reason": "Evaluate the fixture change."} for entry in data["candidates"]]}
    if system.startswith("Each candidate was evaluated"):
        return {"decision": "adopt", "sample": 1, "reason": "Adopt the fixture change."}
    assert system.startswith("You improve a harness:")
    original = data["harness"]["files"][0]["text"]
    problems = data["improvementMemory"]["problems"]
    return {
        "schemaVersion": 2,
        "rationale": "Clarify command routing.",
        "edits": [{"path": "AGENTS.md", "oldText": original,
                   "newText": original + "\nCheck command routing."}],
        "files": [],
        "diagnosis": {
            "problem": {"id": problems[0]["id"]} if problems else {"new": "Command routing is underspecified."},
            "predicted": [data["feedback"]["cases"][0]["caseId"]],
        },
    }


@contextmanager
def fake_proxy(directory, port):
    write_lock = Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + API_KEY:
                self.send_error(401)
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            model = body["model"]
            system, user = body["messages"]
            assert (system["role"], user["role"]) == ("system", "user")
            if model == "gpt-6.2-astra":
                assert body["response_format"] == {"type": "json_object"}
                assert body["max_completion_tokens"] == 32768
                assert body["reasoning_effort"] == "high"
                data = json.loads(user["content"].removeprefix("<untrusted-data>\n").removesuffix("\n</untrusted-data>"))
                output = optimizer_output(system["content"], data)
            else:
                assert model in ("gpt-6-luna", "gpt-6.2-sol") and body["reasoning_effort"] == "low"
                assert set(body) == {"model", "reasoning_effort", "messages"}
                assert system["content"].startswith("# AGENTS.md\n")
                assert user["content"] in ("Locate the user templates directory.", "Show the path to the log database.")
                command = "logs" if user["content"].startswith("Show") and "Check command routing." in system["content"] else "templates"
                output = {"argv": ["llm", command, "path"]}
            endpoint = f"http://{self.headers['Host']}{self.path}"
            with write_lock, (directory / "proxy-requests.jsonl").open("a") as log:
                log.write(json.dumps({"endpoint": endpoint, "model": model,
                                      "reasoningEffort": body["reasoning_effort"]}) + "\n")
            reply = json.dumps({
                "model": model,
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    class Server(ThreadingHTTPServer):
        request_queue_size = 64

    with Server(("127.0.0.1", port), Handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            yield {
                "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                "revision": "fixture",
                "configSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            }
        finally:
            server.shutdown()
            thread.join()
