"""POSIX, runtime-owned durable evaluator state. Not a public storage interface."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat
import uuid

from ._evaluation_shared import (
    MIB, EvaluationError, atomic_private_write, ensure_private_directory,
    guided_uuid, json_bytes, parse_json, read_private_bytes, sha256,
)


_SCOPE_KEYS = ("serviceUrl","workspaceId","bundleId","requestId","evaluatorPrincipalId")


def serialize_scope(scope: dict) -> bytes:
    """The scope a journal records and compares on open."""
    return json_bytes({key:scope[key] for key in _SCOPE_KEYS})


def journal_directory_key(scope: dict) -> str:
    """The journal directory name: a frozen storage key shared with the TypeScript SDK.

    It hashes the 0.1 scope encoding byte for byte, with the workspace ID under
    ``projectId``, so journals written before the 0.2.0 rename are still found.
    Never change it.
    """
    return hashlib.sha256(json_bytes({"serviceUrl":scope["serviceUrl"],"projectId":scope["workspaceId"],
        "bundleId":scope["bundleId"],"requestId":scope["requestId"],
        "evaluatorPrincipalId":scope["evaluatorPrincipalId"]})).hexdigest()


def _recorded_scope(value):
    # Recovery only: a 0.1 journal recorded the workspace ID as scope.projectId.
    if type(value) is dict and "projectId" in value and "workspaceId" not in value:
        return {("workspaceId" if key == "projectId" else key): item for key, item in value.items()}
    return value


class Journal:
    def __init__(self, root: str | Path, scope: dict):
        if os.name != "posix":
            raise EvaluationError("runtime.unsupported")
        self.root = ensure_private_directory(root, journal_root=True)
        self.scope = parse_json(serialize_scope(scope))
        self.directory = ensure_private_directory(self.root/journal_directory_key(scope))
        self._fd: int | None = None
        self._artifact_bytes = 0

    def __enter__(self):
        import fcntl
        try:
            fd=os.open(self.directory/"ownership.lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:
                os.close(fd)
                raise EvaluationError("journal.invalid")
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                raise EvaluationError("journal.busy",phase="claim",next_action="inspect_external_app") from None
            self._fd=fd
            if (self.directory/"attempt.json").exists() or (self.directory/"attempt.json").is_symlink():
                raise EvaluationError("journal.foreign",phase="claim",next_action="restore_original_journal")
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd=None

    def assert_owned(self):
        try:
            if self._fd is None:
                raise ValueError()
            actual=os.fstat(self._fd)
            named=(self.directory/"ownership.lock").lstat()
            if not stat.S_ISREG(named.st_mode) or actual.st_ino!=named.st_ino or actual.st_dev!=named.st_dev:
                raise ValueError()
        except (OSError,ValueError):
            raise EvaluationError("journal.ownership_lost",phase="execute",next_action="inspect_external_app",execution_state="may_have_started") from None

    def read(self) -> dict | None:
        self.assert_owned()
        path=self.directory/"attempt.python.json"
        if not path.exists() and not path.is_symlink():
            return None
        state=parse_json(read_private_bytes(path,4*MIB),code="journal.invalid")
        if type(state) is dict:
            state["scope"]=_recorded_scope(state.get("scope"))
        if type(state) is not dict or state.get("format")!="acclimate-python-evaluation-1" or state.get("scope")!=self.scope:
            raise EvaluationError("journal.invalid",phase="claim")
        if state.get("journalRoot")!=str(self.root):
            raise EvaluationError("journal.relocated",phase="claim",next_action="restore_original_journal")
        if not guided_uuid(state.get("attemptId")) or type(state.get("request")) is not dict or type(state.get("keys")) is not dict or any(
            type(state["keys"].get(k)) is not str or not re.fullmatch(r"[\x20-\x7e]{1,128}",state["keys"][k])
            for k in ("start","submit","finish")):
            raise EvaluationError("journal.invalid",phase="claim")
        if state.get("comparisonId") is not None and not guided_uuid(state["comparisonId"]):
            raise EvaluationError("journal.invalid",phase="claim")
        return state

    def save(self,state: dict):
        self.assert_owned()
        if state.get("scope")!=self.scope or state.get("journalRoot",str(self.root))!=str(self.root):
            raise EvaluationError("journal.invalid")
        value={**state,"format":"acclimate-python-evaluation-1","journalRoot":str(self.root)}
        data=json_bytes(value)
        if len(data)>4*MIB:
            raise EvaluationError("journal.invalid")
        atomic_private_write(self.directory/"attempt.python.json",data)
        self.assert_owned()

    def save_body(self,kind: str,body: bytes) -> dict:
        self.assert_owned()
        if kind not in ("start","submit","finish") or type(body) is not bytes or len(body)>2*MIB:
            raise EvaluationError("journal.invalid")
        parse_json(body,code="journal.invalid")
        filename=kind+"-body.json"
        atomic_private_write(self.directory/filename,body)
        return {"file":filename,"bytes":len(body),"sha256":sha256(body)}

    def read_body(self,kind: str,state: dict) -> bytes:
        self.assert_owned()
        if kind not in ("start","submit","finish") or type(state.get("wireBodies")) is not dict:
            raise EvaluationError("journal.invalid")
        ref=state["wireBodies"].get(kind)
        if type(ref) is not dict or ref.get("file")!=kind+"-body.json" or type(ref.get("bytes")) is not int:
            raise EvaluationError("journal.invalid")
        data=read_private_bytes(self.directory/ref["file"],2*MIB)
        if len(data)!=ref.get("bytes") or sha256(data)!=ref.get("sha256"):
            raise EvaluationError("journal.invalid")
        value=parse_json(data,code="journal.invalid")
        if kind in ("start","finish"):
            expected={"attemptId":state["attemptId"]}
            if kind=="finish":
                if not guided_uuid(state.get("comparisonId")):
                    raise EvaluationError("journal.invalid")
                expected["comparisonId"]=state["comparisonId"]
            if value!=expected:
                raise EvaluationError("journal.invalid")
        return data

    def read_artifact_index(self) -> dict | None:
        self.assert_owned()
        path=self.directory/"artifact-index.json"
        if not path.exists() and not path.is_symlink():
            return None
        value=parse_json(read_private_bytes(path,4*MIB),code="artifact.integrity")
        if type(value) is not dict or value.get("schemaVersion")!=1 or type(value.get("entries")) is not list:
            raise EvaluationError("artifact.integrity",phase="export")
        return value

    def save_artifact_index(self,index: dict):
        self.assert_owned()
        data=json_bytes(index)
        if len(data)>4*MIB:
            raise EvaluationError("artifact.integrity",phase="export")
        atomic_private_write(self.directory/"artifact-index.json",data)

    def write_artifact(self,entry: dict,value) -> dict:
        self.assert_owned()
        role_data=json_bytes(value)
        state=self.read()
        request_id=entry.get("requestId",self.scope["requestId"])
        attempt_id=entry.get("attemptId",state.get("attemptId") if state else None)
        if request_id!=self.scope["requestId"] or not attempt_id or (state and attempt_id!=state["attemptId"]):
            raise EvaluationError("artifact.integrity",phase="execute",execution_state="may_have_started")
        binding={key:entry[key] for key in ("caseId","repetition","side","versionId","digest","role")}
        envelope={"schemaVersion":1,"identity":{"requestId":request_id,"attemptId":attempt_id,**binding},"value":value}
        data=json_bytes(envelope)
        if len(role_data)>MIB or len(data)>MIB+16*1024 or self._artifact_bytes+len(data)>128*MIB:
            raise EvaluationError("artifact.integrity",phase="execute",execution_state="may_have_started")
        filename="artifact-"+uuid.uuid4().hex+".json"
        atomic_private_write(self.directory/filename,data)
        self._artifact_bytes+=len(data)
        return {**binding,"file":filename,"sha256":sha256(data),"bytes":len(data)}

    def register_artifact(self,entry: dict,value) -> dict:
        return self.write_artifact(entry,value)

    def read_artifact(self,entry: dict):
        self.assert_owned()
        filename=entry.get("file")
        if type(filename) is not str or not re.fullmatch(r"artifact-[a-f0-9]{32}\.json",filename):
            raise EvaluationError("artifact.integrity",phase="export")
        data=read_private_bytes(self.directory/filename,MIB+16*1024)
        if len(data)!=entry.get("bytes") or sha256(data)!=entry.get("sha256"):
            raise EvaluationError("artifact.hash_mismatch",phase="export")
        value=parse_json(data,code="artifact.integrity")
        state=self.read()
        identity={"requestId":self.scope["requestId"],"attemptId":state.get("attemptId") if state else None,
            **{key:entry[key] for key in ("caseId","repetition","side","versionId","digest","role")}}
        if type(value) is not dict or set(value)!={"schemaVersion","identity","value"} or type(value["schemaVersion"]) is not int or value["schemaVersion"]!=1 or value["identity"]!=identity or len(json_bytes(value["value"]))>MIB:
            raise EvaluationError("artifact.integrity",phase="export")
        return value["value"]

    def job_directory(self,request_id: str,attempt_id: str,case_id: str,repetition: int,side: str,version: dict) -> tuple[str,Path]:
        self.assert_owned()
        identity={"requestId":request_id,"attemptId":attempt_id,"caseId":case_id,
            "repetition":repetition,"side":side,"versionId":version["id"],"digest":version["digest"]}
        job_id=hashlib.sha256(json_bytes(identity)).hexdigest()
        directory=ensure_private_directory(ensure_private_directory(self.directory/"jobs")/job_id)
        atomic_private_write(directory/"binding.json",json_bytes(identity))
        return job_id,directory
