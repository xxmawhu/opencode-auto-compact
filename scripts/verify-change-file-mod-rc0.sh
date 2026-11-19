#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-change-file-mod-root-error-issue.md 的判据，
# 对应 issue 3a710ccc-03b7-4b40-913a-1c4e786e7f11（日链 85 天 0 次 rc=0）。
#
# 判据（同时成立才算 PASS）：
#   1. 最近一次 `[main-task-daily] end rc=` 的日期是**今天**（UTC），否则 INCONCLUSIVE
#      —— cron 03:00 未跑或日志未更新时，任何结论都不成立；
#   2. 该日块的 `rc=0`（A/B/C 任一方案都必须让日链以成功结束）；
#   3. 该日的 `_ensure_root` 不再以 ERROR 记录（降级为 WARNING 属可接受的收口方式）。
#
# 只读目标项目，日志落本项目 ./log/ 一级目录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=/mnt/beegfs_data/usr/maxx/dev/shell-tools/change-file-mod/change-file-mod
CRON_LOG="$TARGET/log/app/main-task-cron.log"
LOG_DIR="$PROJECT_ROOT/log"

main() {
	if [[ ! -f "$CRON_LOG" ]]; then
		echo "[ERROR] cron log missing: $CRON_LOG" >&2
		exit 2
	fi

	local day log_file end_line end_date end_day end_rc err_lines verdict reason
	day="$(date -u +%Y%m%d)"
	# Bash 日志按天落 ./log/ 一级目录（log-error-review）；同日多次运行追加，
	# 每次以 `[时间] verify ...` 行分隔。
	log_file="$LOG_DIR/verify-change-file-mod-rc0.$day.log"
	mkdir -p "$LOG_DIR"

	# 最后一条 end 行给出该次运行的日期与退出码；`rc=` 后一位数字足够，
	# 该脚本的 rc 只取 0/1。日期用正则提取：end 行既可能是
	# `2026-11-19T03:00:05+00:00 [main-task-daily] end rc=1`，也可能是
	# `[2026-11-19T03:00:05+00:00] [main-task-daily] end rc=1`，取前 10 个字符
	# 会被前导 `[` 打乱（固定用例测试即因此判成 2026111）。
	end_line="$(rg -a 'main-task-daily\] end rc=[0-9]+' "$CRON_LOG" 2>/dev/null | tail -1)"
	end_date="$(printf '%s' "$end_line" | rg -o '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)"
	end_day="${end_date//-/}"
	end_rc="${end_line##*rc=}"
	end_rc="${end_rc:0:1}"

	# 同日 ERROR 计数：只统计该日块内的行，避免历史行让判据永远不 PASS。
	err_lines=0
	if [[ -n "$end_date" ]]; then
		err_lines="$(rg -a -e "^${end_date}.*\\| ERROR.*_ensure_root" \
			-e "^\\[${end_date}.*\\| ERROR.*_ensure_root" "$CRON_LOG" 2>/dev/null | wc -l)"
	fi

	verdict=""
	reason=""
	if [[ -z "$end_line" ]]; then
		verdict="FAIL"
		reason="日志中没有任何 main-task-daily end 行（cron 条目可能已被删除）"
	elif [[ "$end_day" != "$day" ]]; then
		verdict="INCONCLUSIVE"
		reason="最近一次日链在 ${end_day}，今日 ${day} 尚未运行（03:00 cron 未触发或日志未更新）"
	elif [[ "$end_rc" != "0" ]]; then
		verdict="FAIL"
		reason="今日日链仍以 rc=${end_rc} 结束：$(printf '%s' "$end_line" | cut -c1-160)"
	elif [[ "${err_lines:-0}" -gt 0 ]]; then
		verdict="FAIL"
		reason="今日 rc=0 但仍有 ${err_lines} 条 _ensure_root ERROR（应降级 WARNING）"
	else
		verdict="PASS"
		reason="今日 ${day} 日链 rc=0，且当日无 _ensure_root ERROR"
	fi

	{
		echo "[$(date -u +%FT%TZ)] verify change-file-mod daily chain rc"
		echo "cron_log: $CRON_LOG"
		echo "last_end_line: ${end_line:-<none>}"
		echo "judged_day: ${end_day:-<none>}"
		echo "judged_rc: ${end_rc:-<none>}"
		echo "same_day_error_lines: ${err_lines:-0}"
		echo "verdict: $verdict"
		echo "reason: $reason"
	} | tee -a "$log_file"

	[[ "$verdict" == "PASS" ]]
}

main
