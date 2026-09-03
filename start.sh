#!/usr/bin/env bash
set -Eeuo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/codespaces-start.sh"
