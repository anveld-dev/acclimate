"""Phase 1 exit gate. Run from the repository root with Python 3."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import unittest
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from sandbox import docker, requires_docker

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/productization"))
from qualify import Harness, port


@requires_docker
class CentralLearning(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bin_dir = Path(
            os.environ.get("PG_BIN") or Path(shutil.which("initdb") or "").parent
        )
        if not all(
            (bin_dir / name).is_file()
            for name in ("initdb", "pg_ctl", "psql", "pg_dump")
        ):
            raise unittest.SkipTest("PostgreSQL server tools unavailable (set PG_BIN)")
        cls.h = Harness(bin_dir)
        cls.addClassCleanup(cls.h.close)
        try:
            cls.h.start_database()
        except subprocess.CalledProcessError as error:
            raise unittest.SkipTest(
                "Private PostgreSQL cluster unavailable: " + error.stderr
            ) from error
        subprocess.run(["cargo", "build", "--bin", "acclimate-service"], check=True)
        cls.runner = docker("build", "-q", "executor/runner")
        cls.image = docker(
            "build",
            "-q",
            "-f",
            "executor/Dockerfile",
            "--build-arg",
            "ACCLIMATE_EXECUTOR_BUILD=combined-test",
            ".",
        )
        cls.database = cls.h.env["DATABASE_URL"]

    def exercise(self, failure):
        h = self.h
        answer, key = secrets.token_hex(24), secrets.token_hex(24)
        calls = {}
        judge_calls = Counter()
        criterion_marker = secrets.token_hex(20)
        release = threading.Event()
        arrived = threading.Event()
        problems = []

        def current():
            return h.sql(
                "SELECT id FROM learning_rollouts WHERE status='running' ORDER BY lease_expires_at DESC LIMIT 1"
            )

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(handler):
                try:
                    self.assertEqual(handler.path, "/v1/chat/completions")
                    self.assertTrue(handler.headers["Authorization"] == "Bearer " + key)
                    body = json.loads(
                        handler.rfile.read(int(handler.headers["Content-Length"]))
                    )
                    if body["model"] == "judge":
                        self.assertFalse(body["store"])
                        data = json.loads(body["messages"][1]["content"])
                        if "criteria" in data:
                            criterion = data["criteria"][0]
                            if data["gatewayLog"]:
                                self.assertEqual(data["gatewayLog"][0]["model"], "task")
                            counter = (criterion, data["output"])
                            index = judge_calls[counter] % 3
                            judge_calls[counter] += 1
                            passed = bool(data["output"])
                            if criterion == "reference-failed":
                                passed = False
                            elif criterion == "empty-passed":
                                passed = True
                            elif criterion == criterion_marker:
                                passed = (data["output"] == answer) != (index == 1)
                            elif criterion in ("judge-unstable", "no-reference-split") and index == 1:
                                passed = not passed
                            mapped = {"criteria": [{"passed": passed, "reason": f"vote {index}"}]}
                        else:
                            mapped = {"inputPath": "/question", "referencePath": "/answer"} if data["row"] == 1 else {}
                        reply = {"choices": [{"message": {"content": json.dumps(mapped)}}],
                                 "usage": {"prompt_tokens": 5, "completion_tokens": 2}}
                        handler.send_response(200)
                        handler.end_headers()
                        handler.wfile.write(json.dumps(reply).encode())
                        return
                    self.assertIn(
                        "Review the supplied diff", body["messages"][0]["content"]
                    )
                    task = body["messages"][1]["content"]
                    row = current()
                    entries = calls.setdefault(row, [])
                    number = list(calls).index(row)
                    reply = {
                        "choices": [
                            {"message": {"content": answer if task == "a" else "wrong"}}
                        ],
                        "usage": {"prompt_tokens": 8, "completion_tokens": 1},
                    }
                    status = 200
                    if (failure and number == 0) or (
                        not failure and number == 1 and not entries
                    ):
                        status, reply = 502, {"error": "fixture"}
                    if failure and number == 1:
                        del reply["usage"]
                    entries.append((body, status, reply))
                    if not failure and number == 0 and len(entries) == 1:
                        arrived.set()
                        release.wait(90)
                    handler.send_response(status)
                    handler.end_headers()
                    try:
                        handler.wfile.write(json.dumps(reply).encode())
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                except Exception as error:
                    problems.append(error)
                    arrived.set()

        server = ThreadingHTTPServer(("0.0.0.0", 0), Upstream)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(release.set)
        url = f"http://host.docker.internal:{server.server_port}/v1"
        runtime = os.environ.get("ACCLIMATE_SANDBOX_RUNTIME", "docker")
        identity = dict(
            build="combined-test",
            harnesses={"chat": "1"},
            sandboxRuntime=runtime,
            runnerImage=self.runner,
        )
        fixture_file = h.dir / "fixture.json"

        def fixture(**extra):
            env = dict(
                os.environ,
                ACCLIMATE_TEST_DATABASE_URL=h.env["DATABASE_URL"],
                ACCLIMATE_GATE_FIXTURE=str(fixture_file),
                ACCLIMATE_GATE_ANSWER=answer,
                ACCLIMATE_GATE_RUNTIME=json.dumps(
                    dict(executor=identity, taskModel="task", judgeModel="judge", baseUrl=url)
                ),
            )
            subprocess.run(
                [
                    "cargo",
                    "test",
                    "--test",
                    "learning_loop",
                    "executor_tests::combined_gate_fixture",
                    "--",
                    "--ignored",
                    "--exact",
                ],
                env=dict(env, **extra),
                check=True,
            )
            return json.loads(fixture_file.read_text())

        h.env["DATABASE_URL"] = self.database
        data = fixture()
        h.env["DATABASE_URL"] += "?options=-csearch_path%3D" + data["schema"]
        internal = port()
        h.env.update(
            ACCLIMATE_INTERNAL_BIND=f"0.0.0.0:{internal}",
            ACCLIMATE_PROVIDER_ENCRYPTION_KEY=secrets.token_hex(32),
        )
        h.restart()
        self.addCleanup(h.stop_service)
        service = ROOT / "target/debug/acclimate-service"
        subprocess.run(
            [service, "--set-model-provider", data["workspace"]],
            env=h.env,
            input=json.dumps(dict(baseUrl=url, apiKey=key, allowedModels=["task", "judge"])),
            text=True,
            check=True,
        )
        token = json.loads(
            subprocess.check_output([service, "--create-executor-token"], env=h.env)
        )["token"]
        volume = docker("volume", "create")
        self.addCleanup(docker, "volume", "rm", volume)
        workers = []

        def containers():
            return docker(
                "ps",
                "-q",
                "--filter",
                "ancestor=" + self.runner,
                "--filter",
                "volume=" + volume,
            ).splitlines()

        def cleanup():
            for container in workers + containers():
                subprocess.run(["docker", "rm", "-f", container], capture_output=True)

        self.addCleanup(cleanup)

        def start():
            workers.append(
                docker(
                    "run",
                    "-d",
                    "--add-host",
                    "host.docker.internal:host-gateway",
                    "-v",
                    "/var/run/docker.sock:/var/run/docker.sock",
                    "-v",
                    volume + ":/var/lib/acclimate-executor",
                    "-e",
                    "ACCLIMATE_SANDBOX_VOLUME=" + volume,
                    "-e",
                    f"ACCLIMATE_EXECUTOR_SERVICE=http://host.docker.internal:{internal}",
                    "-e",
                    "ACCLIMATE_EXECUTOR_TOKEN=" + token,
                    "-e",
                    "ACCLIMATE_SANDBOX_RUNTIME=" + runtime,
                    "-e",
                    "ACCLIMATE_RUNNER_IMAGE=" + self.runner,
                    self.image,
                )
            )

        if not failure:
            h.sql(f"""UPDATE learning_rollouts SET grader=jsonb_build_object(
                'type','criteria','criteria',jsonb_build_array('{criterion_marker}'::text),
                'reference',grader->'expected')""")
        start()
        if not failure:
            self.assertTrue(arrived.wait(60), "Executor never reached upstream")
            if problems:
                raise problems[0]
            (sandbox,) = containers()
            self.assertEqual(
                docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", sandbox), "none"
            )
            docker(
                "exec",
                sandbox,
                "node",
                "-e",
                "fetch('http://192.0.2.1',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>{})",
            )
            probe = Path(__file__).with_name("inspect.mjs").read_text()
            subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    sandbox,
                    "node",
                    "--input-type=module",
                    "-e",
                    probe,
                ],
                input=json.dumps([key, answer, criterion_marker]),
                text=True,
                check=True,
            )
            docker("kill", "--signal=KILL", workers[0])
            release.set()
            crashed = current()
            self.assertEqual(crashed, next(iter(calls)))
            for _ in range(55):
                if (
                    h.sql(
                        f"SELECT lease_expires_at <= now() FROM learning_rollouts WHERE id='{crashed}'"
                    )
                    == "t"
                ):
                    break
                time.sleep(1)
            else:
                self.fail("Killed worker's lease never expired")
            start()

        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if problems:
                raise problems[0]
            if (
                h.sql(
                    "SELECT count(*) FROM learning_rollouts WHERE status IN ('failed','scored')"
                )
                == "10"
            ):
                break
            time.sleep(0.5)
        rows = json.loads(h.sql("SELECT json_agg(l) FROM learning_rollouts l"))
        self.assertEqual(len(calls), 10, Counter(r["status"] for r in rows))
        for row in rows:
            entries = calls[row["id"]]
            index = list(calls).index(row["id"])
            self.assertEqual(row["attempts"], 2 if index < 2 else 1)
            self.assertEqual(len(entries), row["attempts"])
            if failure and index < 2:
                self.assertEqual(
                    (row["status"], row["error_code"], row["score"]),
                    ("failed", "gateway-upstream", None),
                )
                continue
            self.assertEqual(
                (row["status"], row["score"]), ("scored", int(row["task_id"] == "a"))
            )
            body, status, reply = entries[-1]
            (log,) = row["gateway_log"]
            self.assertEqual(
                (log["request"], log["status"], log["response"], log["usage"]),
                (body, status, reply, reply["usage"]),
            )
        result = fixture(ACCLIMATE_GATE_EVALUATION=data["evaluation"])
        self.assertEqual(
            result,
            {"status": "failed"}
            if failure
            else dict(
                status="scored",
                score=0.5,
                tasks=[
                    dict(taskId="a", score=1, passed=True),
                    dict(taskId="b", score=0, passed=False),
                ],
            ),
        )
        if not failure:
            for row in rows:
                self.assertEqual(len(row["judge_log"]), 3)
                self.assertEqual(row["tokens"]["judge"], {"input": 15, "output": 6})
                self.assertEqual(row["votes"], [row["passed"], not row["passed"], row["passed"]])
            ids = fixture(ACCLIMATE_GATE_TRIALS=json.dumps(data))
            deadline = time.monotonic() + 120
            while h.sql("SELECT count(*) FROM learning_rollouts WHERE trial_id IS NOT NULL AND status NOT IN ('scored','converted')") != "0":
                if problems:
                    raise problems[0]
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.5)
            *checks, converted = fixture(ACCLIMATE_GATE_TRIALS=json.dumps(dict(data, ids=ids)))
            self.assertEqual([(c["status"], c["reason"]) for c in checks], [
                ("admitted", None), ("set-aside", "reference-failed"), ("set-aside", "empty-passed"),
                ("set-aside", "judge-unstable"), ("admitted", None), ("set-aside", "judge-unstable")])
            self.assertEqual(converted["cards"], [dict(row=1, group="sheet#1", input="Question",
                             grader=dict(type="exact", expected="Answer"), criteriaDrafted=False)])
            self.assertEqual(converted["setAside"], [dict(row=2, reason="no-reference")])
            self.assertEqual(fixture(ACCLIMATE_GATE_EVALUATION=data["evaluation"]), result)
        self.assertEqual(containers(), [])
        dump = h.pg("pg_dump", "--data-only", h.env["DATABASE_URL"]).stdout
        self.assertFalse(key in dump or key.encode().hex() in dump)
        self.assertFalse(key in (h.dir / "service.log").read_text())
        for worker in workers:
            logs = subprocess.check_output(
                ["docker", "logs", worker], stderr=subprocess.STDOUT
            )
            self.assertFalse(key.encode() in logs)

    def test_crash_and_retry(self):
        self.exercise(False)

    def test_persistent_errors(self):
        self.exercise(True)


if __name__ == "__main__":
    unittest.main(defaultTest="CentralLearning")
