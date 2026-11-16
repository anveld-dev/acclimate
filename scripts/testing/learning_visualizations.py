#!/usr/bin/env python3
"""Compatibility entry point for the current Changes and evaluation qualification.

The former learning-history overview was replaced by the scoped evaluation ledger.
Keep this command usable while testing its replacement and the retained case maps.
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.testing.changes_workspace import run

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', required=True, type=Path)
    run(parser.parse_args())
