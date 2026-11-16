import os
from pathlib import Path
import subprocess
import sys
from threading import Event
import time
import unittest
from acclimate.receipts import DeliveryReporter

BUNDLE = {"version": {"id": "v", "digest": "sha256:" + "a" * 64}}


class Client:
    def __init__(self):
        self.events = []
        self.fail = True

    def report_delivery_receipt(self, project, integration, receipt):
        self.events.append(receipt.copy())
        if self.fail:
            raise OSError("offline")


class ReceiptTests(unittest.TestCase):
    def test_lazy_worker_retry_keeps_event_and_expiry_drops(self):
        clock = [100000.0]
        client = Client()
        reporter = DeliveryReporter(client, "p", "i", clock=lambda: clock[0])
        self.assertIsNone(reporter._worker)
        bound = reporter.bind("b", BUNDLE, "cache")
        bound.report("verified")
        self.assertTrue(reporter.wait())
        original = client.events[0]
        self.assertEqual(reporter.pending_count, 1)
        client.fail = False
        reporter.flush()
        self.assertTrue(reporter.wait())
        self.assertEqual(original, client.events[1])
        client.fail = True
        bound.report_started()
        self.assertTrue(reporter.wait())
        count = len(client.events)
        clock[0] += 86401
        reporter.flush()
        self.assertTrue(reporter.wait())
        self.assertEqual(count, len(client.events))
        self.assertEqual(reporter.pending_count, 0)
        self.assertTrue(reporter.close())

    def test_arrivals_drain_while_failed_events_do_not_spin(self):
        entered, release = Event(), Event()
        client = Client()
        def send(project, integration, receipt):
            client.events.append(receipt.copy())
            if len(client.events) == 1:
                entered.set()
                self.assertTrue(release.wait(2))
                raise OSError("offline")
        client.report_delivery_receipt = send
        reporter = DeliveryReporter(client, "p", "i")
        bound = reporter.bind("b", BUNDLE, "cache")
        try:
            bound.report("verified")
            self.assertTrue(entered.wait(1))
            bound.report_prepared()
            bound.report_started()
            release.set()
            self.assertTrue(reporter.wait())
            self.assertEqual([e["stage"] for e in client.events], ["verified", "prepared", "started"])
            self.assertEqual(reporter.pending_count, 1)
            reporter.flush()
            self.assertTrue(reporter.wait())
            self.assertEqual(client.events[0], client.events[3])
        finally:
            release.set()
            reporter.close()

    def test_close_stops_claiming_and_wait_is_bounded(self):
        entered, release = Event(), Event()
        client = Client()
        def send(project, integration, receipt):
            client.events.append(receipt)
            entered.set()
            release.wait(2)
        client.report_delivery_receipt = send
        reporter = DeliveryReporter(client, "p", "i", max_queue=2)
        bound = reporter.bind("b", BUNDLE, "cache")
        try:
            bound.report("verified")
            self.assertTrue(entered.wait(1))
            bound.report_prepared()
            bound.report_started()  # bounded queue drops the third event
            self.assertEqual(reporter.pending_count, 2)
            before = time.monotonic()
            self.assertFalse(reporter.wait(0.02))
            self.assertFalse(reporter.close(0.02))
            self.assertLess(time.monotonic() - before, 0.5)
            self.assertFalse(reporter.flush())
            bound.report_started()  # close is failure-isolated
            release.set()
            self.assertTrue(reporter.close(1))
            self.assertEqual(len(client.events), 1)
        finally:
            release.set()
            reporter.close()

    def test_stuck_client_does_not_hold_interpreter_exit(self):
        code = '''
from threading import Event
from acclimate.receipts import DeliveryReporter
entered = Event()
class Stuck:
    def report_delivery_receipt(self, *args):
        entered.set()
        Event().wait()
r = DeliveryReporter(Stuck(), "p", "i")
r.bind("b", {"version": {"id": "v", "digest": "d"}}, "cache").report("verified")
assert entered.wait(1)
assert not r.wait(0.02)
CLOSE
print("exited", flush=True)
'''
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
        for close in ("", "assert not r.close(0.02)"):
            with self.subTest(close=bool(close)):
                result = subprocess.run([sys.executable, "-c", code.replace("CLOSE", close)],
                                        env=env, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "exited")

    def test_impossible_stages_and_unbounded_wait_rejected(self):
        reporter = DeliveryReporter(Client(), "p", "i")
        bound = reporter.bind("b", BUNDLE, "cache")
        for stage in ("resolved", "downloaded"):
            with self.assertRaises(ValueError):
                bound.report(stage)
        for timeout in (-1, float("inf"), 31):
            with self.assertRaises(ValueError):
                reporter.wait(timeout)
            with self.assertRaises(ValueError):
                reporter.close(timeout)
        reporter.close()
