#!/usr/bin/env bash
# Owner runbook for repointing the required status checks — see required-checks.ts.
#   scripts/ci-cd/required-checks.sh print --branch main --json > ~/main-checks.json   # review it
#   scripts/ci-cd/required-checks.sh --add quality-status --branch main --expect ~/main-checks.json
set -u
exec bun "$(dirname "$0")/required-checks.ts" "$@"
