"""Await the installed evaluator from asyncio code.

run_evaluation_async ships in the SDK. Cancelling the awaiting task asks the
runner to stop, then waits for it to finish before raising CancelledError.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from acclimate.evaluation import EvaluationError, run_evaluation_async
from acclimate.evaluation_async import run_in_thread_until_quiescent as run_in_thread_until_quiescent  # re-export
from acclimate.evaluation_app import SetupError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--handoff', required=True)
    parser.add_argument('--live', required=True, action='store_true')
    args = parser.parse_args()
    try:
        handoff = json.loads(Path(args.handoff).read_text(encoding='utf-8'))
        result = asyncio.run(run_evaluation_async(config_path=args.config, handoff=handoff, allow_live=args.live,
                                                  directory=Path(__file__).resolve().parent))
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except EvaluationError as error:
        print(json.dumps({'error': error.diagnostic}), file=sys.stderr)
        return 3 if error.diagnostic.get('executionState') in ('may_have_started', 'report_saved') else 1
    except (ValueError, OSError):
        print('Cannot read the evaluation handoff. Check its path and JSON contents.', file=sys.stderr)
        return 1
    evaluation = result['evaluation']
    print(json.dumps({'schemaVersion': 1, 'requestId': evaluation['id'],
                      'status': evaluation['status'], 'comparisonId': evaluation['comparisonId']}))
    return 0 if evaluation['status'] == 'completed' else 2 if evaluation['status'] == 'failed' else 3


if __name__ == '__main__':
    sys.exit(main())
