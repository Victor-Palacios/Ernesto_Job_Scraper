#!/usr/bin/env bash
# Scheduled entry point (launchd/cron): refresh the scraped jobs, then run the
# applier. Extra arguments pass through, e.g. `auto_apply/run.sh --submit`.
set -euo pipefail
cd "$(dirname "$0")/.."
# Schedulers start with a bare PATH; node and claude must be findable.
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"
STATE="${AUTOAPPLY_HOME:-$HOME/.job-autoapply}"
mkdir -p "$STATE" && chmod 700 "$STATE"
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') run.sh $*"
  git pull --ff-only --quiet || echo "git pull failed; using the local all_jobs.json"
  node auto_apply/cli.mjs run "$@"
} >> "$STATE/run.log" 2>&1
