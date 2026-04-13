#!/usr/bin/env bash
# Shim that delegates to the Node.js proxy.
# The proxy handles Pyright spawn, PID management, and protocol routing.
set -euo pipefail
exec node "$(dirname "$0")/../dist/proxy.js" "$@"
