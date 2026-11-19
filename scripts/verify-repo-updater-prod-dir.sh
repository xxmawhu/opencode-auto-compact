#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-repo-updater-prod-dir-missing-reply-verify.md 的判据 1~3。
#
# 判据（同时成立才算 PASS）：
#   1. 修复 commit 之后，watchdog 日志 `[ERROR]` 新增数为 0；
#   2. 修复 commit 之后，watchdog 至少完成 3 个 5 分钟周期（`complete` 行计数）；
#   3. 修复 commit 之后的运行输出不含 `MAXX needs to run` / `sudo -u` / `NOPASSWD` 人工步骤。
# 修复前的历史行单独打印为 pre_ERROR_lines，不计入判定。
# 项目级 24h error 数由审计库统计并打印（供次日报告对照），不参与本脚本判定 ——
# 窗口未滚动前该项目必然仍 >0，把它纳入判定会让已修项目在窗口内永久 FAIL。
# 只读目标项目，日志落本项目 ./log/ 一级目录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=/mnt/beegfs_data/usr/maxx/dev/shell-tools/repo-updater/repo-updater
FIX_COMMIT=9e1b44e
LOG_DIR="$PROJECT_ROOT/log"

main() {
	if [[ ! -d "$TARGET" ]]; then
		echo "[ERROR] target project missing: $TARGET" >&2
		exit 2
	fi

	local day stamp log_file fix_iso stats
	day="$(date -u +%Y-%m-%d)"
	stamp="$(date -u +%Y%m%dT%H%M%S)"
	log_file="$LOG_DIR/verify-repo-updater-prod-dir.$stamp.log"

	mkdir -p "$LOG_DIR"

	fix_iso="$(git -C "$TARGET" log -1 --format=%cI "$FIX_COMMIT" 2>/dev/null || true)"
	if [[ -z "$fix_iso" ]]; then
		echo "[ERROR] fix commit $FIX_COMMIT not found in $TARGET" >&2
		exit 2
	fi

	# SC2016: the single-quoted JavaScript deliberately keeps `${...}` for node
	# to expand, not the shell.
	# shellcheck disable=SC2016
	stats="$(node --input-type=module -e '
		import fs from "node:fs";
		const [dir, fixIso, day] = process.argv.slice(1);
		const fixMs = Date.parse(fixIso);
		// The watchdog rotates by day; today plus yesterday covers a fix made
		// just before midnight.
		const stampRe = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/;
		const files = [];
		for (const offset of [0, -1]) {
		  const d = new Date(Date.parse(day + "T00:00:00Z") + offset * 86400000);
		  files.push(`${dir}/log/cron/production-dir-watchdog.${d.toISOString().slice(0, 10).replaceAll("-", "")}.log`);
		}
		let pre = 0, after = 0, cycles = 0, manual = 0;
		for (const file of files) {
		  if (!fs.existsSync(file)) continue;
		  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		    const m = stampRe.exec(line);
		    if (!m) continue;
		    const ms = Date.parse(`${m[1]}T${m[2]}Z`);
		    if (ms <= fixMs) {
		      if (line.includes("[ERROR]")) pre += 1;
		      continue;
		    }
		    if (line.includes("[ERROR]")) after += 1;
		    if (line.includes("production-dir-watchdog complete")) cycles += 1;
		    if (/MAXX needs to run|sudo -u|NOPASSWD|sudo tee|\/etc\/sudoers/.test(line)) manual += 1;
		  }
		}
		console.log(pre, after, cycles, manual);
	' "$TARGET" "$fix_iso" "$day")"

	local pre after cycles manual verdict reason
	read -r pre after cycles manual <<<"$stats"
	if [[ ! "$pre" =~ ^[0-9]+$ || ! "$after" =~ ^[0-9]+$ || ! "$cycles" =~ ^[0-9]+$ ]]; then
		echo "[ERROR] cannot parse scan output: ${stats:-<empty>}" >&2
		exit 2
	fi

	if [[ "$after" -gt 0 ]]; then
		verdict="FAIL"
		reason="修复后仍有 $after 条 ERROR"
	elif [[ "$manual" -gt 0 ]]; then
		verdict="FAIL"
		reason="修复后仍有 $manual 行人工步骤/提权字样"
	elif [[ "$cycles" -lt 3 ]]; then
		verdict="INCONCLUSIVE"
		reason="修复后完成周期数 $cycles < 3，样本不足"
	else
		verdict="PASS"
		reason="修复后 $cycles 个周期无新增 ERROR 且无人工步骤"
	fi

	{
		echo "[$(date -u +%FT%TZ)] verify repo-updater production-dir watchdog"
		echo "target_head: $(git -C "$TARGET" log --oneline -1 2>/dev/null || echo unknown)"
		echo "fix_commit: $FIX_COMMIT @ $fix_iso"
		echo "day: $day"
		echo "pre_ERROR_lines: $pre"
		echo "after_ERROR_lines: $after"
		echo "cycles_after_fix: $cycles"
		echo "manual_step_lines_after_fix: $manual"
		echo "verdict: $verdict"
		echo "reason: $reason"
	} | tee -a "$log_file"

	[[ "$verdict" == "PASS" ]]
}

main
