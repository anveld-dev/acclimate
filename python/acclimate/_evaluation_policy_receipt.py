"""Record only the public decision for the exact evaluated comparison."""
from .client import ApiError


def record_policy_receipt(client, handoff, verdict):
    policy, binding = verdict["policy"], verdict["expectedBinding"]
    comparison_id = verdict["comparisonId"]
    if (not policy.get("sha256") or not binding.get("attemptId") or
            binding["requestId"] != handoff["requestId"] or comparison_id != binding.get("comparisonId")):
        return {"status": "unconfirmed", "code": "evidence.identity_mismatch"}
    report = {"requestId": handoff["requestId"], "attemptId": binding["attemptId"],
              "policy": policy, "verdict": verdict["verdict"], "checks": verdict["checks"]}
    if verdict.get("inference") is not None:
        report["inference"] = verdict["inference"]
    target = handoff["workspaceId"], handoff["bundleId"], comparison_id
    try:
        receipts = client.list_comparison_policy_receipts(*target)
        receipt = next((r for r in receipts["items"] if r["policy"]["sha256"] == policy["sha256"]), None)
        if receipt is None:
            receipt = client.report_comparison_policy_receipt(*target, report)
        if (receipt.get("comparisonId") != comparison_id or receipt.get("reportedBy") != binding.get("submitter")
                or any(receipt.get(k) != v for k, v in report.items())):
            return {"status": "unconfirmed", "code": "policy.receipt_conflict"}
        return {"status": "recorded"}
    except Exception as error:
        code = "policy.receipt_unavailable"
        if isinstance(error, ApiError) and error.status in (401, 403):
            code = "auth.denied"
        if isinstance(error, ApiError) and error.status == 409:
            code = "policy.receipt_conflict"
        return {"status": "unconfirmed", "code": code}
