#!/usr/bin/env bash
# Compatible with the system Bash 3.2 shipped by macOS.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/upgrade_pool.py" "$@"
