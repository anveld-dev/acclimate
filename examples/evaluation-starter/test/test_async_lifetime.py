import asyncio
import fcntl
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from async_eval import run_in_thread_until_quiescent


class AsyncLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_caller_cancellations_preserve_active_worker_files_and_lock(self):
        with tempfile.TemporaryDirectory(prefix='acclimate-async-fixture-') as temporary:
            root = Path(temporary).resolve()
            started, release, cancel_event = threading.Event(), threading.Event(), threading.Event()
            active = root / 'active.txt'
            lockfile = root / 'ownership.lock'

            def operation():
                with lockfile.open('w') as owner:
                    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    active.write_text('inputs are still in use')
                    started.set()
                    try:
                        if not release.wait(timeout=10):
                            raise RuntimeError('Test worker was not released')
                        return {'stopped': True}
                    finally:
                        active.unlink()

            caller = asyncio.create_task(run_in_thread_until_quiescent(operation, cancel_event=cancel_event))
            try:
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(started.is_set())
                caller.cancel()
                await asyncio.sleep(.02)
                caller.cancel()
                await asyncio.sleep(.02)
                self.assertTrue(cancel_event.is_set())
                self.assertFalse(caller.done())
                self.assertTrue(active.exists())
                with lockfile.open('r') as contender:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(caller, timeout=5)
                self.assertFalse(active.exists())
                with lockfile.open('r') as contender:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                release.set()
                if not caller.done():
                    try:
                        await caller
                    except asyncio.CancelledError:
                        pass

    async def test_uncancelled_sync_error_propagates_after_worker_settles(self):
        def operation():
            raise ValueError('private diagnostic')
        with self.assertRaises(ValueError):
            await run_in_thread_until_quiescent(operation, cancel_event=threading.Event())


if __name__ == '__main__':
    unittest.main()
