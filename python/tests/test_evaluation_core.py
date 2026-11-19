import copy
from concurrent.futures import Future
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import shutil
import unittest
from unittest.mock import patch
import uuid

from acclimate.evaluation import (
    Case, ExecutionResult, GradeResult, CallbackCancelled, EvaluationError,
    ExecutionUncertainError, define_evaluation, preflight_evaluation, run_evaluation,
)
from acclimate._evaluation_shared import json_bytes, mutate, read_evaluator_config, ensure_private_directory
from acclimate._evaluation_journal import Journal, serialize_scope
from acclimate.client import AcclimateClient, ApiError, TransportError


PARENT="11111111-1111-4111-8111-111111111111"
CANDIDATE="22222222-2222-4222-8222-222222222222"
BUNDLE="33333333-3333-4333-8333-333333333333"
REQUEST="44444444-4444-4444-8444-444444444444"
COMPARISON="55555555-5555-4555-8555-555555555555"


class FakeService:
    base_url="https://fixture.example"
    scope="evaluator"
    _base=AcclimateClient._base
    _part=staticmethod(AcclimateClient._part)
    _listing=AcclimateClient._listing

    def __init__(self,app):
        self.payloads={}
        self.versions={}
        for version,parent,text in ((PARENT,None,"parent"),(CANDIDATE,PARENT,"candidate")):
            data=json_bytes({"schemaVersion":1,"files":[{"path":"instruction.md","kind":"instruction","text":text}]})+b"\n"
            digest="sha256:"+hashlib.sha256(data).hexdigest()
            self.payloads[version]=data
            self.versions[version]={"id":version,"bundleId":BUNDLE,"parentVersionId":parent,"digest":digest,"createdAt":"2026-11-16T00:00:00Z"}
        self.request={**app.descriptor,"id":REQUEST,"parentVersionId":PARENT,"candidateVersionId":CANDIDATE,
            "parentDigest":self.versions[PARENT]["digest"],"candidateDigest":self.versions[CANDIDATE]["digest"],
            "requireBoundEvidence":True,"status":"requested","attemptId":None,"evaluatorPrincipal":None,
            "comparisonId":None,"error":None,"createdAt":"2026-11-16T00:00:00Z","updatedAt":"2026-11-16T00:00:00Z"}
        self.comparison=None
        self.receipts={}
        self.mutations=[]
        self.lose_once=None
        self.write_access=True
        self.interrupt_after_start=False

    def get_evaluation_capabilities(self,_):
        return {"schemaVersion":1,"projectId":"project","principalId":"evaluator","checkedAt":"2026-11-16T00:00:00Z",
            "readUnpublished":True,"writeEvaluation":self.write_access,"retainedEvaluationOperations":True}

    def get_evaluation(self,*_):
        return copy.deepcopy(self.request)

    def get_version(self,_project,_bundle,version):
        return copy.deepcopy(self.versions[version])

    def get_payload(self,_project,_bundle,version):
        return self.payloads[version]

    def get_comparison(self,*_):
        return copy.deepcopy(self.comparison)

    def _request(self,method,path,body=None,key=None,**kwargs):
        if method=="GET" and path.startswith("/v1/workspaces/project/bundles?"):
            return {"items":[{"id":BUNDLE}],"nextCursor":None}
        assert method=="POST" and kwargs["_retained"] is True
        data=kwargs["_body_bytes"]
        receipt=(path,key)
        self.mutations.append((path,key,data))
        if receipt in self.receipts:
            old_data,value=self.receipts[receipt]
            assert old_data==data
            return copy.deepcopy(value)
        value=json.loads(data)
        operation=path.rsplit("/",1)[-1]
        if operation=="start":
            self.request.update(status="running",attemptId=value["attemptId"],evaluatorPrincipal="evaluator")
            result=copy.deepcopy(self.request)
            if self.interrupt_after_start:
                self.request.update(status="interrupted",error="operator interruption")
            if getattr(self,"abandon_after_start",False):
                self.request.update(status="abandoned",error="CI job cancelled",abandonedBy="machine:ci")
        elif operation=="comparisons":
            complete=all(outcome["gradingStatus"]=="scored" and outcome["executionStatus"]!="infrastructure_failed"
                for row in value["results"] for outcome in (row["parent"],row["candidate"]))
            self.comparison={**value,"id":COMPARISON,"complete":complete,"submitter":"evaluator","createdAt":"2026-11-16T00:00:00Z"}
            result=copy.deepcopy(self.comparison)
        elif operation=="finish":
            self.request.update(status="completed" if self.comparison["complete"] else "failed",comparisonId=value["comparisonId"])
            result=copy.deepcopy(self.request)
        else:
            raise AssertionError(operation)
        self.receipts[receipt]=(data,copy.deepcopy(result))
        if self.lose_once==operation:
            self.lose_once=None
            raise TransportError("secret transport URL/token must never escape")
        return result


class EvaluationCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()
        self.config=self.root/"config.json"
        self.journal_root=self.root/"journals"
        self.config.write_bytes(json_bytes({"schemaVersion":1,"serviceUrl":"https://fixture.example","projectId":"project",
            "evaluatorPrincipalId":"evaluator","evaluatorToken":"private-canary-token","journalRoot":str(self.journal_root)}))
        self.config.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def app(self,execute=None,grade=None,cases=None):
        return define_evaluation(config_id="fixture",config_revision="1",dataset_revision="tasks-1",grader_revision="grade-1",
            runtime={"app":"fixture"},execution="model-free",cases=cases or [Case("one",{"task":"do"},True)],
            execute=execute or (lambda run:ExecutionResult({"ok":True})),grade=grade or (lambda run:GradeResult(float(run.output["ok"]))))

    def handoff(self,app):
        return {"schemaVersion":1,"serviceUrl":"https://fixture.example","projectId":"project","bundleId":BUNDLE,
            "requestId":REQUEST,"configuration":app.descriptor}

    def run_app(self,app,service,**kwargs):
        with patch("acclimate.evaluation.make_client",return_value=service):
            return run_evaluation(app=app,config_path=str(self.config),handoff=self.handoff(app),**kwargs)

    def test_actual_pair_trace_and_all_mutable_input_isolation(self):
        events=[]
        def execute(run):
            text=run.bundle["payload"]["files"][0]["text"]
            events.append(("execute",run.repetition,text,run.input["task"]))
            self.assertTrue(Path(run.context.private_job_directory,"binding.json").exists())
            self.assertFalse(hasattr(run,"expected"))
            run.bundle["payload"]["files"].clear()
            run.bundle["version"]["id"]="mutated"
            run.input["task"]="mutated"
            return ExecutionResult({"ok":True})
        def grade(run):
            events.append(("grade",run.repetition,run.expected))
            run.output["ok"]=False
            return GradeResult(1,explanation={"reason":"fixture"})
        cases=[Case("one",{"task":"original"},True,2)]
        app=self.app(execute,grade,cases)
        descriptor=app.descriptor
        descriptor["runtime"]["app"]="mutation"
        service=FakeService(app)
        result=self.run_app(app,service)
        self.assertEqual(result["evaluation"]["status"],"completed")
        self.assertEqual(events,[("execute",0,"parent","original"),("grade",0,True),
            ("execute",0,"candidate","original"),("grade",0,True),
            ("execute",1,"parent","original"),("grade",1,True),
            ("execute",1,"candidate","original"),("grade",1,True)])
        self.assertEqual(app.descriptor["runtime"]["app"],"fixture")
        attempt=next(self.journal_root.glob("*/attempt.python.json"))
        state=json.loads(attempt.read_bytes())
        index=json.loads((attempt.parent/"artifact-index.json").read_bytes())
        self.assertEqual(index["comparisonId"],COMPARISON)
        self.assertEqual(len(index["entries"]),8)
        self.assertEqual(service.comparison["results"][0]["parent"]["outputRef"],
                         "acclimate:artifact:" + index["entries"][0]["sha256"])
        self.assertNotIn("private-canary-token",attempt.read_text())
        self.assertEqual(state["report"]["parentVersionId"],PARENT)

    def test_non_json_output_writes_a_private_field_and_fix(self):
        from datetime import datetime, timezone
        app = self.app(lambda run: ExecutionResult({"events": [{"seenAt": datetime.now(timezone.utc)}]}))
        service = FakeService(app)
        self.run_app(app, service)
        self.assertEqual(service.comparison["results"][0]["candidate"]["error"], "output_invalid")
        for diagnostic in self.journal_root.rglob("output-validation.json"):
            details = json.loads(diagnostic.read_bytes())
            self.assertEqual(details["field"], 'output["events"][0]["seenAt"]')
            self.assertIn("isoformat()", details["reason"])
            self.assertEqual(diagnostic.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.journal_root.rglob("output-validation.json"))), 2)
        self.assertNotIn("seenAt", json.dumps(service.comparison))

    def test_callback_exception_diagnostics_are_private_by_default_with_opt_out(self):
        def broken(run):
            raise RuntimeError("provider message Authorization: Bearer sk-live-0123456789abcdef")
        for phase in ("execute", "grade"):
            for setting in (False, None, True):
                root = self.root / (phase + str(setting))
                config = {**json.loads(self.config.read_bytes()), "journalRoot": str(root)}
                config.pop("captureCallbackErrors", None)
                if setting is not None:
                    config["captureCallbackErrors"] = setting
                self.config.write_bytes(json_bytes(config))
                app = self.app(**{phase: broken})
                service = FakeService(app)
                result = self.run_app(app, service)
                reports = list(root.rglob("callback-error.json"))
                self.assertEqual(len(reports), 0 if setting is False else 2)
                self.assertEqual(service.comparison["results"][0]["parent"]["error"], "execution_failed" if phase == "execute" else "grading_failed")
                failure = result["firstCallbackFailure"]
                self.assertEqual((failure["caseId"], failure["repetition"], failure["stage"]), ("one", 0, phase))
                self.assertEqual("diagnosticFile" in failure, setting is not False)
                for report in reports:
                    details = json.loads(report.read_bytes())
                    self.assertEqual(details["phase"], phase)
                    self.assertEqual(details["exceptionType"], "RuntimeError")
                    self.assertEqual(details["frames"][-1]["function"], "broken")
                    self.assertIn("provider message", details["message"])
                    self.assertIn("in broken", details["stack"])
                    self.assertNotIn("sk-live-0123456789abcdef", report.read_text())
                    self.assertEqual(report.stat().st_mode & 0o777, 0o600)
                self.assertNotIn("RuntimeError", json.dumps(service.comparison))
                self.assertNotIn("provider message", json.dumps(service.comparison))
                self.assertNotIn("provider message", json.dumps(result))

    def test_collection_schedule_matches_typescript_and_actual_callbacks(self):
        seen = []
        def execute(run):
            ctx = run.context
            binding = json.loads((Path(ctx.private_job_directory) / "collection-binding.json").read_bytes())
            self.assertEqual((binding["pairIndex"], binding["armIndex"], binding["side"]),
                             (ctx.collection.pair_index, ctx.collection.arm_index, ctx.side))
            self.assertEqual(binding["scheduleDigest"], ctx.collection.schedule_digest)
            seen.append(ctx.side)
            return ExecutionResult(True)

        config = dict(config_id="paired", config_revision="1", dataset_revision="1", grader_revision="1",
                      runtime={}, execution="model-free", execute=execute, grade=lambda _: GradeResult(1),
                      cases=[Case("one🍊", None, None, 4)])
        app = define_evaluation(**config, collection={"protocol":"seeded-balanced-v1", "seed":"parity🍊"})
        result = self.run_app(app, FakeService(app))
        digest = "sha256:e4e68691c20042ee820793c8c9404ace8a7187ff21e75c63fe81e4f032e1dcaa"
        self.assertEqual(result["comparison"]["runtime"]["acclimate.collection.schedule"], digest)
        schedule = json.loads(next(self.journal_root.glob("*/collection.json")).read_bytes())
        self.assertEqual(schedule["digest"], digest)
        self.assertEqual(seen, ["parent","candidate", "candidate","parent", "candidate","parent", "parent","candidate"])
        for key in ("protocol", "seed", "schedule"):
            with self.assertRaises(EvaluationError) as caught:
                define_evaluation(**{**config, "runtime": {"acclimate.collection." + key: "spoofed"}})
            self.assertEqual(caught.exception.code, "definition.invalid")
            self.assertEqual(caught.exception.field, "runtime.acclimate.collection." + key)

    def test_oversized_report_exposes_a_usable_partition_limit(self):
        make_cases = lambda n: [Case("case" + str(i), {}, True, 10) for i in range(n)]
        with self.assertRaises(EvaluationError) as caught:
            self.app(cases=make_cases(50))
        diagnostic = caught.exception.diagnostic["reportBudget"]
        self.assertEqual(diagnostic["expectedPairs"], 500)
        self.assertGreater(diagnostic["estimatedBytes"], diagnostic["limitBytes"])
        limit = diagnostic["maxPairsPerPartition"] // 10
        self.assertGreater(limit, 0)
        self.app(cases=make_cases(limit))

    def test_saved_report_recovers_lost_submit_and_finish_without_callbacks(self):
        for operation in ("comparisons","finish"):
            with self.subTest(operation=operation):
                for p in self.journal_root.glob("*") if self.journal_root.exists() else []:
                    import shutil
                    shutil.rmtree(p)
                calls=[]
                app=self.app(lambda run:(calls.append(run.bundle["version"]["id"]) or ExecutionResult({"ok":True})))
                service=FakeService(app)
                service.lose_once=operation
                with self.assertRaises(EvaluationError) as caught:
                    self.run_app(app,service)
                self.assertEqual(caught.exception.code,"submission.unconfirmed")
                self.assertNotIn("secret",str(caught.exception))
                result=self.run_app(app,service)
                self.assertEqual(result["comparison"]["id"],COMPARISON)
                self.assertEqual(calls,[PARENT,CANDIDATE])
                repeated=[r for r in service.mutations if r[0].endswith("/"+operation)]
                if len(repeated)>1:
                    self.assertEqual(repeated[0],repeated[1])

    def test_committed_oversized_http_submit_response_recovers_without_callbacks(self):
        events=[]
        def execute(run):
            events.append(("execute",run.bundle["version"]["id"]))
            return ExecutionResult({"ok":True})
        def grade(run):
            events.append(("grade",run.case_id))
            return GradeResult(1)
        app=self.app(execute,grade)
        service=FakeService(app)
        retained_mutation=service._request
        oversize_next_submit=True
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):
                pass
            def do_GET(self):
                response=json_bytes(retained_mutation("GET",self.path))
                self.send_response(200)
                self.send_header("Content-Type","application/json")
                self.send_header("Content-Length",str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            def do_POST(self):
                nonlocal oversize_next_submit
                raw=self.rfile.read(int(self.headers["Content-Length"]))
                result=retained_mutation("POST",self.path,key=self.headers["Idempotency-Key"],
                    _body_bytes=raw,_retained=self.headers["X-Acclimate-Durable-Operation"]=="true")
                # The server commits and retains the ORIGINAL comparison before
                # sending an over-budget successful JSON response to the SDK.
                if self.path.endswith("/comparisons") and oversize_next_submit:
                    oversize_next_submit=False
                    response=json_bytes({**result,"padding":"x"*(4*1024*1024)})
                else:
                    response=json_bytes(result)
                self.send_response(200)
                self.send_header("Content-Type","application/json")
                self.send_header("Content-Length",str(len(response)))
                self.end_headers()
                try:
                    self.wfile.write(response)
                except (BrokenPipeError,ConnectionResetError):
                    pass  # The bounded client intentionally closes oversized data.
        server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        url=f"http://127.0.0.1:{server.server_address[1]}"
        transport=AcclimateClient(url,token="fixture-token",scope="evaluator",retries=0)
        service.base_url=url
        service._request=transport._request
        config=json.loads(self.config.read_bytes())
        config["serviceUrl"]=url
        self.config.write_bytes(json_bytes(config))
        handoff={**self.handoff(app),"serviceUrl":url}
        def invoke():
            with patch("acclimate.evaluation.make_client",return_value=service):
                return run_evaluation(app=app,config_path=str(self.config),handoff=handoff)
        try:
            with self.assertRaises(EvaluationError) as caught:
                invoke()
            self.assertEqual(caught.exception.code,"transport.response_too_large")
            self.assertEqual(caught.exception.diagnostic["executionState"],"report_saved")
            self.assertEqual(caught.exception.next_action,"retry_same_command")
            self.assertEqual(service.comparison["id"],COMPARISON)
            attempt=next(self.journal_root.glob("*/attempt.python.json"))
            state=json.loads(attempt.read_bytes())
            original_attempt=state["attemptId"]
            original_submit_key=state["keys"]["submit"]
            exact_report=(attempt.parent/state["wireBodies"]["submit"]["file"]).read_bytes()
            self.assertTrue(state["report"])
            self.assertNotIn("comparisonId",state)
            original_events=events[:]
            result=invoke()
            self.assertEqual(result["comparison"]["id"],COMPARISON)
            self.assertEqual(result["evaluation"]["attemptId"],original_attempt)
            self.assertEqual(events,original_events)
            self.assertEqual(len(events),4)
            submitted=[row for row in service.mutations if row[0].endswith("/comparisons")]
            self.assertEqual(len(submitted),2)
            self.assertTrue(all(row[1]==original_submit_key and row[2]==exact_report for row in submitted))
            self.assertEqual((attempt.parent/"submit-body.json").read_bytes(),exact_report)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_report_seal_crash_repairs_blank_index_hash_without_callbacks(self):
        class Crash(BaseException):
            pass
        calls=[]
        app=self.app(lambda run:(calls.append(run.bundle["version"]["id"]) or ExecutionResult({"ok":True})))
        service=FakeService(app)
        original=Journal.save_artifact_index
        def crash_before_index_seal(journal,index):
            if index.get("reportSha256"):
                raise Crash()
            return original(journal,index)
        with patch.object(Journal,"save_artifact_index",crash_before_index_seal):
            with self.assertRaises(Crash):
                self.run_app(app,service)
        attempt=next(self.journal_root.glob("*/attempt.python.json"))
        state=json.loads(attempt.read_bytes())
        self.assertTrue(state["report"])
        index_path=attempt.parent/"artifact-index.json"
        self.assertEqual(json.loads(index_path.read_bytes())["reportSha256"],"")
        result=self.run_app(app,service)
        index=json.loads(index_path.read_bytes())
        self.assertEqual(calls,[PARENT,CANDIDATE])
        self.assertEqual(index["comparisonId"],result["comparison"]["id"])
        self.assertEqual(index["reportSha256"],"sha256:"+hashlib.sha256((attempt.parent/"submit-body.json").read_bytes()).hexdigest())
        index["reportSha256"]="sha256:"+"0"*64
        index_path.write_bytes(json_bytes(index))
        with self.assertRaises(EvaluationError) as caught:
            self.run_app(app,service)
        self.assertEqual(caught.exception.code,"artifact.integrity")
        self.assertEqual(calls,[PARENT,CANDIDATE])

    def test_private_role_envelope_rejects_swapped_index_file_metadata(self):
        app=self.app(grade=lambda run:GradeResult(1,explanation={"private":"explanation"}))
        service=FakeService(app)
        self.run_app(app,service)
        scope={"serviceUrl":"https://fixture.example","projectId":"project","bundleId":BUNDLE,
            "requestId":REQUEST,"evaluatorPrincipalId":"evaluator"}
        with Journal(self.journal_root,scope) as journal:
            index=journal.read_artifact_index()
            output=next(row for row in index["entries"] if row["role"]=="output")
            explanation=next(row for row in index["entries"] if row["role"]=="grader-explanation")
            self.assertEqual(journal.read_artifact(output),{"ok":True})
            swapped={**output,**{key:explanation[key] for key in ("file","sha256","bytes")}}
            with self.assertRaises(EvaluationError) as caught:
                journal.read_artifact(swapped)
            self.assertEqual(caught.exception.code,"artifact.integrity")

    def test_lost_start_response_recovers_same_key_before_execution(self):
        calls=[]
        app=self.app(lambda run:(calls.append(1) or ExecutionResult({"ok":True})))
        service=FakeService(app)
        service.lose_once="start"
        with self.assertRaises(EvaluationError):
            self.run_app(app,service)
        self.assertEqual(calls,[])
        self.assertEqual(self.run_app(app,service)["evaluation"]["status"],"completed")
        self.assertEqual(len(calls),2)

    def test_conflicting_saved_lifecycle_bodies_are_rejected_before_mutation(self):
        for operation in ("start","finish"):
            with self.subTest(operation=operation):
                shutil.rmtree(self.journal_root,ignore_errors=True)
                calls=[]
                app=self.app(lambda run:(calls.append("execute") or ExecutionResult({"ok":True})))
                service=FakeService(app)
                original=service._request
                def fail_before_commit(method,path,*args,**kwargs):
                    if path.endswith("/"+operation):
                        raise TransportError("fixture connection lost before commit")
                    return original(method,path,*args,**kwargs)
                service._request=fail_before_commit
                with self.assertRaises(EvaluationError):
                    self.run_app(app,service)
                attempt=next(self.journal_root.glob("*/attempt.python.json"))
                state=json.loads(attempt.read_bytes())
                conflicting={"attemptId":str(uuid.uuid4())}
                if operation=="finish":
                    conflicting["comparisonId"]=state["comparisonId"]
                body=json_bytes(conflicting)
                (attempt.parent/(operation+"-body.json")).write_bytes(body)
                state["wireBodies"][operation]={"file":operation+"-body.json","bytes":len(body),
                    "sha256":"sha256:"+hashlib.sha256(body).hexdigest()}
                attempt.write_bytes(json_bytes(state))
                service._request=original
                mutations=len(service.mutations)
                callbacks=len(calls)
                with self.assertRaises(EvaluationError) as caught:
                    self.run_app(app,service)
                self.assertEqual(caught.exception.code,"journal.invalid")
                self.assertEqual(len(service.mutations),mutations)
                self.assertEqual(len(calls),callbacks)
                self.assertEqual(service.request["status"],"requested" if operation=="start" else "running")

    def test_uncertain_grade_stops_all_callbacks_and_refuses_retry(self):
        calls=[]
        def execute(run):
            calls.append("execute")
            return ExecutionResult({"ok":True})
        def grade(run):
            calls.append("grade")
            raise ExecutionUncertainError()
        app=self.app(execute,grade)
        service=FakeService(app)
        for _ in range(2):
            with self.assertRaises(ExecutionUncertainError):
                self.run_app(app,service)
        self.assertEqual(calls,["execute","grade"])
        self.assertIsNone(service.comparison)

    def test_uncertain_execute_fails_only_that_arm_is_never_retried_and_leaves_a_marker(self):
        calls=[]
        def execute(run):
            calls.append((run.case_id,run.context.side))
            if len(calls)==1:
                raise ExecutionUncertainError()
            return ExecutionResult({"ok":True})
        app=self.app(execute,cases=[Case("one",{"task":"do"},True),Case("two",{"task":"do"},True)])
        service=FakeService(app)
        result=self.run_app(app,service)
        # Every other arm still ran; the uncertain arm ran once.
        self.assertEqual(len(calls),4)
        self.assertEqual(len(set(calls)),4)
        arms=[arm for pair in service.comparison["results"] for arm in (pair["parent"],pair["candidate"])]
        uncertain=[arm for arm in arms if arm["error"]=="execution_uncertain"]
        self.assertEqual(len(uncertain),1)
        self.assertEqual(uncertain[0]["executionStatus"],"infrastructure_failed")
        self.assertEqual(sum(1 for arm in arms if arm["reward"]==1.0),3)
        markers=list(self.journal_root.glob("*/jobs/*/uncertain.json"))
        self.assertEqual(len(markers),1)
        marker=json.loads(markers[0].read_bytes())
        self.assertEqual((marker["caseId"],marker["side"]),calls[0])
        self.assertEqual(result["firstCallbackFailure"]["reason"],"execution_uncertain")
        # A rerun reuses the submitted evidence and never repeats the uncertain arm.
        self.run_app(app,service)
        self.assertEqual(len(calls),4)

    def test_coroutine_callbacks_run_to_completion_and_future_outputs_are_uncertain(self):
        import asyncio
        loops = set()
        async def async_execute(run):
            await asyncio.sleep(0)
            loops.add(id(asyncio.get_running_loop()))
            return ExecutionResult({"ok": True})
        class AsyncGrader:
            async def __call__(self, run):
                loops.add(id(asyncio.get_running_loop()))
                return GradeResult(1.0)
        app = self.app(async_execute, AsyncGrader())
        service = FakeService(app)
        result = self.run_app(app, service)
        self.assertEqual(result["evaluation"]["status"], "completed")
        self.assertEqual(service.comparison["results"][0]["candidate"]["reward"], 1.0)
        # One loop serves every callback so loop-bound clients keep working.
        self.assertEqual(len(loops), 1)
        # A cancelled coroutine cannot attest that its external work stopped.
        async def cancelled(run):
            raise asyncio.CancelledError()
        with self.assertRaises(ExecutionUncertainError):
            self.app(cancelled)._execute(None)
        self.config.write_bytes(json_bytes({**json.loads(self.config.read_bytes()),
                                            "journalRoot": str(self.root / "future-journal")}))
        app=self.app(lambda run:ExecutionResult({"active":Future()}))
        service=FakeService(app)
        with self.assertRaises(ExecutionUncertainError):
            self.run_app(app,service)
        self.assertIsNone(service.comparison)

    def test_cooperative_cancellation_saves_truthful_failed_inventory(self):
        cancel=threading.Event()
        calls=[]
        def execute(run):
            calls.append("execute")
            cancel.set()
            run.cancellation.raise_if_cancelled()
        app=self.app(execute)
        service=FakeService(app)
        result=self.run_app(app,service,cancel_event=cancel)
        self.assertEqual(calls,["execute"])
        self.assertEqual(result["evaluation"]["status"],"failed")
        self.assertEqual(result["comparison"]["results"][0]["candidate"]["reward"],None)

    def test_pending_futures_in_invalid_containers_retain_uncertainty(self):
        class ListSubclass(list):
            pass
        for phase in ("execute","grade"):
            for container in (lambda future:{future:"value"},lambda future:{future},
                              lambda future:frozenset([future]),lambda future:ListSubclass([future])):
                with self.subTest(phase=phase,container=container):
                    shutil.rmtree(self.journal_root,ignore_errors=True)
                    future=Future()
                    calls=[]
                    def execute(run):
                        calls.append("execute")
                        return ExecutionResult(container(future) if phase=="execute" else {"ok":True})
                    def grade(run):
                        calls.append("grade")
                        return GradeResult(1,explanation=container(future))
                    app=self.app(execute,grade)
                    service=FakeService(app)
                    for _ in range(2):
                        with self.assertRaises(ExecutionUncertainError):
                            self.run_app(app,service)
                    self.assertEqual(calls,["execute"] if phase=="execute" else ["execute","grade"])
                    self.assertFalse(future.done())
                    self.assertIsNone(service.comparison)
                    state=json.loads(next(self.journal_root.glob("*/attempt.python.json")).read_bytes())
                    self.assertTrue(state["executionStarted"])
                    self.assertNotIn("report",state)

    def test_terminal_reconciliation_matches_inventory_and_results_by_identity(self):
        calls=[]
        app=self.app(lambda run:(calls.append(run.case_id) or ExecutionResult({"ok":True})),
                     cases=[Case("one",{},True),Case("two",{},True)])
        service=FakeService(app)
        first=self.run_app(app,service)
        service.comparison["expectedCases"].reverse()
        service.comparison["results"].reverse()
        recovered=self.run_app(app,service)
        self.assertEqual(recovered["comparison"]["id"],first["comparison"]["id"])
        self.assertEqual(calls,["one","one","two","two"])
        service.comparison["results"][0]["parent"]["reward"]=0.25
        with self.assertRaises(EvaluationError) as caught:
            self.run_app(app,service)
        self.assertEqual(caught.exception.code,"evidence.identity_mismatch")

    def test_cancellation_during_authoritative_reads_never_starts_next_callback(self):
        # Reads 5 and 6 are the first pre-execute and pre-grade reads respectively.
        for read_number,expected_callbacks in ((5,[]),(6,["execute"])):
            with self.subTest(read_number=read_number):
                if self.journal_root.exists():
                    shutil.rmtree(self.journal_root)
                cancellation=threading.Event()
                callbacks=[]
                def execute(run):
                    callbacks.append("execute")
                    self.assertFalse(run.cancellation.is_cancelled())
                    return ExecutionResult({"ok":True})
                def grade(run):
                    callbacks.append("grade")
                    self.assertFalse(run.cancellation.is_cancelled())
                    return GradeResult(1)
                app=self.app(execute,grade)
                service=FakeService(app)
                original=service.get_evaluation
                reads=0
                def get_request(*args):
                    nonlocal reads
                    reads+=1
                    if reads==read_number:
                        cancellation.set()
                    return original(*args)
                service.get_evaluation=get_request
                result=self.run_app(app,service,cancel_event=cancellation)
                self.assertEqual(callbacks,expected_callbacks)
                self.assertEqual(result["evaluation"]["status"],"failed")

    def test_cancellation_after_job_record_write_never_starts_executor(self):
        cancellation=threading.Event()
        callbacks=[]
        app=self.app(lambda run:(callbacks.append("execute") or ExecutionResult({"ok":True})))
        service=FakeService(app)
        original=Journal.job_directory
        def job_directory(journal,*args):
            result=original(journal,*args)
            cancellation.set()
            return result
        with patch.object(Journal,"job_directory",job_directory):
            result=self.run_app(app,service,cancel_event=cancellation)
        self.assertEqual(callbacks,[])
        self.assertEqual(result["evaluation"]["status"],"failed")

    def test_ownership_lost_during_authoritative_read_never_starts_callback(self):
        callbacks=[]
        app=self.app(lambda run:(callbacks.append("execute") or ExecutionResult({"ok":True})))
        service=FakeService(app)
        original=service.get_evaluation
        reads=0
        def get_request(*args):
            nonlocal reads
            reads+=1
            if reads==5:
                lock=next(self.journal_root.glob("*/ownership.lock"))
                lock.unlink()
                lock.write_bytes(b"")
                lock.chmod(0o600)
            return original(*args)
        service.get_evaluation=get_request
        with self.assertRaises(EvaluationError) as caught:
            self.run_app(app,service)
        self.assertEqual(caught.exception.code,"journal.ownership_lost")
        self.assertEqual(callbacks,[])
        self.assertIsNone(service.comparison)

    def test_stale_start_snapshot_does_not_schedule_after_interruption(self):
        calls=[]
        app=self.app(lambda run:(calls.append(1) or ExecutionResult({"ok":True})))
        service=FakeService(app)
        service.interrupt_after_start=True
        result=self.run_app(app,service)
        self.assertEqual(result["executionState"],"interrupted")
        self.assertEqual(calls,[])

    def test_attempt_abandoned_by_the_service_settles_without_executing(self):
        calls=[]
        app=self.app(lambda run:(calls.append(1) or ExecutionResult({"ok":True})))
        service=FakeService(app)
        service.abandon_after_start=True
        result=self.run_app(app,service)
        self.assertEqual(result["executionState"],"interrupted")
        self.assertEqual(result["evaluation"]["status"],"abandoned")
        self.assertEqual(calls,[])
        self.assertIsNone(service.comparison)

    def test_doctor_is_nonexecuting_and_denied_authority_is_not_ready(self):
        calls=[]
        app=self.app(lambda run:(calls.append(1) or ExecutionResult(True)))
        service=FakeService(app)
        service.write_access=False
        with patch("acclimate.evaluation.make_client",return_value=service):
            check=preflight_evaluation(app=app,config_path=str(self.config),target={"handoff":self.handoff(app)})
        self.assertEqual(check["status"],"blocked")
        self.assertEqual(check["authorization"],"denied")
        self.assertEqual(calls,[])
        self.assertEqual(service.mutations,[])
        self.assertEqual(list(self.journal_root.iterdir()),[])

    def test_doctor_missing_targets_are_specific_and_private(self):
        calls=[]
        app=self.app(lambda run:(calls.append(1) or ExecutionResult(True)),lambda run:(calls.append(1) or GradeResult(1)))
        for resource,check_name,method in (("bundle","targetBundle","_request"),
            ("request","targetRequest","get_evaluation"),("version","versions","get_version"),
            ("capabilities","evaluatorAccess","get_evaluation_capabilities")):
            with self.subTest(resource=resource):
                service=FakeService(app)
                if resource=="bundle":
                    service._request=lambda *_args,**_kwargs:{"items":[],"nextCursor":None}
                else:
                    def missing(*_args,**_kwargs):
                        raise ApiError(404,"not_found","PRIVATE_HTTP_CANARY " + str(self.root))
                    setattr(service,method,missing)
                with patch("acclimate.evaluation.make_client",return_value=service):
                    result=preflight_evaluation(app=app,config_path=str(self.config),target={"handoff":self.handoff(app)})
                self.assertEqual(result["status"],"blocked")
                self.assertEqual(result["checks"][-1],{"check":check_name,
                    "status":"unverified" if resource=="capabilities" else "failed",
                    "code":"capabilities.unsupported" if resource=="capabilities" else resource+".missing"})
                self.assertEqual(result["nextAction"],"upgrade_service" if resource=="capabilities" else "fix_config")
                self.assertNotIn("PRIVATE_HTTP_CANARY",json.dumps(result))
                self.assertNotIn(str(self.root),json.dumps(result))
                self.assertEqual(service.mutations,[])
                self.assertIsNone(service.request["attemptId"])
        self.assertEqual(calls,[])

    def test_doctor_bundle_inventory_is_paginated_bounded_and_fails_closed(self):
        app=self.app()
        for mode in ("second_page","missing","loop","malformed","limit"):
            with self.subTest(mode=mode):
                service=FakeService(app)
                reads=[]
                def inventory(_method,route):
                    self.assertEqual(_method,"GET")
                    reads.append(route)
                    if mode=="second_page":
                        return {"items":[] if len(reads)==1 else [{"id":BUNDLE}],"nextCursor":"two" if len(reads)==1 else None}
                    if mode=="missing":
                        return {"items":[],"nextCursor":None}
                    if mode=="loop":
                        return {"items":[],"nextCursor":"same"}
                    if mode=="limit":
                        return {"items":[],"nextCursor":str(len(reads))}
                    return {"items":None,"nextCursor":None}
                service._request=inventory
                with patch("acclimate.evaluation.make_client",return_value=service):
                    result=preflight_evaluation(app=app,config_path=str(self.config),target={"bundleId":BUNDLE})
                self.assertEqual(result["status"],"ready" if mode=="second_page" else "blocked")
                if mode=="second_page":
                    self.assertIn("cursor=two",reads[1])
                else:
                    self.assertEqual(result["checks"][-1]["code"],"bundle.missing" if mode=="missing" else
                        "evidence.incomplete" if mode=="limit" else "evidence.malformed")
                self.assertLessEqual(len(reads),100)
                self.assertEqual(service.mutations,[])

    def test_preflight_distinguishes_config_and_journal_path_aliases(self):
        alias = self.root / "private-name-canary"
        alias.symlink_to(self.root, target_is_directory=True)
        config_link = self.root / "file-alias"
        config_link.symlink_to(self.config)
        config = json.loads(self.config.read_bytes())
        config["journalRoot"] = str(alias / "missing" / "journals")
        self.config.write_bytes(json_bytes(config))
        for filename, field in ((config_link, "configPath"), (alias / self.config.name, "configPath"),
                                (self.config, "journalRoot")):
            with self.subTest(field=field, filename=filename):
                result = preflight_evaluation(app=self.app(), config_path=str(filename), target={"bundleId": BUNDLE})
                self.assertEqual(result["status"], "blocked")
                failure = result["checks"][-1]
                self.assertEqual((failure["code"], failure["field"]), ("config.permissions", field))
                self.assertIn("realpath", failure["hint"])
                self.assertNotIn("chmod", failure["hint"])
                self.assertNotIn(str(self.root), json.dumps(result))
        self.assertFalse((self.root / "missing").exists())

    def test_definition_bounds_and_private_config_do_not_echo_secrets(self):
        with self.assertRaises(EvaluationError):
            self.app(cases=[Case("bool",{},True,True)])
        with self.assertRaises(EvaluationError):
            self.app(cases=[Case("unsafe",{"n":2**53},True)])
        with self.assertRaises(EvaluationError):
            self.app(cases=[Case("unsafe-float",{"n":1e20},True)])
        self.config.chmod(0o644)
        with self.assertRaises(EvaluationError) as caught:
            read_evaluator_config(self.config)
        self.assertEqual(caught.exception.diagnostic["pathIssue"], "configMode")
        self.assertIn("chmod", caught.exception.diagnostic["hint"])
        self.assertNotIn("private-canary-token",repr(caught.exception))
        self.assertNotIn(str(self.root),str(caught.exception))

    def test_portable_output_rejects_unsafe_integral_float_but_wire_reward_remains_finite(self):
        app=self.app(lambda run:ExecutionResult({"n":1e20}))
        service=FakeService(app)
        result=self.run_app(app,service)
        self.assertEqual(result["evaluation"]["status"],"failed")
        self.assertIsNone(result["comparison"]["results"][0]["parent"]["reward"])
        import shutil
        shutil.rmtree(self.journal_root)
        app=self.app(grade=lambda run:GradeResult(1e308))
        service=FakeService(app)
        result=self.run_app(app,service)
        self.assertEqual(result["comparison"]["results"][0]["candidate"]["reward"],1e308)

    def test_terminal_result_cannot_adopt_changed_report_with_same_binding(self):
        app=self.app()
        service=FakeService(app)
        self.run_app(app,service)
        service.comparison["results"][0]["parent"]["reward"]=0.25
        with self.assertRaises(EvaluationError) as caught:
            self.run_app(app,service)
        self.assertEqual(caught.exception.code,"evidence.identity_mismatch")

    def test_ignored_cancellation_holds_lock_and_inputs_until_callback_settles(self):
        entered=threading.Event()
        release=threading.Event()
        cancelled=threading.Event()
        results=[]
        failures=[]
        def execute(run):
            entered.set()
            release.wait(5)
            return ExecutionResult({"ok":True})
        app=self.app(execute)
        service=FakeService(app)
        def worker():
            try:
                results.append(self.run_app(app,service,cancel_event=cancelled))
            except BaseException as error:
                failures.append(error)
        thread=threading.Thread(target=worker)
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            cancelled.set()
            scope={"serviceUrl":"https://fixture.example","projectId":"project","bundleId":BUNDLE,
                "requestId":REQUEST,"evaluatorPrincipalId":"evaluator"}
            with self.assertRaises(EvaluationError) as caught:
                with Journal(self.journal_root,scope):
                    pass
            self.assertEqual(caught.exception.code,"journal.busy")
            self.assertTrue(thread.is_alive())
            self.assertTrue(next(self.journal_root.glob("*/attempt.python.json")).exists())
        finally:
            release.set()
            thread.join(5)
        self.assertEqual(failures,[])
        self.assertEqual(results[0]["evaluation"]["status"],"failed")

    def test_new_response_budget_and_exact_retained_mutation_bytes(self):
        class Response(io.BytesIO):
            status=200
            headers={}
        class Opener:
            def __init__(self,data):
                self.data=data
                self.requests=[]
            def open(self,request,timeout):
                self.requests.append(request)
                return Response(self.data)
        client=AcclimateClient("https://fixture.example",token="token",scope="evaluator",retries=0)
        body=json_bytes({"value":"x"*(2*1024*1024)})
        client._opener=Opener(body)
        self.assertEqual(len(client._request("GET","/fixture")["value"]),2*1024*1024)
        client.max_json_response_bytes=1024
        with self.assertRaises(ApiError) as caught:
            client._request("GET","/fixture")
        self.assertEqual(caught.exception.code,"response_too_large")
        client.max_json_response_bytes=4*1024*1024
        client._opener=Opener(b"{}")
        data=b'{"attemptId":"66666666-6666-4666-8666-666666666666"}'
        mutate(client,"start",{"projectId":"project","bundleId":BUNDLE,"requestId":REQUEST},data,"retry-key")
        sent=client._opener.requests[0]
        self.assertEqual(sent.data,data)
        self.assertEqual(sent.get_header("Idempotency-key"),"retry-key")
        self.assertEqual(sent.get_header("X-acclimate-durable-operation"),"true")

    def test_real_process_lock_and_foreign_journal(self):
        scope={"serviceUrl":"https://fixture.example","projectId":"project","bundleId":BUNDLE,
            "requestId":REQUEST,"evaluatorPrincipalId":"evaluator"}
        with Journal(self.root/"locks",scope) as journal:
            program="import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(7)"
            result=subprocess.run([sys.executable,"-c",program,str(journal.directory/"ownership.lock")],capture_output=True)
            self.assertEqual(result.returncode,7)
            foreign=journal.directory/"attempt.json"
            foreign.write_text("{}")
            foreign.chmod(0o600)
        with self.assertRaises(EvaluationError) as caught:
            with Journal(self.root/"locks",scope):
                pass
        self.assertEqual(caught.exception.code,"journal.foreign")

    def test_scope_serialization_is_exact_legacy_order_with_unicode(self):
        scope={"requestId":REQUEST,"bundleId":BUNDLE,"serviceUrl":"https://fixture.example",
            "projectId":"caf\u00e9","evaluatorPrincipalId":"line\\quote\""}
        expected=(f'{{"serviceUrl":"https://fixture.example","projectId":"caf\u00e9","bundleId":"{BUNDLE}",'
            f'"requestId":"{REQUEST}","evaluatorPrincipalId":"line\\\\quote\\\""}}').encode()
        self.assertEqual(serialize_scope(scope),expected)

    def test_private_directory_flushes_new_ancestor_entries_before_returning(self):
        existing=self.root/"existing"
        existing.mkdir(mode=0o755)
        target=existing/"new-parent"/"new-child"
        events=[]
        opened={}
        original_open=os.open
        original_mkdir=os.mkdir
        original_fsync=os.fsync
        def open_directory(path,*args,**kwargs):
            fd=original_open(path,*args,**kwargs)
            opened[fd]=Path(path)
            return fd
        def mkdir(path,*args,**kwargs):
            original_mkdir(path,*args,**kwargs)
            events.append(("mkdir",Path(path)))
        def fsync(fd):
            events.append(("fsync",opened[fd]))
            original_fsync(fd)
        with patch("acclimate._evaluation_shared.os.open",open_directory), patch("acclimate._evaluation_shared.os.mkdir",mkdir), patch("acclimate._evaluation_shared.os.fsync",fsync):
            self.assertEqual(ensure_private_directory(target),target)
            events.append(("returned",target))
        created=[path for event,path in events if event=="mkdir"]
        flushed=[path for event,path in events if event=="fsync"]
        self.assertEqual(created,[existing/"new-parent",target])
        self.assertEqual(flushed,[target,existing/"new-parent",existing])
        self.assertEqual(events[-1],("returned",target))
        self.assertEqual(existing.stat().st_mode&0o777,0o755)
        self.assertNotIn(self.root,flushed)

    @unittest.skipUnless(shutil.which("node") and Path("node_modules/tsx").exists(),"Node/tsx external-consumer prerequisite unavailable")
    def test_typescript_and_python_use_same_kernel_lock_and_refuse_foreign_state(self):
        scope={"serviceUrl":"https://fixture.example","projectId":"project","bundleId":BUNDLE,
            "requestId":REQUEST,"evaluatorPrincipalId":"evaluator"}
        script="""import {openJournal} from './packages/sdk/src/evaluation/journal.ts';
try { const journal=await openJournal(process.argv[1],JSON.parse(process.argv[2]));await journal.close();process.exitCode=9; }
catch(error) {process.exitCode=error.code==='journal.busy'?7:error.code==='journal.foreign'?8:10;}"""
        args=["node","--import","tsx","--input-type=module","-e",script,str(self.root/"cross"),json.dumps(scope)]
        with Journal(self.root/"cross",scope) as journal:
            result=subprocess.run(args,capture_output=True,timeout=15)
            self.assertEqual(result.returncode,7,result.stderr.decode())
            state={"scope":scope,"request":{},"attemptId":str(uuid.uuid4()),"keys":{name:str(uuid.uuid4()) for name in ("start","submit","finish")}}
            journal.save(state)
        result=subprocess.run(args,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,8,result.stderr.decode())


if __name__=="__main__":
    unittest.main()
