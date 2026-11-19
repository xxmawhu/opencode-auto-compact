// Ledger transitions for `verifying` issues: close one only when the daily
// report proves its project reached zero error lines on/after a fixed date.
//
// Why a module instead of inline `node -e` inside the shell script: the two
// decisions that can silently corrupt the 30-day conclusion — how a report row
// maps to a ledger entry, and how a zero row is proven — need executable tests.
// Inline JS in a bash heredoc cannot be imported, so it drifted: an entry whose
// project is scanned from two roots (`X` and `X (home)`) was graded on one row
// and would have been closed while the other root still logged hundreds of
// errors (2026-11-19: repo-updater 663 + 396 = 1059).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Same normalization the triage table uses, so "which report rows belong to
// this ledger entry" has exactly one implementation: a row counts as the
// project when it keeps the project name after dropping the audit root
// (`dev/`, `/mnt/beegfs_data/usr/maxx/`) and the `(home)` marker.
import { normalizeProjectName } from "./audit-ai-logs.mjs";

export function normalizeRow(name) {
  const withoutRoot = String(name ?? "")
    .trim()
    .replace(/^\/mnt\/beegfs_data\/usr\/maxx\//, "")
    .replace(/^\/home\/[^/]+\//, "");
  return normalizeProjectName(withoutRoot);
}

// Only the "Projects with error lines" table has `<name> | <digits> |` as its
// first two cells; the pending/resolved tables start with an id or a signature.
export function parseReportCounts(text) {
  const counts = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\| ([^|]+?) \| (\d+) \|/.exec(line);
    if (m) counts.set(m[1].trim(), Number(m[2]));
  }
  return counts;
}

// Sum every row that belongs to the entry. `entry.match` is the same prefix
// list the triage table uses, so an entry that covers both install roots sums
// both. Falling back to the exact `project` keeps hand-written entries working.
export function errorTotal(entry, counts) {
  const cw = entry.closeWhen ?? {};
  const patterns = (Array.isArray(entry.match) ? entry.match : [entry.match])
    .filter(Boolean)
    .map(normalizeRow)
    .filter((p) => p !== "");
  if (patterns.length === 0) {
    const exact = counts.get(cw.project);
    return { total: exact ?? 0, rows: exact === undefined ? [] : [cw.project] };
  }
  let total = 0;
  const rows = [];
  for (const [name, n] of counts) {
    const normalized = normalizeRow(name);
    if (patterns.some((p) => normalized.includes(p))) {
      total += n;
      rows.push(name);
    }
  }
  return { total, rows };
}

// Pure decision step. `dirExists` and `runVerify` are injected so tests can
// exercise every branch without a filesystem or a spawned script.
export function evaluateClosures(entries, counts, today, deps = {}) {
  const dirExists = deps.dirExists ?? ((dir) => fs.existsSync(dir));
  const runVerify = deps.runVerify ?? (() => 0);
  const closed = [];
  const waiting = [];

  for (const entry of entries) {
    const cw = entry.closeWhen;
    if (!cw || entry.status !== "verifying") continue;
    if (!/^\d{8}$/.test(today) || today < cw.from) {
      waiting.push(`${entry.id} (until ${cw.from})`);
      continue;
    }
    if (!dirExists(cw.dir)) {
      waiting.push(`${entry.id} (dir missing: ${cw.dir})`);
      continue;
    }
    const { total, rows } = errorTotal(entry, counts);
    if (total !== 0) {
      const where = rows.length > 0 ? rows.join(" + ") : cw.project;
      waiting.push(`${entry.id} (${where} still ${total})`);
      continue;
    }
    // A zero row is necessary but not sufficient for projects whose evidence
    // depends on a long-running writer: the daily scan takes ~6.5h, so at the
    // 06:40 audit its log is half-written and cannot show a late failure.
    if (cw.requireVerify) {
      const rc = runVerify(cw.requireVerify);
      if (rc !== 0) {
        waiting.push(`${entry.id} (verify ${cw.requireVerify} rc=${rc})`);
        continue;
      }
    }
    const shown = rows.length > 0 ? rows.map((r) => `${r}=0`).join(" + ") : "报告无该行，按 0 计";
    entry.status = "closed";
    entry.note = `${entry.note}｜${today} 报告 ${shown}（目录存在）→ closed（close-verified-issues.sh 自动判定）`;
    closed.push(entry.id);
  }

  return { entries, closed, waiting };
}

// Blank or repeated ids make two entries indistinguishable in the closure
// evidence written into `note`, so surface them instead of writing an
// ambiguous note. A hand-added entry and a script-generated one both defaulted
// to "-" once, which is exactly the collision this catches.
export function invalidIds(entries) {
  const seen = new Set();
  const bad = [];
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "" || id === "-" || seen.has(id)) bad.push(entry.target ?? "(no target)");
    seen.add(id);
  }
  return bad;
}

function writeAtomic(target, content) {
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function main(argv) {
  const [ledgerPath, reportPath, today, rootPath, verifyCwd] = argv;
  if (!ledgerPath || !reportPath || !today) {
    process.stdout.write("usage: close-verified-issues.mjs <ledger> <report> <YYYYMMDD> [root]\n");
    return 2;
  }
  const counts = parseReportCounts(fs.readFileSync(reportPath, "utf8"));
  const entries = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));

  const bad = invalidIds(entries);
  if (bad.length > 0) process.stdout.write(`invalid_ids=${bad.length} ${bad.join(" | ")}\n`);

  const { closed, waiting } = evaluateClosures(entries, counts, today, {
    runVerify: (script) => {
      if (!script) return 0;
      const target = path.isAbsolute(script) ? script : path.join(rootPath ?? ".", script);
      const run = spawnSync("/bin/bash", [target], {
        cwd: verifyCwd ?? rootPath,
        encoding: "utf8",
      });
      return run.status ?? 1;
    },
  });

  if (closed.length > 0) writeAtomic(ledgerPath, `${JSON.stringify(entries, null, 2)}\n`);
  process.stdout.write(`closed=${closed.length} ${closed.join(",")}\n`);
  process.stdout.write(`waiting=${waiting.length} ${waiting.join(" | ")}\n`);
  return 0;
}

// `require` is unavailable in ESM; import lazily so the module also loads in
// the test runner, which never reaches main().
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(main(process.argv.slice(2)));
