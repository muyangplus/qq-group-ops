#!/usr/bin/env sh
set -eu

export CI=true
pnpm test
