#!/bin/bash
# Zero-argument ledger transition: close `verifying` issues once the daily report
# proves their project reached zero error lines on/after a fixed date.
#
# Why this exists: every verifying issue needs the same closing step ("read
# tomorrow's report, if the project is 0, set closed"). Leaving that to a human
# or to whichever agent happens to be awake breaks the 30-day loop — the audit
# would keep running while the ledger silently stays at `verifying` forever.
#
# Entry contract (audit/pending-issues.json):
#   "closeWhen": { "project": "<report row>", "dir": "<abs project dir>",
#                  "from": "<YYYYMMDD>", "requireVerify": "<repo-relative script>" }
# An entry is closed only when ALL of the following hold, so a vanished,
# renamed or silently-broken project cannot be mistaken for a clean one:
#   1. today (UTC) >= from                  — the out-of-window date has passed
#   2. the project directory still exists    — it was not deleted or moved
#   3. today's report shows 0 error lines    — an absent row counts as 0
#      (the report only lists projects WITH error lines)
#   4. if `requireVerify` is set, that zero-argument script exits 0. A project
#      can log nothing because it is fixed — or because its writer died, or
#      because the report sampled a scan that had barely started. The report
#      alone cannot tell those apart, so entries whose evidence needs more than
#      "no error lines today" name their verification script here.
#
# Zero arguments, zero environment variables, always exits 0: a monitoring job
# must never fail the scheduler. Full output goes to ./log/ one level deep.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
NODE="/usr/bin/node"
LEDGER="${ROOT}/audit/pending-issues.json"
STAMP="$(date -u +%Y%m%d)"
LOG="${ROOT}/log/close-verified-issues.${STAMP}.log"
REPORT="${ROOT}/audit/reports/log-audit.${STAMP}.md"

log_line() {
	printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"${LOG}"
}

# The markdown parse and the atomic ledger replace live in one node module so a
# half-written ledger is impossible: the module writes next to the target (same
# filesystem, so rename is atomic) and renames over it.
close_entries() {
	"${NODE}" "${ROOT}/scripts/close-verified-issues.mjs" \
		"${LEDGER}" "${REPORT}" "${STAMP}" "${ROOT}" "${ROOT}" >>"${LOG}" 2>&1
}

main() {
	mkdir -p "${ROOT}/log" || return 0

	if [[ ! -f "${LEDGER}" ]]; then
		log_line error "ledger missing: ${LEDGER}"
		return 0
	fi

	if [[ ! -f "${REPORT}" ]]; then
		log_line info "no report for ${STAMP}, nothing to close"
		return 0
	fi

	if [[ ! -x "${NODE}" ]]; then
		log_line error "node not executable: ${NODE}"
		return 0
	fi

	if close_entries; then
		log_line info "done"
	else
		log_line error "node exited $?"
	fi

	return 0
}

main "$@"
