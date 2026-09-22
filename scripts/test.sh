#!/usr/bin/env sh
set -eu

export PYTHONPATH=src
python -m unittest discover -s tests -v
