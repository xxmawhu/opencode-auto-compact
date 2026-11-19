#!/bin/bash
# Daily guard for the 30-day log audit.
#
# The audit itself runs from crontab at 06:40 and is fail-loud: a failed run
# writes ./issues/log-audit-FAILED-<day>.md. But if the crontab entry is lost
# (host rebuild, crontab reset, user migration) nothing runs at all, so no
# FAILED digest is ever written and the monitoring lapses silently.
#
# This job checks that today's report exists and that every entry of the 30-day
# loop is still scheduled, then drops an issue digest for whatever is missing.
# Zero arguments, zero environment variables, always exits 0: a monitoring job
# must never fail the scheduler.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
STAMP="$(date +%Y%m%d)"
REPORT="${ROOT}/audit/reports/log-audit.${STAMP}.md"
LOG="${ROOT}/log/log-audit-freshness.${STAMP}.log"
DIGEST="${ROOT}/issues/log-audit-STALE-${STAMP}.md"
CRON_DIGEST="${ROOT}/issues/log-audit-cron-missing-${STAMP}.md"

# Losing a single crontab entry keeps the other jobs running, so the missing
# one produces no failure of its own. Each entry below is required for the
# 30-day loop to be complete.
REQUIRED_ENTRIES=(
	"scripts/daily-log-audit.sh"
	"scripts/check-audit-freshness.sh"
	"scripts/check-issue-status.sh"
)

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

write_cron_digest() {
	local tmp
	tmp="$(mktemp "${CRON_DIGEST}.tmp.XXXXXX")" || return 1
	{
		printf '# 日志巡检 crontab 条目缺失 %s\n\n' "${STAMP}"
		printf -- '- 检查日志：`log/log-audit-freshness.%s.log`\n' "${STAMP}"
		printf -- '- 缺失条目：\n'
		printf -- '  - `%s`\n' "$@"
		printf -- '- 影响：缺失的每日任务不再运行，30 天监测出现断档且无失败提示\n'
		printf -- '- 处置：`~/.local/bin/CRONTAB add -f <脚本> -H <时> -m <分>` 恢复条目，'
		printf '再跑 `~/.local/bin/CRONTAB query` 确认三条齐全\n'
	} >"${tmp}" || {
		rm -f "${tmp}"
		return 1
	}
	mv -f "${tmp}" "${CRON_DIGEST}"
}

# Prints the required entries that are absent from the current crontab.
missing_entries() {
	local listing entry
	listing="$(crontab -l 2>/dev/null)" || true
	for entry in "${REQUIRED_ENTRIES[@]}"; do
		if ! grep -Fq "${entry}" <<<"${listing}"; then
			printf '%s\n' "${entry}"
		fi
	done
}

main() {
	mkdir -p "${ROOT}/log" "${ROOT}/issues" || exit 0

	if [[ -f "${REPORT}" ]]; then
		log_line info "OK report present: ${REPORT}"
	else
		log_line error "FAILED report missing: ${REPORT}"
		write_digest || log_line error "FAILED cannot write digest: ${DIGEST}"
	fi

	local -a missing=()
	mapfile -t missing < <(missing_entries)
	if [[ ${#missing[@]} -eq 0 ]]; then
		log_line info "OK all ${#REQUIRED_ENTRIES[@]} crontab entries present"
		exit 0
	fi

	log_line error "FAILED crontab entries missing: ${missing[*]}"
	write_cron_digest "${missing[@]}" ||
		log_line error "FAILED cannot write digest: ${CRON_DIGEST}"
	exit 0
}

main "$@"
