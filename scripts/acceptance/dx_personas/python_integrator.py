#!/usr/bin/env python3
"""Python persona: externally installed app against owned real Rust/PostgreSQL."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from scripts.acceptance.dx_personas.support import PersonaFixture

PUBLIC = ROOT / "docs/acceptance/developer-personas-gap-closure-20261117/python-integrator.json"
TYPING_FIXTURES = ROOT / "python/tests/typing"


def run_typing_acceptance(consumer_python: Path, evidence_root: Path, clean_env=None):
    """Use published consumer fixtures; mypy remains isolated from SDK runtime."""
    root = evidence_root / "private/static-typing"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    env = {key: value for key, value in (clean_env or os.environ).items()
           if key not in ("PYTHONPATH", "PYTHONHOME", "MYPYPATH")}

    def command(name, argv):
        result = subprocess.run(list(map(str, argv)), cwd=root, env=env,
                                capture_output=True, text=True)
        for suffix, value in (("stdout", result.stdout), ("stderr", result.stderr)):
            target = root / (name + "." + suffix)
            target.write_text(value)
            target.chmod(0o600)
        return result

    tool_python = root / "tool-venv/bin/python"
    if not tool_python.exists():
        assert command("create-venv", [sys.executable, "-m", "venv", root / "tool-venv"]).returncode == 0
    assert tool_python != consumer_python
    assert command("install-mypy", [tool_python, "-m", "pip", "--disable-pip-version-check", "install", "mypy==1.18.2"]).returncode == 0
    checker = command("checker-version", [tool_python, "-m", "mypy", "--version"])
    assert checker.returncode == 0 and checker.stdout.startswith("mypy 1.18.2 ")
    # The shared checker copies these outside the checkout, validates all native
    # public DTO exports and annotations, and rejects every annotated error.
    checked = command("installed-contract", [sys.executable, TYPING_FIXTURES / "check_installed.py",
                      "--consumer-python", consumer_python, "--mypy-python", tool_python])
    assert checked.returncode == 0, "Installed-wheel strict typing failed; inspect private logs"
    lines = checked.stdout.splitlines()
    runtime = json.loads(lines[0])
    summary = json.loads(lines[-1])
    assert summary == {"strictPositiveExitCode": 0, "negativeExitCode": 1, "expectedRejectedCases": 7}, summary
    diagnostics = []
    for line in lines:
        match = re.search(r"negative.py:(\d+): error: (.*?)  \[([^]]+)\]$", line)
        if match:
            diagnostics.append({"line": int(match[1]), "code": match[3]})
    expected_case_count = sum("# reject:" in line for line in (TYPING_FIXTURES / "negative.py").read_text().splitlines())
    assert expected_case_count == 6 and len(diagnostics) == 7
    assert runtime["pep561Marker"] and runtime["runtimeDependencies"] == []
    sdk = Path(runtime["sdkPath"]).resolve()
    assert not sdk.is_relative_to(ROOT.resolve()) and "site-packages" in sdk.parts
    result = {"checker": "mypy", "version": "1.18.2", "strict": True,
              "isolatedDevToolEnvironment": True, "target": "fresh-release-installed-wheel",
              "checkerCommandExitCode": checked.returncode, "positiveExitCode": 0,
              "negativeExitCode": 1, "negativeCaseCount": 7, "annotatedErrorStatements": expected_case_count,
              "diagnostics": diagnostics,
              "documentedRootImports": {"exitCode": 0, "allPublicDomainExports": True},
              "nativeDtoExportIdentity": True, "pep561MarkerPresent": True,
              "consumerOutsideCheckout": True, "runtimeDependencies": []}
    # Six annotated statements include two diagnostics on the misspelled start key;
    # required start absence and unknown spelling are separate rejection cases.
    result["rejectedCases"] = ["missing-analysis-comparisonId", "unknown-start-attempt_id",
                               "missing-start-attemptId", "missing-finish-comparisonId", "invalid-status",
                               "invalid-grader-return-type", "invalid-executor-return-type"]
    result["fixtureSha256"] = {name: hashlib.sha256((TYPING_FIXTURES / name).read_bytes()).hexdigest()
                               for name in ("positive.py", "negative.py", "check_installed.py")}
    (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def distribution_guidance():
    readme = ROOT / "python/README.md"
    text = readme.read_text()
    expected = ("[Getting started](../docs/getting-started.md#1-obtain-a-release-and-choose-a-language)",
                "[source development](../docs/development.md#use-python)",
                "[release verification command](../docs/development.md#publish-and-consume-content)")
    assert all(item in text for item in expected)
    assert "workspace operator" in text and "python3.11 -m pip wheel --no-deps" in text
    assert "--no-index --no-deps" in text
    return {"readmeSha256": hashlib.sha256(readme.read_bytes()).hexdigest(),
            "operatorManagedObtainingGuide": True, "sourceBuildCommand": True,
            "gettingStartedLink": True, "buildAndVerificationLinks": True}

APP = r'''"""Application-owned ticket router. Deterministic simulation, no LLM."""
import json
from pathlib import Path
from acclimate import prepare_files
from acclimate.evaluation import Case, ExecutionResult, GradeResult, define_evaluation
from acclimate.evaluation_cli import evaluation_main

EVENTS = Path(__file__).with_name("callback-events.jsonl")
def event(kind, **extra):
    with EVENTS.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"kind":kind, **extra})+"\n")
    EVENTS.chmod(0o600)

def execute(run):
    event("execute", caseId=run.case_id, side=run.context.side)
    assert "expected" not in run.input
    destination=Path(run.context.private_job_directory)/"agent-context"
    with prepare_files(run.bundle, str(destination)) as prepared:
        # Application policy attaches instruction, registers skill and selects memory.
        attached={item["kind"]:Path(item["absolutePath"]).read_text() for item in prepared.files}
        instructions=attached["instruction"]
        routing=json.loads(attached["skill"])
        approved=json.loads(attached["memory"])
        queue=routing.get(run.input["category"], "general") if "Use routing skill" in instructions else "general"
        priority="high" if run.input["customer"] in approved else "low"
        return ExecutionResult({"queue":queue,"priority":priority,"consumedKinds":sorted(attached)},
            usage={"inputTokens":0,"outputTokens":0,"costUsd":0})

def grade(run):
    event("grade", caseId=run.case_id)
    matched=all(run.output[key]==value for key,value in run.expected.items())
    return GradeResult(float(matched), explanation={"matchesExpected":matched})

def build_app(mode="normal", executor=execute, grader=grade):
    return define_evaluation(config_id="python-owned-ticket-routing",config_revision=mode,
        dataset_revision="saved-support-tickets-20261117",grader_revision="expected-queue-priority-v1",
        runtime={"app":"python-ticket-router-v1","model":"none","writes":"private-fixture-only"},
        execution="model-free",cases=[
            Case("billing-vip",{"category":"billing","customer":"vip-01"},{"queue":"finance","priority":"high"}),
            Case("general-standard",{"category":"unknown","customer":"standard-02"},{"queue":"general","priority":"low"})],
        execute=executor,grade=grader)
app=build_app()
if __name__=="__main__":
    raise SystemExit(evaluation_main(app,__import__("sys").argv[1:]))
'''

PROBE = r'''import asyncio
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import uuid
from typing import get_args, get_type_hints
from acclimate import AcclimateClient, prepare_files
from acclimate.client import TransportError
from acclimate.evaluation import ExecutionResult, GradeResult, EvaluationError, run_evaluation
from acclimate.types import Evaluation, StartEvaluationRequest, FinishEvaluationRequest
from async_eval import run_in_thread_until_quiescent
from persona_app import app, build_app, execute, grade, event, EVENTS

config_path=sys.argv[1]
handoff=json.loads(Path(sys.argv[2]).read_text())
config=json.loads(Path(config_path).read_text())
client=AcclimateClient(config["serviceUrl"],token=config["evaluatorToken"],scope=config["evaluatorPrincipalId"])
request=client.get_evaluation(config["projectId"],handoff["bundleId"],handoff["requestId"])
def count():
    return len(EVENTS.read_text().splitlines()) if EVENTS.exists() else 0
def request_for(definition):
    body={**definition.descriptor, **{key:request[key] for key in ("parentVersionId","parentDigest","candidateVersionId","candidateDigest")},"requireBoundEvidence":True}
    result=client.create_evaluation(config["projectId"],handoff["bundleId"],body,str(uuid.uuid4()))
    return {**handoff,"requestId":result["id"],"configuration":definition.descriptor}
def run(definition, target, **kwargs):
    return run_evaluation(app=definition,config_path=config_path,handoff=target,**kwargs)

# Fault injection occurs after the actual HTTP mutation has committed in Rust.
original=AcclimateClient._request
submissions=[]
lost=[False]
def lose_submit(self,method,path,*args,**kwargs):
    value=original(self,method,path,*args,**kwargs)
    if method=="POST" and path.endswith("/comparisons"):
        submissions.append({"key":kwargs["key"],"body":kwargs["_body_bytes"]})
        if not lost[0]:
            lost[0]=True
            raise TransportError("Injected response loss after real commit")
    return value
AcclimateClient._request=lose_submit
try:
    try:
        run(app,handoff)
        raise AssertionError("response loss was not surfaced")
    except EvaluationError as error:
        assert error.code=="submission.unconfirmed"
        first_code=error.code
    after_loss=count()
    result=run(app,handoff)
    assert count()==after_loss==8
finally:
    AcclimateClient._request=original
assert len(submissions)==2 and submissions[0]==submissions[1]
sealed=count()
assert run(app,handoff)["evaluation"]["status"]=="completed" and count()==sealed
rows=result["comparison"]["results"]
assert sum(row["parent"]["reward"] for row in rows)/2==0.5
assert sum(row["candidate"]["reward"] for row in rows)/2==1

started,release,cancel=threading.Event(),threading.Event(),threading.Event()
active=[]
async_calls=[]
ignore_cancellation=False
def slow_execute(run_input):
    async_calls.append("execute")
    job=Path(run_input.context.private_job_directory)
    lockpath=job/"app.lock"
    with lockpath.open("w") as owner:
        fcntl.flock(owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with prepare_files(run_input.bundle,str(job/"retained-context")) as prepared:
            inputpath=Path(prepared.files[0]["absolutePath"])
            active.extend([inputpath,lockpath])
            started.set()
            assert release.wait(10), "callback release deadline"
            assert inputpath.exists() and run_input.cancellation.is_cancelled()
            if ignore_cancellation:
                return ExecutionResult({"quiescent":True})
            run_input.cancellation.raise_if_cancelled()
    raise AssertionError("cancelled callback continued")
def no_grade(run_input):
    async_calls.append("grade")
    return GradeResult(1)
async_app=build_app("async-cancel-v1",slow_execute,no_grade)
async_handoff=request_for(async_app)
async def exercise():
    beats=0
    running=True
    async def heartbeat():
        nonlocal beats
        while running:
            beats+=1
            await asyncio.sleep(.005)
    heartbeat_task=asyncio.create_task(heartbeat())
    caller=asyncio.create_task(run_in_thread_until_quiescent(lambda:run(async_app,async_handoff,cancel_event=cancel),cancel_event=cancel))
    try:
        for _ in range(1000):
            if started.is_set(): break
            await asyncio.sleep(.005)
        assert started.is_set()
        caller.cancel()
        await asyncio.sleep(.04)
        caller.cancel()
        await asyncio.sleep(.04)
        assert cancel.is_set() and not caller.done() and active[0].exists()
        with active[1].open() as contender:
            try:
                fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)
                raise AssertionError("active callback lock released")
            except BlockingIOError:
                pass
        release.set()
        try:
            await asyncio.wait_for(caller,10)
            raise AssertionError("caller cancellation missing")
        except asyncio.CancelledError:
            pass
        assert not active[0].exists()
        with active[1].open() as contender:
            fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)
        assert beats>=10
        return beats
    finally:
        release.set()
        running=False
        await heartbeat_task
beats=asyncio.run(exercise())
async_result=run(async_app,async_handoff)
assert async_result["evaluation"]["status"]=="failed" and async_calls==["execute"]
assert all(row[side]["gradingStatus"]=="missing" for row in async_result["comparison"]["results"] for side in ("parent","candidate"))
cooperative={"requestId":async_handoff["requestId"],"comparisonId":async_result["comparison"]["id"],"status":"failed","callerCancellations":2,"heartbeatTicks":beats,"callbackKinds":list(async_calls),"inputsHeldUntilQuiescent":True,"lockHeldUntilQuiescent":True,"cleanupAfterQuiescence":True}
started,release,cancel=threading.Event(),threading.Event(),threading.Event()
active.clear()
async_calls.clear()
ignore_cancellation=True
async_app=build_app("async-ignored-cancel-v1",slow_execute,no_grade)
async_handoff=request_for(async_app)
ignored_beats=asyncio.run(exercise())
ignored_result=run(async_app,async_handoff)
assert ignored_result["evaluation"]["status"]=="failed" and async_calls==["execute"]
ignored_row=ignored_result["comparison"]["results"][0]["parent"]
assert ignored_row["executionStatus"]=="completed" and ignored_row["gradingStatus"]=="missing" and ignored_row["error"]=="cancelled"

failure_calls=[]
def failure_execute(run_input):
    failure_calls.append("execute")
    if run_input.case_id=="billing-vip" and run_input.context.side=="parent":
        raise RuntimeError("private infrastructure fault")
    return execute(run_input)
def failure_grade(run_input):
    if run_input.case_id=="billing-vip":
        raise RuntimeError("private grader fault")
    return grade(run_input)
failure_app=build_app("failure-classification-v1",failure_execute,failure_grade)
failure_result=run(failure_app,request_for(failure_app))
failure_row=next(row for row in failure_result["comparison"]["results"] if row["caseId"]=="billing-vip")
assert failure_row["parent"]["executionStatus"]=="infrastructure_failed"
assert failure_row["candidate"]["executionStatus"]=="completed" and failure_row["candidate"]["gradingStatus"]=="failed"
assert failure_result["evaluation"]["status"]=="failed"

metadata=importlib.metadata.distribution("acclimate-sdk")
assert not metadata.requires and shutil.which("node") is None
sdk=Path(__import__("acclimate").__file__).resolve()
assert "site-packages" in str(sdk) and sdk.is_relative_to(Path(sys.prefix))
type_contract={"startRequired":sorted(StartEvaluationRequest.__required_keys__),"finishRequired":sorted(FinishEvaluationRequest.__required_keys__),"statusValues":list(get_args(get_type_hints(Evaluation)["status"]))}
assert type_contract["startRequired"]==["attemptId"] and type_contract["finishRequired"]==["attemptId","comparisonId"]
print(json.dumps({"schemaVersion":1,"runtime":"Python-only","nodeAvailable":False,"sdkDependencies":metadata.requires or [],
    "installedTypeContract":type_contract,
    "main":{"requestId":handoff["requestId"],"comparisonId":result["comparison"]["id"],"status":result["evaluation"]["status"],"parentMeanReward":0.5,"candidateMeanReward":1,"callbacksAfterLostResponse":after_loss,"callbacksAfterTerminalRetry":sealed,"lostResponseCode":first_code,"sameSubmitKey":submissions[0]["key"]==submissions[1]["key"],"sameSubmitBodyBytes":submissions[0]["body"]==submissions[1]["body"],"submitKeySha256":hashlib.sha256(submissions[0]["key"].encode()).hexdigest(),"submitBodySha256":hashlib.sha256(submissions[0]["body"]).hexdigest()},
    "asyncCooperative":cooperative,
    "asyncIgnoredUntilReturn":{"requestId":async_handoff["requestId"],"comparisonId":ignored_result["comparison"]["id"],"status":"failed","callerCancellations":2,"heartbeatTicks":ignored_beats,"callbackKinds":async_calls,"gradingSkipped":True,"futureExecutorsSkipped":True,"inputsHeldUntilQuiescent":True,"lockHeldUntilQuiescent":True,"cleanupAfterQuiescence":True},
    "failures":{"requestId":failure_result["evaluation"]["id"],"comparisonId":failure_result["comparison"]["id"],"status":"failed","parentExecutionStatus":failure_row["parent"]["executionStatus"],"candidateGradingStatus":failure_row["candidate"]["gradingStatus"]}}))
'''

def payload(candidate=False):
    return {"schemaVersion":1,"files":[
        {"path":"instructions.md","kind":"instruction","text":"Use routing skill for ticket category." if candidate else "Route all tickets to general."},
        {"path":"skills/router.json","kind":"skill","text":json.dumps({"billing":"finance"})},
        {"path":"memory/approved-vip.json","kind":"memory","text":json.dumps(["vip-01"])}]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path)
    parser.add_argument("--typing-existing",type=Path,help="Run static acceptance only against a retained owned fixture")
    args=parser.parse_args()
    public=PUBLIC
    public.parent.mkdir(parents=True, exist_ok=True)
    if args.typing_existing:
        existing=args.typing_existing.resolve()
        result=json.loads(public.read_text())
        result["staticTyping"]=run_typing_acceptance(existing/"app/venv/bin/python",existing)
        result["strictTypeCheckerExecuted"]=True
        public.write_text(json.dumps(result,indent=2)+"\n")
        print(json.dumps(result["staticTyping"]))
        return
    if args.output is None:
        parser.error("--output or --typing-existing is required")
    with PersonaFixture("python-integrator",args.output) as f:
        (f.root/"private").chmod(0o700)
        app,python=f.install_python()
        (app/"persona_app.py").write_text(APP)
        (app/"persona_probe.py").write_text(PROBE)
        # Restrict consumer executable discovery to this venv: Node cannot run.
        f.clean_env["PATH"]=str(python.parent)
        setup=f.bootstrap(payload(),name="Python integrator owned routing fixture")
        bundle=setup["bundle"]["id"]
        candidate=f.write_json(app/"owned-candidate.json",payload(True))
        command=[python,app/"persona_app.py"]
        descriptor=f.run([*command,"describe"],app)
        handoff=app/"owned-handoff.json"
        created=f.run([*command,"request","--config",f.evaluator_config,"--bundle",bundle,"--channel","stable","--payload",candidate,"--intent",f.root/"private/owned-request-intent.json","--out",handoff],app)
        ready=f.run([*command,"doctor","--config",f.evaluator_config,"--handoff",handoff],app)
        assert ready["status"]=="ready"
        result=f.run([python,app/"persona_probe.py",f.evaluator_config,handoff],app)
        result.update({"bundleId":bundle,"sourceInventorySha256":f.manifest["source"]["sha256"],"serviceBinarySha256":f.service_sha256,"binarySourceBuildAttested":False,"descriptorCaseCount":len(descriptor["expectedCases"]),"execution":"deterministic-app-simulation-no-model","consumerSourceSha256":hashlib.sha256(APP.encode()).hexdigest(),"asyncRecipeSourceSha256":hashlib.sha256((app/"async_eval.py").read_bytes()).hexdigest(),"strictTypeCheckerExecuted":False,"consumerCommandExitCode":0,"executionCommand":"python3.11 scripts/acceptance/dx_personas/python_integrator.py --output /private/tmp/acclimate-python-gap-retest-20261117"})
        result["staticTyping"]=run_typing_acceptance(python,f.root,f.clean_env)
        result["strictTypeCheckerExecuted"]=True
        result["distributionGuidance"] = distribution_guidance()
        result["release"] = {"manifestSha256": f.release_manifest_sha256,
                             "checksumsSha256": f.release_checksums_sha256,
                             "sourceSha256": f.manifest["source"]["sha256"],
                             "installationProof": f.installation_proofs["app"]}
        result["consumerOutsideCheckout"] = not f.consumer_root.is_relative_to(ROOT.resolve())
        assert result["consumerOutsideCheckout"]
        f.verify_release_unchanged()
        assert hashlib.sha256(f.service_binary.read_bytes()).hexdigest() == f.service_sha256
    cleanup = json.loads((f.root / "private/cleanup.json").read_text())
    result["fixtureCleanup"] = {key: cleanup[key] for key in
                                ("databaseDirectoryRemoved", "serviceStopped", "consumerOutputsRetained")}
    assert result["fixtureCleanup"]["databaseDirectoryRemoved"] and result["fixtureCleanup"]["serviceStopped"]
    f.write_json(f.root / "python-integrator-report.json", result)
    public.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))

if __name__=="__main__":
    main()
