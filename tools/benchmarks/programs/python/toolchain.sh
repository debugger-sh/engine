#!/usr/bin/env bash
# Runs main.py in the working directory, like the engine's `python` toolchain.
# Usage: toolchain.sh <toolchain dir> <build dir> | --version
set -euo pipefail
if [ "$2" = --version ]; then exec "$1/bin/python3" --version; fi

PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 exec "$1/bin/python3" main.py
