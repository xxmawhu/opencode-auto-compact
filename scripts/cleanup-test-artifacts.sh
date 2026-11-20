#!/bin/bash
# Remove leftover TEST-mode artifacts from ./issues and ./audit.
#
# Why this exists: scripts/check-issue-status.sh writes TEST-suffixed artifacts
# when RAISE_OVERRIDE is set. The digest header states its statuses are
# fabricated ("不可作为修复证据"), but the table still lists 32 real ledger ids and
# is structurally identical to a real transition record. The owning test removes
# them in a finally block (tests/issue-status-snapshot.test.mjs), yet an
# interrupted test (Ctrl-C, timeout, OOM) skips that block, and the daily triage
# reads issues/*.md — so a leftover would be mistriaged as real evidence and
# could close entries that are still verifying (2026-11-19 analysis).
#
# Contract: zero arguments, zero environment variables, always exits 0.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
STAMP="$(date +%Y%m%d)"
LOG="${ROOT}/log/cleanup-test-artifacts.${STAMP}.log"

log_line() {
	printf '%s [info] %s\n' "$(date -u +%FT%TZ)" "$*" >>"${LOG}"
}

mkdir -p "${ROOT}/log" || exit 0

shopt -s nullglob
leftovers=(
	"${ROOT}"/issues/issue-status-change-TEST-*.md
	"${ROOT}"/audit/issue-status-change-TEST-*.md
	"${ROOT}"/audit/issue-status-snapshot-TEST*.txt
)
shopt -u nullglob

if [[ ${#leftovers[@]} -eq 0 ]]; then
	log_line "no leftover TEST artifacts"
	exit 0
fi

# basenames keep the log line readable and prove which files were touched.
names=()
for file in "${leftovers[@]}"; do
	names+=("${file##*/}")
done
log_line "remove ${#leftovers[@]} leftover TEST artifacts (stub-generated, not evidence): ${names[*]}"
rm -f -- "${leftovers[@]}"
exit 0
