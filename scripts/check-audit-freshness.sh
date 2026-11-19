#!/bin/bash
# Daily guard for the 30-day log audit.
#
# The audit itself runs from crontab at 06:40 and is fail-loud: a failed run
# writes ./issues/log-audit-FAILED-<day>.md. But if the crontab entry is lost
# (host rebuild, crontab reset, user migration) nothing runs at all, so no
# FAILED digest is ever written and the monitoring lapses silently.
#
# This job only checks that today's report exists and drops an issue digest
# when it does not. Zero arguments, zero environment variables, always exits 0:
# a monitoring job must never fail the scheduler.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
STAMP="$(date +%Y%m%d)"
REPORT="${ROOT}/audit/reports/log-audit.${STAMP}.md"
LOG="${ROOT}/log/log-audit-freshness.${STAMP}.log"
DIGEST="${ROOT}/issues/log-audit-STALE-${STAMP}.md"

log_line() {
	local level="$1"
	shift
	printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "${level}" "$*" >>"${LOG}"
}

write_digest() {
	local tmp
	tmp="$(mktemp "${DIGEST}.tmp.XXXXXX")" || return 1
	{
		printf '# 日志巡检 %s 未产出\n\n' "${STAMP}"
		printf -- '- 期望报告：`audit/reports/log-audit.%s.md`\n' "${STAMP}"
		printf -- '- 检查日志：`log/log-audit-freshness.%s.log`\n' "${STAMP}"
		printf -- '- 可能原因：crontab 06:40 条目丢失、主机重启后 crontab 未加载、脚本被移动\n'
		printf -- '- 处置：确认 `~/.local/bin/CRONTAB query` 含 `scripts/daily-log-audit.sh`，'
		printf '恢复条目后重跑该脚本；30 天监测期内不得断档\n'
	} >"${tmp}" || {
		rm -f "${tmp}"
		return 1
	}
	mv -f "${tmp}" "${DIGEST}"
}

main() {
	mkdir -p "${ROOT}/log" "${ROOT}/issues" || exit 0

	if [[ -f "${REPORT}" ]]; then
		log_line info "OK report present: ${REPORT}"
		exit 0
	fi

	log_line error "FAILED report missing: ${REPORT}"
	write_digest || log_line error "FAILED cannot write digest: ${DIGEST}"
	exit 0
}

main "$@"
