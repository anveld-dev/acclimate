"""Await a durable evaluation from asyncio code without abandoning its worker.

The runner is synchronous and owns private files, locks and possibly paid work.
Cancelling the awaiting task asks the runner to stop and then waits until the
worker thread has actually finished, so no file or lock is released early.
"""
from __future__ import annotations

import asyncio
import os
import threading
from typing import Any, Callable

from ._evaluation_controls import RunControls
from ._evaluation_shared import ExecutionUncertainError


async def run_in_thread_until_quiescent(operation: Callable[[], Any], *, cancel_event: threading.Event) -> Any:
    """Run trusted synchronous work bound to cancel_event in a private thread.

    Repeated cancellation of the caller sets cancel_event and keeps waiting for
    the worker. When the worker returns, a cancelled caller still receives
    CancelledError. The event is a request; it does not kill the work.
    """
    worker = asyncio.create_task(asyncio.to_thread(operation))
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(worker)
        except asyncio.CancelledError:
            cancelled = True
            cancel_event.set()
            if worker.cancelled():
                # The thread is no longer tracked: leave its resources alone.
                raise ExecutionUncertainError() from None
            continue
        except BaseException:
            if cancelled:
                raise asyncio.CancelledError() from None
            raise
        else:
            if cancelled:
                raise asyncio.CancelledError()
            return result


async def run_evaluation_async(*, config_path: str, handoff: dict, app=None,
                               directory: str | os.PathLike | None = None, allow_live: bool = False,
                               controls: RunControls | None = None) -> dict:
    """Async form of run_evaluation.

    Pass app, or omit it to load the installed application from directory
    (default: the current directory) inside the worker thread. Cancelling the
    awaiting task requests a cooperative stop and waits for the runner to finish.
    """
    from .evaluation import run_evaluation
    cancel_event = threading.Event()

    def execute():
        options = dict(config_path=config_path, handoff=handoff, allow_live=allow_live,
                       cancel_event=cancel_event, controls=controls)
        if app is not None:
            return run_evaluation(app=app, **options)
        from .evaluation_app import installed_application
        with installed_application(directory) as (installed, _):
            return run_evaluation(app=installed, **options)

    return await run_in_thread_until_quiescent(execute, cancel_event=cancel_event)


__all__ = ["run_evaluation_async", "run_in_thread_until_quiescent"]
