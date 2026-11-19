#!/bin/bash
# 13:00 第二次巡检：同一天再跑一遍完整审计，只为拿到「今天已经写完整的扫描日志」。
#
# 为什么需要：merge-live-tick 等项目的全量扫描 02:20 起跑、约 6.5h（11-19 实测
# depth5 11:38 完成、trade 11:59 完成）。06:40 那次巡检读到的是写了一半的日志，
# 无法证明「修复后一整个扫描周期都没新增 ERROR」；13:00 这次两份扫描都已收尾，
# 判定才有完整证据。结果同样落 ./log/ 与 audit/reports/。
#
# 零参数、零环境变量；与 06:40 主巡检共用 daily-log-audit.sh（含 verify 与
# close-verified-issues.sh 链路），因此台账关闭在 13:00 也能发生。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "${SCRIPT_DIR}/daily-log-audit.sh"
