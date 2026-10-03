#!/usr/bin/env bash
# The exact-state aggregator behind a filtered PR gate's status job: green only when the filter's
# verdict and the gated jobs' result agree. Not a failure denylist — a job that never ran must not
# read as green, and a filter that produced no verdict is an error, never a skip.
#
#   aggregate-status.sh <changes-result> <run> <gated-result>
#     <changes-result>  the `changes` job's result (success | failure | cancelled | skipped)
#     <run>             its `run` output: "true" or "false"
#     <gated-result>    the gated job's result (success | failure | cancelled | skipped)
set -u

changes=${1:-}
run=${2:-}
gated=${3:-}

if [ "$changes" != "success" ]; then
  echo "::error::Detect changes did not succeed: '$changes'"
  exit 1
fi
case "$run" in
  true) want="success" ;;
  false) want="skipped" ;;
  *) echo "::error::changes.outputs.run is not true/false: '$run'"; exit 1 ;;
esac
if [ "$gated" != "$want" ]; then
  echo "::error::filter said run=$run, so the gated jobs must be '$want' — got '$gated'"
  exit 1
fi
echo "Gate passed (or was skipped — no relevant changes)."
