"""Whole-lifetime async integration: cancellation requests stop, then drains the thread."""
import argparse
import asyncio
import functools
import json
import threading
from acclimate.evaluation import ExecutionUncertainError, run_evaluation


async def run_in_thread_until_quiescent(operation, *, cancel_event):
    """Keep the private worker alive through repeated cancellation of its caller.

    `operation` is trusted synchronous application code bound to cancel_event.
    Never expose/cancel its private asyncio task or assume the event killed work.
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
                # The actual thread is no longer tracked: leave its resources alone.
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


async def run_evaluation_async(*, app, config_path, handoff, allow_live=False):
    cancel_event = threading.Event()
    operation = functools.partial(
        run_evaluation, app=app, config_path=config_path, handoff=handoff,
        cancel_event=cancel_event, allow_live=allow_live,
    )
    return await run_in_thread_until_quiescent(operation, cancel_event=cancel_event)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--handoff', required=True)
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    from acclimate_eval import app
    with open(args.handoff, encoding='utf-8') as source:
        handoff = json.load(source)
    result = asyncio.run(run_evaluation_async(app=app, config_path=args.config,
                                            handoff=handoff, allow_live=args.live))
    evaluation = result['evaluation']
    print(json.dumps({'schemaVersion': 1, 'requestId': evaluation['id'],
                      'status': evaluation['status'], 'comparisonId': evaluation['comparisonId']}))


if __name__ == '__main__':
    main()
