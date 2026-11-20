from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest
from unittest.mock import patch

from acclimate._learning_runner import _run
from acclimate.learning import OpenAIHttpError, define_loop, exact, openai


EXPECTED_PROMPT = (
    "# instructions/main.md\nReturn JSON.\nUse the schema.\n\n"
    "# skills/lookup/SKILL.md\nLook up values.\n\n# skills/lookup/schema.json\n{}\n\n\n"
    "# memory/café.md\nRemember the résumé."
)
FIXTURE = Path(__file__).resolve().parents[2] / "packages/sdk/tests/fixtures/openai-bundle.json"
VERSION = {
    "version": {"id": "v", "bundleId": "b", "parentVersionId": None, "digest": "fixture", "createdAt": "now"},
    "resolvedAt": 0,
    "stale": False,
    "payload": json.loads(FIXTURE.read_text(encoding="utf-8")),
}
COMPLETION = {
    "choices": [{"message": {"content": '{"action":"refund"}'}, "finish_reason": "stop"}],
    "usage": {"total_tokens": 12},
}


@contextmanager
def endpoint(*replies):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            status, body, retry_after = replies[min(len(requests), len(replies) - 1)]
            requests.append((self.path, self.headers.get("Authorization"), json.loads(
                self.rfile.read(int(self.headers["Content-Length"])),
            )))
            self.send_response(status)
            if retry_after is not None:
                self.send_header("Retry-After", retry_after)
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, format, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/v1/", requests
        finally:
            server.shutdown()
            thread.join()


class OpenAIAgentTests(unittest.TestCase):
    def test_shared_render_vector_and_parsing(self):
        with endpoint((200, COMPLETION, None)) as (url, requests):
            agent = openai("fixture", base_url=url, api_key="", parse=json.loads)
            for _ in range(2):
                self.assertEqual(agent(VERSION, {"task": "refund"}, 0), (
                    {"action": "refund"},
                    '{"text":"{\\"action\\":\\"refund\\"}","finish_reason":"stop","usage":{"total_tokens":12}}',
                ))
            self.assertEqual(requests, [("/v1/chat/completions", None, {
                "model": "fixture",
                "messages": [
                    {"role": "system", "content": EXPECTED_PROMPT},
                    {"role": "user", "content": '{"task":"refund"}'},
                ],
            })] * 2)
        loop = define_loop(bundle="b", channel="stable", cases="cases.jsonl", grade=exact("action"), agent=agent)
        self.assertEqual(loop.setting["policyModel"], "fixture")

    def test_settings_and_retries(self):
        with endpoint((429, {}, "0"), (503, {}, "Thu, 01 Jan 1970 00:00:00 GMT"),
                      (200, COMPLETION, None)) as (url, requests):
            with patch.dict("os.environ", {"OPENAI_BASE_URL": url, "OPENAI_API_KEY": "fake-key"}):
                agent = openai("fixture", effort="high", render=lambda v: v["version"]["id"])
            self.assertEqual(agent(VERSION, "hello", 0)[0], '{"action":"refund"}')
            self.assertEqual(requests, [("/v1/chat/completions", "Bearer fake-key", {
                "model": "fixture",
                "reasoning_effort": "high",
                "messages": [{"role": "system", "content": "v"}, {"role": "user", "content": "hello"}],
            })] * 3)

    def test_typed_redacted_failure_and_runner_trace(self):
        with endpoint((503, {"error": "Invalid fake-key"}, "0")) as (url, requests):
            agent = openai("fixture", base_url=url, api_key="fake-key")
            with self.assertRaises(OpenAIHttpError) as caught:
                agent(VERSION, "hello", 0)
            self.assertEqual(caught.exception.status, 503)
            self.assertNotIn("fake-key", str(caught.exception))
            self.assertEqual(caught.exception.trace, '{"error":{"error":"Invalid [redacted]"}}')
            self.assertEqual(len(requests), 3)
            case = {"caseId": "case", "input": "hello", "expected": None}
            self.assertEqual(_run(agent, exact(), VERSION, case, 0, False, "acclimate-token")["trace"],
                             caught.exception.trace)
            self.assertEqual(_run(agent, exact(), VERSION, case, 0, True, "acclimate-token"),
                             {"score": 0, "passed": False})

    def test_retry_after_above_budget_stops_immediately(self):
        with endpoint((429, {}, "60")) as (url, requests):
            with self.assertRaises(OpenAIHttpError) as caught:
                openai("fixture", base_url=url, api_key="")(VERSION, "hello", 0)
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(len(requests), 1)
