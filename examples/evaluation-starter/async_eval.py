"""Whole-lifetime async integration: cancellation requests stop, then drains the thread."""
import argparse
import asyncio
import json
import sys
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


async def run_evaluation_async(*, app=None, config_path, handoff, allow_live=False):
    cancel_event = threading.Event()

    def execute():
        options = dict(config_path=config_path, handoff=handoff,
                       allow_live=allow_live, cancel_event=cancel_event)
        if app is not None:
            return run_evaluation(app=app, **options)
        from acclimate_eval import installed_application
        with installed_application() as (installed, _):
            return run_evaluation(app=installed, **options)

    return await run_in_thread_until_quiescent(execute, cancel_event=cancel_event)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--handoff', required=True)
    parser.add_argument('--live', required=True, action='store_true')
    args = parser.parse_args()
    from acclimate_eval import SetupError
    from acclimate.evaluation import EvaluationError

    try:
        with open(args.handoff, encoding='utf-8') as source:
            handoff = json.load(source)
        result = asyncio.run(run_evaluation_async(config_path=args.config, handoff=handoff,
                                                 allow_live=args.live))
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except EvaluationError as error:
        diagnostic = error.diagnostic
        print(json.dumps({'error': diagnostic}), file=sys.stderr)
        return 3 if diagnostic.get('executionState') in ('may_have_started', 'report_saved') else 1
    except (ValueError, OSError):
        print('Cannot read the evaluation handoff. Check its path and JSON contents.', file=sys.stderr)
        return 1
    evaluation = result['evaluation']
    print(json.dumps({'schemaVersion': 1, 'requestId': evaluation['id'],
                      'status': evaluation['status'], 'comparisonId': evaluation['comparisonId']}))
    if evaluation['status'] == 'completed':
        return 0
    return 2 if evaluation['status'] == 'failed' else 3


if __name__ == '__main__':
    sys.exit(main())
