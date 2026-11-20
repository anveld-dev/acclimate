"""Interpreter check that runs before any module using 3.11+ syntax or typing.

Keep this file importable by old interpreters: no annotations, f-strings or
newer standard library names.
"""

import sys

MINIMUM = (3, 11)


def require_supported_python(version_info=None):
    version = sys.version_info if version_info is None else version_info
    if tuple(version[:2]) < MINIMUM:
        raise ImportError(
            "acclimate-sdk requires Python %d.%d+, found %s. "
            "Create the environment with python3.11 or later."
            % (MINIMUM[0], MINIMUM[1], ".".join(str(part) for part in version[:3]))
        )
