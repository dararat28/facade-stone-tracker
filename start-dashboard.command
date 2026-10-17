#!/bin/bash
# Facade Stone Dashboard launcher (macOS / Linux)
cd "$(dirname "$0")"
exec python3 server.py --open "$@"
