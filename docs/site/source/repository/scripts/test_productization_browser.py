#!/usr/bin/env python3
"""Compatibility entry point for the current real-service browser behavior suite."""
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    runner = Path(__file__).resolve().parent / 'bdd' / 'run.py'
    os.execv(sys.executable, [sys.executable, str(runner), '--lane', 'browser', *sys.argv[1:]])
