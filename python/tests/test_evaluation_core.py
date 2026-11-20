import unittest

from acclimate.evaluation import redact_diagnostic_text


class EvaluatorDiagnosticsTest(unittest.TestCase):
    def test_redacts_credentials(self):
        message = "Bearer fixture-secret and opaque-secret"
        self.assertEqual(
            redact_diagnostic_text(message, ("opaque-secret",)),
            "Bearer [redacted] and [redacted]",
        )
