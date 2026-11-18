"""Private payment worker for installed-consumer qualification."""


def run_existing_agent(*, bundle, task, cancellation=None):
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    instruction = "\n".join(
        file["text"] for file in bundle["payload"]["files"] if file["kind"] == "instruction"
    )
    reuse_key = "Reuse the same idempotency key" in instruction
    charged, events = set(), []
    charges, succeeded = 0, False
    for attempt in range(2):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        key = "request-1" if reuse_key else f"attempt-{attempt}"
        if key not in charged:
            charged.add(key)
            charges += 1
        events.append({"attempt": attempt, "event": "charge-processed"})
        if task["scenario"] == "lost-response" and attempt == 0:
            events.append({"attempt": attempt, "event": "response-lost"})
            continue
        succeeded = True
        break
    return {"charges": charges, "succeeded": succeeded, "events": events}
