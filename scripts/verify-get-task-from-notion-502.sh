#!/usr/bin/env bash
# 零参数验证脚本：plan/20261119-get-task-from-notion-502-reply-verify.md 的验收判据。
#
# 判据（同时成立才算 PASS）：
#   1. 修复提交（`FIX_COMMIT`）之后，daemon 覆盖 >= 3 个不同分钟；
#   2. 修复提交之后，`status: 5xx` 命中数为 0；
#   3. 修复提交之后，`list_comments:569` 命中数为 0（含 Errno 104 等网络瞬态）。
# 修复前的历史行单独打印为 pre_*，不计入判定 —— 否则已修项目会因窗口内的旧行永久 FAIL。
# 日志按小时分片读取（`task_YYYYMMDDTHH.log`），只取不早于修复日的前一日至今的分片。
# 只读目标项目，日志落本项目 ./log/ 一级目录。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET=/mnt/beegfs_data/usr/maxx/dev/agents-tools/get-task-from-notion/get-task-from-notion
LOG_DIR="$PROJECT_ROOT/log"

# The commit that actually changed the two log signatures (issues 2cfa1e52 /
# a29225ae): 5xx demoted to a transient warning, list_comments:569 demoted.
#
# RATIONALE (2026-11-27): this anchor used to be `git log -1` (HEAD). Every
# unrelated commit in the target repo then moved the window forward and reset
# the 3-cycle sample, so the gate reported "INCONCLUSIVE, 0 cycles" forever even
# though the fix was long in place — a verification that can never pass is
# indistinguishable from one that never ran. Pinning the fix commit makes the
# window monotonic: it only ever grows.
FIX_COMMIT=b68e7b6

main() {
  if [[ ! -d "$TARGET" ]]; then
    echo "[ERROR] target project missing: $TARGET" >&2
    exit 2
  fi

  local day stamp log_file fix_iso fix_epoch
  day="$(date -u +%Y%m%d)"
  stamp="$(date -u +%Y%m%dT%H%M%S)"
  log_file="$LOG_DIR/verify-get-task-from-notion-502.$stamp.log"

  mkdir -p "$LOG_DIR"

  fix_iso="$(git -C "$TARGET" log -1 --format=%cI "$FIX_COMMIT" 2>/dev/null || true)"
  if [[ -z "$fix_iso" ]]; then
    echo "[ERROR] cannot read fix commit $FIX_COMMIT in $TARGET" >&2
    exit 2
  fi
  fix_epoch="$(date -u -d "$fix_iso" +%s)"

  # Undated continuation lines (Traceback frames) inherit the previous line's
  # timestamp, matching how the audit dates them. Without that inheritance a
  # frame's mtime would fake a fresh error after the fix.
  local stats pre_5xx pre_lc after_5xx after_lc cycles
  stats="$(
    python3 - "$TARGET/log" "$fix_epoch" <<'PY'
import calendar
import datetime
import os
import re
import sys
import time

log_dir, fix_epoch = sys.argv[1], int(sys.argv[2])
stamp = re.compile(r"^\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})")
# The target project rotates hourly (`task_YYYYMMDDTHH.log`, see its
# main_task.configure_logging). Reading a single `task_<day>.log` therefore
# silently matched nothing after the 2026-11-21 switch: every run degraded to
# "0 cycles, INCONCLUSIVE" and the gate could never pass. Collect every hourly
# shard whose filename date is not older than the fix day, plus loguru's
# rotation leftovers (`task_20261126T14.2026-11-26_14-18-28_000000.log`), which
# hold records written before the rollover and are not duplicates.
NAME_DATE = re.compile(r"^(?:task|error)_(\d{4})-?(\d{2})-?(\d{2})")
fix_day = datetime.datetime.fromtimestamp(fix_epoch, datetime.timezone.utc).date() - datetime.timedelta(days=1)


def shards(prefix):
    found = []
    if not os.path.isdir(log_dir):
        return found
    for name in sorted(os.listdir(log_dir)):
        if not name.startswith(prefix):
            continue
        match = NAME_DATE.match(name)
        if not match:
            continue
        try:
            day = datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            continue
        if day >= fix_day:
            found.append(os.path.join(log_dir, name))
    return found


def epoch_of(year, clock):
    return calendar.timegm(time.strptime(f"{year} {clock}", "%Y-%m-%d %H:%M:%S"))


def scan(paths, patterns):
    """Return per-pattern (pre, after) counts and the minutes seen after the fix."""
    counts = {name: [0, 0] for name in patterns}
    minutes = set()
    for path in paths:
        last = None
        with open(path, errors="replace") as handle:
            for line in handle:
                match = stamp.match(line)
                if match:
                    last = epoch_of(match.group(1), match.group(2))
                    if last > fix_epoch:
                        minutes.add(last // 60)
                if last is None:
                    continue
                slot = 1 if last > fix_epoch else 0
                for name, rx in patterns.items():
                    if re.search(rx, line):
                        counts[name][slot] += 1
    return counts, minutes


PATTERNS = {"5xx": r"status: 5[0-9][0-9]", "lc": r"list_comments:569"}
counts, _ = scan(shards("error_"), PATTERNS)
_, minutes = scan(shards("task_"), {})
print(
    counts["5xx"][0],
    counts["lc"][0],
    counts["5xx"][1],
    counts["lc"][1],
    len(minutes),
)
PY
  )"
  read -r pre_5xx pre_lc after_5xx after_lc cycles <<<"$stats"
  # A malformed scan (python error, truncated file) must fail loudly: the
  # numeric comparisons below would otherwise report a spurious verdict.
  if [[ ! "$pre_5xx" =~ ^[0-9]+$ || ! "$after_5xx" =~ ^[0-9]+$ || ! "$cycles" =~ ^[0-9]+$ ]]; then
    echo "[ERROR] cannot parse scan output: ${stats:-<empty>}" >&2
    exit 2
  fi

  local verdict="FAIL" reason
  if [[ "$after_5xx" -gt 0 || "$after_lc" -gt 0 ]]; then
    reason="修复后仍有 ERROR（5xx=$after_5xx, list_comments:569=$after_lc）"
  elif [[ "$cycles" -lt 3 ]]; then
    verdict="INCONCLUSIVE"
    reason="修复后 cycle 数 $cycles < 3，样本不足"
  else
    verdict="PASS"
    reason="修复后 $cycles 个 cycle 内两条签名均为 0"
  fi

  {
    echo "[$(date -u +%FT%TZ)] verify get-task-from-notion 502 log level"
    echo "target_head: $(git -C "$TARGET" log --oneline -1 2>/dev/null || echo unknown)"
    echo "fix_commit: $FIX_COMMIT"
    echo "fix_time: $fix_iso"
    echo "day: $day"
    echo "pre_5xx: $pre_5xx"
    echo "pre_list_comments_569: $pre_lc"
    echo "after_5xx: $after_5xx"
    echo "after_list_comments_569: $after_lc"
    echo "cycles_after_fix: $cycles"
    echo "verdict: $verdict"
    echo "reason: $reason"
  } | tee -a "$log_file"

  [[ "$verdict" == "PASS" ]]
}

main
