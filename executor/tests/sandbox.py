"""Run with python3 executor/tests/sandbox.py from the repository root."""

import json
import os
import shutil
import subprocess
import threading
import time
import unittest
import uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


@unittest.skipUnless(
    shutil.which("docker")
    and subprocess.run(["docker", "info"], capture_output=True).returncode == 0,
    "Docker daemon unavailable",
)
class SandboxGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = docker("build", "-q", "executor/runner")
        cls.executor = docker("build", "-q", "-f", "executor/Dockerfile", ".")

    def exercise(self, runtime, case):
        expected = uuid.uuid4().hex
        lease = str(uuid.uuid4())
        name = "executor-test-" + lease
        volume = docker("volume", "create")
        offered = threading.Event()
        done = threading.Event()
        errors = []
        results = []
        beats = []
        expired_container = []
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    code, reply = self.dispatch(body)
                except Exception as error:
                    errors.append(error)
                    done.set()
                    code, reply = 500, {}
                self.send_response(code)
                self.end_headers()
                if code != 204:
                    try:
                        self.wfile.write(json.dumps(reply).encode())
                    except BrokenPipeError:
                        pass

            def dispatch(self, body):
                action = self.path.split("/")[-1]
                token = self.headers["Authorization"]
                if action == "leases":
                    test.assertEqual(token, "Bearer executor-token")
                    test.assertEqual(body["executor"]["runnerImage"], test.runner)
                    if offered.is_set():
                        if case == "expired" and expired_container:
                            test.assertFalse(
                                docker(
                                    "ps",
                                    "-aq",
                                    "--filter",
                                    "id=" + expired_container[0],
                                )
                            )
                            done.set()
                        return 204, {}
                    offered.set()
                    return 200, dict(
                        leaseId=lease,
                        leaseToken="lease-token",
                        heartbeatSeconds=1,
                        kind="rollout",
                        harness="chat",
                        bundle={"files": []},
                        input="test",
                        taskModel="task",
                        limits=dict(
                            maxTokens=2 if case == "cap" else 20,
                            timeoutSeconds=5 if case == "timeout" else 90,
                        ),
                        provider=dict(baseUrl=url, apiKey="provider-key"),
                    )
                if action == "completions":
                    test.assertEqual(token, "Bearer provider-key")
                    test.assertEqual(body["model"], "task")
                    test.assertIs(body["store"], False)
                    test.assertEqual(
                        body["messages"],
                        [
                            {"role": "system", "content": ""},
                            {"role": "user", "content": "test"},
                        ],
                    )
                    if case == "scored":
                        (container,) = docker(
                            "ps",
                            "-q",
                            "--filter",
                            "ancestor=" + test.runner,
                            "--filter",
                            "volume=" + volume,
                        ).splitlines()
                        test.assertEqual(
                            docker(
                                "inspect",
                                "-f",
                                "{{.HostConfig.NetworkMode}}",
                                container,
                            ),
                            "none",
                        )
                        docker(
                            "exec",
                            container,
                            "node",
                            "-e",
                            "fetch('http://192.0.2.1',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>{})",
                        )
                        # Pass the marker over stdin so the inspection adds no file or environment value.
                        probe = Path(__file__).with_name("inspect.mjs").read_text()
                        subprocess.run(
                            [
                                "docker",
                                "exec",
                                "-i",
                                container,
                                "node",
                                "--input-type=module",
                                "-e",
                                probe,
                            ],
                            input=expected,
                            text=True,
                            check=True,
                        )
                        time.sleep(1.1)
                    if case == "expired":
                        (container,) = docker(
                            "ps",
                            "-q",
                            "--filter",
                            "volume=" + volume,
                            "--filter",
                            "ancestor=" + test.runner,
                        ).splitlines()
                        expired_container.append(container)
                        done.wait(30)
                    if case == "timeout":
                        time.sleep(10)
                    if case == "upstream":
                        return 502, {"message": "provider-key"}
                    return 200, {
                        "choices": [{"message": {"content": expected}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                    }
                test.assertEqual(token, "Bearer lease-token")
                if action == "heartbeat":
                    beats.append(1)
                    if case == "expired" and expired_container:
                        return 409, {}
                    return 200, {}
                if action == "output":
                    test.assertEqual(
                        body["stop"],
                        {"cap": "token-limit", "timeout": "time-limit"}.get(
                            case, "completed"
                        ),
                    )
                    test.assertEqual(len(body["gatewayLog"]), 1)
                    test.assertNotIn("provider-key", json.dumps(body))
                    return 200, {"grader": {"type": "exact", "expected": expected}}
                test.assertEqual(action, "result")
                results.append(body)
                done.set()
                return 200, {}

        server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        url = f"http://host.docker.internal:{server.server_port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            docker(
                "run",
                "-d",
                "--rm",
                "--name",
                name,
                "--add-host",
                "host.docker.internal:host-gateway",
                "-v",
                "/var/run/docker.sock:/var/run/docker.sock",
                "-v",
                volume + ":/var/lib/acclimate-executor",
                "-e",
                "ACCLIMATE_SANDBOX_VOLUME=" + volume,
                "-e",
                "ACCLIMATE_EXECUTOR_SERVICE=" + url,
                "-e",
                "ACCLIMATE_SANDBOX_RUNTIME=" + runtime,
                "-e",
                "ACCLIMATE_RUNNER_IMAGE=" + self.runner,
                "-e",
                "ACCLIMATE_EXECUTOR_TOKEN=executor-token",
                self.executor,
            )
            self.assertTrue(done.wait(100), "Timed out waiting for result")
            if errors:
                raise errors[0]
            if case == "expired":
                self.assertFalse(results)
                return
            (result,) = results
            if case in ("runtime", "upstream"):
                self.assertEqual(
                    result["error"]["code"],
                    "sandbox-start" if case == "runtime" else "gateway-upstream",
                )
                self.assertNotIn("verdict", result)
            else:
                self.assertEqual(result["verdict"]["passed"], case == "scored")
                count = 0 if case == "timeout" else 1
                self.assertEqual(
                    result["tokens"]["task"], {"input": count, "output": count}
                )
                if case == "scored":
                    self.assertTrue(beats)
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            server.shutdown()
            server.server_close()
            docker("volume", "rm", volume)

    def test_rollouts(self):
        runtime = os.environ.get("ACCLIMATE_SANDBOX_RUNTIME", "docker")
        for case in ("scored", "cap", "timeout", "upstream", "expired"):
            with self.subTest(case=case):
                self.exercise(runtime, case)
        if "runsc" not in json.loads(docker("info", "--format", "{{json .Runtimes}}")):
            self.exercise("runsc", "runtime")


if __name__ == "__main__":
    unittest.main()
