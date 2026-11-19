#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-get-task-from-notion-502.md 的「修复后归零」判据。
#
# 判据（三者同时成立才算 PASS）：
#   1. 今日 task_<day>.log 覆盖 >= 3 个不同分钟，说明 daemon 至少跑过 3 轮；
#   2. 今日 error_<day>.log 中 `status: 5xx` 命中数为 0；
#   3. 今日 error_<day>.log 中 `list_comments:569` 命中数为 0（含 Errno 104 等网络瞬态）。
# 只读目标项目（不写入对方目录），日志落本项目 ./log/ 一级目录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=/mnt/beegfs_data/usr/maxx/dev/agents-tools/get-task-from-notion/get-task-from-notion
LOG_DIR="$PROJECT_ROOT/log"

count_matches() {
	local pattern="$1"
	local file="$2"
	local n
	if [[ ! -f "$file" ]]; then
		echo 0
		return
	fi
	# rg -c prints the per-file line count; with no match it prints nothing and
	# exits 1, so the default covers that branch.
	n="$(rg -c -e "$pattern" "$file" 2>/dev/null || true)"
	echo "${n:-0}"
}

# A "cycle" is a distinct minute in which the daemon logged Notion page work.
# run_cycle emits one line per page, so distinct minutes are the closest
# zero-config proxy for "the daemon has run this many times today".
count_cycles() {
	local file="$1"
	local n
	if [[ ! -f "$file" ]]; then
		echo 0
		return
	fi
	n="$(rg -oN -e '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}' "$file" 2>/dev/null | sort -u | wc -l)"
	echo "${n// /}"
}

main() {
	if [[ ! -d "$TARGET" ]]; then
		echo "[ERROR] target project missing: $TARGET" >&2
		exit 2
	fi

	local day stamp log_file today_error_log today_task_log
	day="$(date -u +%Y-%m-%d)"
	stamp="$(date -u +%Y%m%dT%H%M%S)"
	log_file="$LOG_DIR/verify-get-task-from-notion-502.$stamp.log"
	today_error_log="$TARGET/log/error_$day.log"
	today_task_log="$TARGET/log/task_$day.log"

	mkdir -p "$LOG_DIR"

	local five_xx_today list_comments_today cycles_today
	five_xx_today="$(count_matches 'status: 5[0-9][0-9]' "$today_error_log")"
	list_comments_today="$(count_matches 'list_comments:569' "$today_error_log")"
	cycles_today="$(count_cycles "$today_task_log")"

	local five_xx_all=0 list_comments_all=0 f
	for f in "$TARGET"/log/error_*.log; do
		[[ -f "$f" ]] || continue
		five_xx_all=$((five_xx_all + $(count_matches 'status: 5[0-9][0-9]' "$f")))
		list_comments_all=$((list_comments_all + $(count_matches 'list_comments:569' "$f")))
	done

	local verdict="FAIL" reason
	if [[ "$five_xx_today" -gt 0 || "$list_comments_today" -gt 0 ]]; then
		reason="今日仍有 ERROR 命中（5xx=$five_xx_today, list_comments:569=$list_comments_today）"
	elif [[ "$cycles_today" -lt 3 ]]; then
		verdict="INCONCLUSIVE"
		reason="今日 cycle 数 $cycles_today < 3，样本不足"
	else
		verdict="PASS"
		reason="今日 cycle 数 $cycles_today >= 3，且两条签名均为 0"
	fi

	{
		echo "[$(date -u +%FT%TZ)] verify get-task-from-notion 502 log level"
		echo "target_head: $(git -C "$TARGET" log --oneline -1 2>/dev/null || echo unknown)"
		echo "day: $day"
		echo "cycles_today: $cycles_today"
		echo "five_xx_today: $five_xx_today"
		echo "list_comments_569_today: $list_comments_today"
		echo "five_xx_all_time: $five_xx_all"
		echo "list_comments_569_all_time: $list_comments_all"
		echo "verdict: $verdict"
		echo "reason: $reason"
	} | tee -a "$log_file"

	[[ "$verdict" == "PASS" ]]
}

main "$@"
