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
# from a healthy run, so every failure path both logs a timestamped line and
# drops a digest into ./issues/, which the project monitor turns into a task.
fail() {
	printf '%s FAILED %s\n' "$(date -u +%FT%TZ)" "$1" >>"${LOG}"
	{
		printf '# 日志巡检执行失败 %s\n\n' "${STAMP}"
		printf -- '- 失败原因：%s\n' "$1"
		printf -- '- 运行日志：`log/log-audit-run.%s.log`\n' "${STAMP}"
		printf -- '- 处置：修复环境后手动重跑 `scripts/daily-log-audit.sh`\n'
	} >"${ROOT}/issues/log-audit-FAILED-${STAMP}.md" 2>/dev/null
	exit 0
}

mkdir -p "${ROOT}/log" "${ROOT}/audit/reports" || exit 0

[[ -x "${NODE}" ]] || fail "node not executable: ${NODE}"
[[ -f "${SCRIPT}" ]] || fail "audit script missing: ${SCRIPT}"

cd "${ROOT}" || fail "cannot cd into ${ROOT}"

# A second concurrent run would rewrite the same report and state files, so the
# slower one silently discards the faster one's findings. One instance only:
# the extra run logs a line and leaves the schedule to the holder.
exec 9>"${ROOT}/audit/.run.lock"
if ! flock -n 9; then
	printf '%s INFO skipped: another audit run holds the lock\n' "$(date -u +%FT%TZ)" >>"${LOG}"
	exit 0
fi

# Bracketing every run with UTC timestamps is what proves the 06:40 crontab
# entry actually fired: the audit's own output lines carry no clock, so a manual
# rerun would otherwise be indistinguishable from the scheduled one.
printf '%s INFO start audit day=%s\n' "$(date -u +%FT%TZ)" "${STAMP}" >>"${LOG}"
"${NODE}" "${SCRIPT}" >>"${LOG}" 2>&1
status=$?
printf '%s INFO audit finished rc=%s\n' "$(date -u +%FT%TZ)" "${status}" >>"${LOG}"
if [[ ${status} -ge 128 ]]; then
	# Killed by an operator (SIGTERM/SIGINT) or the supervisor: the environment
	# is fine, so a FAILED digest would be a false task.
	printf '%s INFO interrupted by signal %s\n' "$(date -u +%FT%TZ)" "$((status - 128))" >>"${LOG}"
elif [[ ${status} -ne 0 ]]; then
	fail "audit script exited ${status}"
fi

# Per-defect verification scripts run right after the audit, so a receiver's fix
# is proven (or refuted) on the same day without adding a second cron entry.
# Each script is zero-argument and owns its own verdict; a FAIL here is data,
# not a monitoring failure, so it never trips fail().
for verify in "${ROOT}"/scripts/verify-*.sh; do
	[[ -x "${verify}" ]] || continue
	printf '%s INFO verify start %s\n' "$(date -u +%FT%TZ)" "$(basename "${verify}")" >>"${LOG}"
	if "${verify}" >>"${LOG}" 2>&1; then
		printf '%s INFO verify PASS %s\n' "$(date -u +%FT%TZ)" "$(basename "${verify}")" >>"${LOG}"
	else
		printf '%s INFO verify FAIL %s\n' "$(date -u +%FT%TZ)" "$(basename "${verify}")" >>"${LOG}"
	fi
done

exit 0
