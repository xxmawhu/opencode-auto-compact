#!/bin/bash
# Daily log audit entry point for the 30-day error-cleanup monitoring.
#
# Contract:
#   - zero arguments, zero environment variables (all values hardcoded)
#   - always exits 0: a monitor must never fail the scheduler
#   - writes the report to ./audit/reports/, state to ./audit/state.json
#   - full stdout+stderr to ./log/log-audit-run.YYYYMMDD.log
#
# Trigger: crontab (`~/.local/bin/CRONTAB add -f scripts/daily-log-audit.sh`).
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
NODE="/usr/bin/node"
SCRIPT="${ROOT}/scripts/audit-ai-logs.mjs"
STAMP="$(date +%Y%m%d)"
LOG="${ROOT}/log/log-audit-run.${STAMP}.log"

# A monitoring wrapper that exits 0 on a broken environment is indistinguishable
# from a healthy run, so every failure path writes a timestamped line first.
fail() {
	printf '%s FAILED %s\n' "$(date -u +%FT%TZ)" "$1" >>"${LOG}"
	exit 0
}

mkdir -p "${ROOT}/log" "${ROOT}/audit/reports" || exit 0

[[ -x "${NODE}" ]] || fail "node not executable: ${NODE}"
[[ -f "${SCRIPT}" ]] || fail "audit script missing: ${SCRIPT}"

cd "${ROOT}" || fail "cannot cd into ${ROOT}"

"${NODE}" "${SCRIPT}" >>"${LOG}" 2>&1

exit 0
