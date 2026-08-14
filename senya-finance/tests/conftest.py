"""Shared fixtures for the senya-finance test suite.

The app package imports cleanly without a database (config is read lazily
through Flask's config object), so tests only need the repo root on the path.
"""
import os
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, APP_DIR)
