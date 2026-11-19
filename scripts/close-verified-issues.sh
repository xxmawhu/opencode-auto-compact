#!/bin/bash
# Zero-argument ledger transition: close `verifying` issues once the daily report
# proves their project reached zero error lines on/after a fixed date.
#
# Why this exists: every verifying issue needs the same closing step ("read
# tomorrow's report, if the project is 0, set closed"). Leaving that to a human
# or to whichever agent happens to be awake breaks the 30-day loop — the audit
# would keep running while the ledger silently stays at `verifying` forever.
#
# Entry contract (audit/pending-issues.json):
#   "closeWhen": { "project": "<report row>", "dir": "<abs project dir>",
#                  "from": "<YYYYMMDD>" }
# An entry is closed only when ALL of the following hold, so a vanished or
# renamed project cannot be mistaken for a clean one:
#   1. today (UTC) >= from                  — the out-of-window date has passed
#   2. the project directory still exists    — it was not deleted or moved
#   3. today's report shows 0 error lines    — an absent row counts as 0
#      (the report only lists projects WITH error lines)
#
# Zero arguments, zero environment variables, always exits 0: a monitoring job
# must never fail the scheduler. Full output goes to ./log/ one level deep.
set -uo pipefail

ROOT="/mnt/beegfs_data/usr/maxx/dev/agents-tools/plugin/opencode-auto-compact"
NODE="/usr/bin/node"
LEDGER="${ROOT}/audit/pending-issues.json"
STAMP="$(date -u +%Y%m%d)"
LOG="${ROOT}/log/close-verified-issues.${STAMP}.log"
REPORT="${ROOT}/audit/reports/log-audit.${STAMP}.md"

log_line() {
	printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"${LOG}"
}

# The markdown table parse and the atomic ledger replace live in one node block
# so a half-written ledger is impossible: the new content is written next to the
# target (same filesystem, so rename is atomic) and then renamed over it.
close_entries() {
	# shellcheck disable=SC2016
	"${NODE}" --input-type=module -e '
import fs from "node:fs";

const [ledgerPath, reportPath, today] = process.argv.slice(1);

const counts = new Map();
for (const line of fs.readFileSync(reportPath, "utf8").split("\n")) {
  const m = /^\| ([^|]+?) \| (\d+) \|/.exec(line);
  if (m) counts.set(m[1].trim(), Number(m[2]));
}

const entries = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const closed = [];
const waiting = [];

for (const entry of entries) {
  const cw = entry.closeWhen;
  if (!cw || entry.status !== "verifying") continue;
  if (!/^\d{8}$/.test(today) || today < cw.from) {
    waiting.push(`${entry.id} (until ${cw.from})`);
    continue;
  }
  if (!fs.existsSync(cw.dir)) {
    waiting.push(`${entry.id} (dir missing: ${cw.dir})`);
    continue;
  }
  const errors = counts.get(cw.project) ?? 0;
  if (errors !== 0) {
    waiting.push(`${entry.id} (${cw.project} still ${errors})`);
    continue;
  }
  const shown = counts.has(cw.project) ? "0" : "报告无该行，按 0 计";
  entry.status = "closed";
  entry.note = `${entry.note}｜${today} 报告 ${cw.project} error=${shown}（目录存在）→ closed（close-verified-issues.sh 自动判定）`;
  closed.push(entry.id);
}

if (closed.length > 0) {
  const tmp = `${ledgerPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  fs.renameSync(tmp, ledgerPath);
}

console.log(`closed=${closed.length} ${closed.join(",")}`);
console.log(`waiting=${waiting.length} ${waiting.join(" | ")}`);
' "${LEDGER}" "${REPORT}" "${STAMP}" >>"${LOG}" 2>&1
}

main() {
	mkdir -p "${ROOT}/log" || return 0

	if [[ ! -f "${LEDGER}" ]]; then
		log_line error "ledger missing: ${LEDGER}"
		return 0
	fi

	if [[ ! -f "${REPORT}" ]]; then
		log_line info "no report for ${STAMP}, nothing to close"
		return 0
	fi

	if [[ ! -x "${NODE}" ]]; then
		log_line error "node not executable: ${NODE}"
		return 0
	fi

	if close_entries; then
		log_line info "done"
	else
		log_line error "node exited $?"
	fi

	return 0
}

main "$@"
