#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-merge-live-tick-corrupt-baseline-reply-verify.md 的判据。
#
# 判据（同时成立才算 PASS）：
#   1. 近 4 日内存在**已完成**的扫描日志（含 `scan done` 行，depth5 / trade 至少一份），
#      否则 INCONCLUSIVE；单份扫描约 6.5h，06:40 巡检时当日那份必然在写，故只看已完成的那天；
#   2. 该日生产扫描日志中 `ERR /data/tick` 命中数为 0；
#   3. 该日每份已完成的扫描日志都有 `known-baseline summary` 汇总行；
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

	# A full scan takes ~6.5h (11-19: 02:20 start, 11:38 depth5 done, 11:59
	# trade done), so the verify run right after the 06:40 audit always sees
	# today's log still being appended. Judging a half-written file either
	# FAILs on a missing summary line or counts a partial ERR total — and a
	# verdict that can never be PASS is worthless.
	#
	# Judge the newest day whose scans actually finished (`scan done` line),
	# walking back up to 3 days. That keeps one fully completed scan behind
	# every verdict while still refusing to grade an in-flight file.
	local judge_day="" completed=() in_flight=0 scans=() file candidate
	local offset day_scans day_completed day_in_flight
	for offset in 0 1 2 3; do
		candidate="$(date -u -d "-${offset} day" +%Y%m%d)"
		shopt -s nullglob
		day_scans=("$TARGET"/log/app/scan-depth5-corrupt."${candidate}"T*.log "$TARGET"/log/app/scan-trade-corrupt."${candidate}"T*.log)
		shopt -u nullglob
		day_completed=()
		day_in_flight=0
		for file in "${day_scans[@]}"; do
			if rg -q 'scan done' "$file" 2>/dev/null; then
				day_completed+=("$file")
			else
				day_in_flight=$((day_in_flight + 1))
			fi
		done
		if [[ ${#day_completed[@]} -gt 0 ]]; then
			judge_day="$candidate"
			scans=("${day_scans[@]}")
			completed=("${day_completed[@]}")
			in_flight="$day_in_flight"
			break
		fi
	done

	if [[ ${#scans[@]} -eq 0 ]]; then
		verdict="INCONCLUSIVE"
		reason="近 4 日无已完成扫描日志（cron 02:20 未运行，或每份扫描都仍在进行）"
		err_total=0
		summaries=0
	else
		err_total="$(count_pattern 'ERR /data/tick' "${completed[@]}")"
		summaries="$(count_pattern 'known-baseline summary' "${completed[@]}")"
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
			reason="${judge_day} 扫描仍有 $err_total 条 ERR /data/tick"
		elif [[ "$summaries" -lt ${#completed[@]} ]]; then
			verdict="FAIL"
			reason="汇总行缺失（completed=${#completed[@]} summaries=$summaries）"
		else
			verdict="PASS"
			reason="${judge_day} 的 ${#completed[@]} 份已完成扫描 ERR=0、汇总行齐全、基线 $entries 条（该日进行中 $in_flight 份）"
		fi
	fi

	{
		echo "[$(date -u +%FT%TZ)] verify merge-live-tick corrupt baseline"
		echo "target_head: $(git -C "$TARGET" log --oneline -1 2>/dev/null || echo unknown)"
		echo "today: $day"
		echo "judged_day: ${judge_day:-<none>}"
		echo "scan_logs: ${scans[*]:-<none>}"
		echo "baseline_entries: ${entries:-unreadable}"
		echo "err_lines: ${err_total:-0}"
		echo "summary_lines: ${summaries:-0}"
		echo "scans_completed: ${#completed[@]}"
		echo "scans_in_flight: ${in_flight}"
		echo "verdict: $verdict"
		echo "reason: $reason"
	} | tee -a "$log_file"

	[[ "$verdict" == "PASS" ]]
}

main
