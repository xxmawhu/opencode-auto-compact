#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-merge-live-tick-corrupt-baseline-reply-verify.md 的判据。
#
# 判据（同时成立才算 PASS）：
#   1. 当日存在扫描日志（depth5 / trade 至少一份），否则 INCONCLUSIVE（02:20 cron 未跑）；
#   2. 当日生产扫描日志中 `ERR /data/tick` 命中数为 0；
#   3. 每份存在的扫描日志都有 `known-baseline summary` 汇总行；
#   4. `config/corrupt-baseline.json` 可解析且条目数 > 0。
# `scan-verify-*.log` 是脚本自测用例（负向用例故意产生 [NEW]），不参与判定。
# 只读目标项目，日志落本项目 ./log/ 一级目录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=/mnt/beegfs_data/usr/maxx/quant/data/merge-live-tick/merge-live-tick
LOG_DIR="$PROJECT_ROOT/log"

count_pattern() {
	local pattern="$1"
	shift
	local total=0 n file
	for file in "$@"; do
		n="$(rg -c -e "$pattern" "$file" 2>/dev/null || true)"
		total=$((total + ${n:-0}))
	done
	echo "$total"
}

main() {
	if [[ ! -d "$TARGET" ]]; then
		echo "[ERROR] target project missing: $TARGET" >&2
		exit 2
	fi

	local day stamp log_file baseline entries err_total summaries scans verdict reason
	day="$(date -u +%Y%m%d)"
	stamp="$(date -u +%Y%m%dT%H%M%S)"
	log_file="$LOG_DIR/verify-merge-live-tick-corrupt.$stamp.log"
	mkdir -p "$LOG_DIR"

	# Defaults must exist before the branch: an unset local trips `set -u` on the
	# verdict checks below when the scan logs are present.
	verdict=""
	reason=""
	err_total=0
	summaries=0

	shopt -s nullglob
	local scans=("$TARGET"/log/app/scan-depth5-corrupt."${day}"T*.log "$TARGET"/log/app/scan-trade-corrupt."${day}"T*.log)
	shopt -u nullglob

	if [[ ${#scans[@]} -eq 0 ]]; then
		verdict="INCONCLUSIVE"
		reason="当日无扫描日志（cron 02:20 未运行或仍在跑）"
		err_total=0
		summaries=0
	else
		err_total="$(count_pattern 'ERR /data/tick' "${scans[@]}")"
		summaries="$(count_pattern 'known-baseline summary' "${scans[@]}")"
	fi

	baseline="$TARGET/config/corrupt-baseline.json"
	if [[ -f "$baseline" ]]; then
		entries="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("entries", [])))' "$baseline" 2>/dev/null || true)"
	else
		entries=""
	fi
	if [[ ! "$entries" =~ ^[0-9]+$ ]]; then
		entries=""
	fi

	if [[ "$verdict" != "INCONCLUSIVE" ]]; then
		if [[ -z "$entries" || "$entries" -le 0 ]]; then
			verdict="FAIL"
			reason="基线文件缺失或条目数为 0（entries=${entries:-unreadable}）"
		elif [[ "$err_total" -gt 0 ]]; then
			verdict="FAIL"
			reason="当日扫描仍有 $err_total 条 ERR /data/tick"
		elif [[ "$summaries" -lt ${#scans[@]} ]]; then
			verdict="FAIL"
			reason="汇总行缺失（scans=${#scans[@]} summaries=$summaries）"
		else
			verdict="PASS"
			reason="当日 ${#scans[@]} 份扫描日志 ERR=0、汇总行齐全、基线 $entries 条"
		fi
	fi

	{
		echo "[$(date -u +%FT%TZ)] verify merge-live-tick corrupt baseline"
		echo "target_head: $(git -C "$TARGET" log --oneline -1 2>/dev/null || echo unknown)"
		echo "day: $day"
		echo "scan_logs: ${scans[*]:-<none>}"
		echo "baseline_entries: ${entries:-unreadable}"
		echo "err_lines: ${err_total:-0}"
		echo "summary_lines: ${summaries:-0}"
		echo "verdict: $verdict"
		echo "reason: $reason"
	} | tee -a "$log_file"

	[[ "$verdict" == "PASS" ]]
}

main
