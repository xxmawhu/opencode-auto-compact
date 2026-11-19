#!/usr/bin/env node
// Daily audit of the `log/` directories owned by AI user projects.
//
// Purpose: find runtime errors written by every AI user project so they can be
// triaged and eliminated. The script only reads logs; it never edits another
// project.
//
// Contract:
//   - zero arguments, zero environment variables (hardcoded defaults below)
//   - exit code is always 0: a monitor must not fail the scheduler
//   - one markdown report per day in `./audit/reports/`
//   - machine state in `./audit/state.json` (day counter + seen signatures)
//   - run log in `./log/log-audit.YYYYMMDD.log`
//
// Issue dispatch is intentionally opt-in (`AUTO_ISSUE = false`): false positives
// from keyword matching must be judged by a human/agent before a project gets an
// issue. Enable only after the patterns are proven on real logs.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

// The monitoring contract is "at least 30 days"; the report states progress so
// the requirement can be audited from any single day's file.
const TARGET_DAYS = 30;

export const DEFAULTS = {
  root: "/mnt/beegfs_data/usr/maxx/dev",
  // Project logs commonly sit 5-6 levels down (`<group>/<repo>/<proj>/log`,
  // `<group>/<repo>/<proj>/<sub>/log`). Depth 4 missed every one of those.
  maxDepth: 6,
  windowHours: 24,
  maxFileBytes: 200 * 1024 * 1024,
  maxMatchesPerFile: 500,
  maxSampleLines: 3,
  skipDirs: new Set([
    "node_modules",
    ".git",
    ".var",
    // `~/.local` trees hold per-account homes (`.local/bin/log`,
    // `.local/share/<tool>/log`). Their logs belong to the OpenCode/ULW-PM
    // runtime, not to a project under audit, and they duplicate every project.
    ".local",
    "build",
    "dist",
    "history_log",
    "history",
    "archive",
  ]),
  // `<proj>/scripts/log` collects one-off build/check script output, not the
  // project's runtime log. Counting it inflates coverage with transient noise.
  skipLogParents: new Set(["scripts"]),
  AUTO_ISSUE: false,
  maxIssuesPerRun: 3,
  // Write a daily triage digest into ./issues/ so the project monitor turns the
  // scan into an actionable task instead of an unread report.
  writeIssueDigest: true,
};

// Error shapes taken from the platform `handle-daily-log` rules plus the
// platform log conventions. Uppercase level tokens are used on purpose: prose
// such as "非 error 级" or a project name like `ana-daily-error` must not be
// counted as a failure. Explicit level fields cover JSON loggers.
const ERROR_PATTERNS = [
  /\b(ERROR|FATAL|CRITICAL)\b/,
  /"level"\s*:\s*"(error|fatal)"/i,
  /"level"\s*:\s*(50|60)\b/,
  /\blevel=(error|fatal)\b/,
  /Traceback \(most recent call last\)/,
  // CamelCase exception classes: FileNotFoundError, KeyError, ValueError...
  // A path segment (`ana-daily-error`), a flag (`--no-error`) or a snake_case
  // field (`error_count`) must not match, hence the trailing guard.
  /\b[A-Z][A-Za-z0-9]*(Error|Exception)\b(?![-\w/])/,
  /\b(Error|Exception):\s/,
  /\bpanic:/,
  /\bUnhandledPromiseRejection\b/i,
  /\buncaughtException\b/i,
];

const WARN_PATTERNS = [/\b(WARN|WARNING)\b/, /"level"\s*:\s*"warn"/i];

// Lines that mention error keywords without reporting a failure. Kept small and
// explicit; every entry needs a real log sample behind it (see tests).
const NOISE_PATTERNS = [
  /\b0\s+errors?\b/i,
  /\berrors?\s*[:=]\s*0\b/i,
  /\bno\s+errors?\b/i,
  /\berror[_-]?count\s*[:=]\s*0\b/i,
  /\berror[_-]?rate\b/i,
  /\berrors?\s*[:=]\s*(null|none|""|\[\])\s*$/i,
  /\berror\s*=\s*(None|null)\b/,
  /\b(def|function|fn|func|method)\s+[A-Za-z0-9_]*[Ee]rror[A-Za-z0-9_]*\s*\(/,
  // Source excerpts pasted into a log with a line-number gutter.
  /^\s*\d+\s*\|/,
  // Static-analysis findings (ruff/eslint/clippy style codes) are not runtime
  // failures: "SIM105 Use `contextlib.suppress(OSError)` instead of ...".
  /^[A-Z]{1,4}\d{2,4}\s/,
  // Verification output states its outcome explicitly: `[PASS] ... 无 LoadError`
  // names an exception class as an assertion target, not as a failure.
  /\[PASS\]/,
  // Lint advice lines ("help: Replace ...").
  /^help:\s/,
];

export function isNoise(line) {
  if (NOISE_PATTERNS.some((re) => re.test(line))) return true;
  // Summary counters: `check done: ERROR 0 / WARN 0 / INFO 0` is a clean run.
  // A nonzero counter on the same line still reports a failure, so the zero
  // test alone must not hide it.
  const zero = /\b(ERROR|WARN(?:ING)?)\s*[:=]?\s*0\b/.test(line);
  const nonzero = /\b(ERROR|WARN(?:ING)?)\s*[:=]?\s*[1-9]\d*\b/.test(line);
  return zero && !nonzero;
}

function classifyText(text) {
  if (ERROR_PATTERNS.some((re) => re.test(text))) return "error";
  if (WARN_PATTERNS.some((re) => re.test(text))) return "warn";
  return null;
}

export function classifyLine(line) {
  const text = String(line ?? "");
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isNoise(trimmed)) return null;

  // Structured records: judge the declared level/status, not keywords inside
  // expected-value strings. A PASS report that mentions "ERROR" as a required
  // log level must not be counted as a failure.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const record = JSON.parse(trimmed);
      const level = String(record.level ?? record.severity ?? "").toLowerCase();
      if (level === "error" || level === "fatal" || level === "critical") return "error";
      if (level === "warn" || level === "warning") return "warn";
      const status = String(record.status ?? "").toLowerCase();
      if (status === "fail" || status === "failed" || status === "failure" || status === "error")
        return "error";
      const probe = [record.msg, record.message, record.error]
        .filter((value) => value != null)
        .join(" ");
      return probe ? classifyText(probe) : null;
    } catch {
      // Not JSON after all: fall through to text rules.
    }
  }

  return classifyText(trimmed);
}

// Timestamps, uuids, pids, durations, paths and bare numbers differ between two
// occurrences of the same defect. Removing them keeps one signature per root
// cause, so the daily report can say "recurring" instead of "new".
export function normalizeSignature(text) {
  return (
    String(text)
      .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+Z-]+/g, "<ts>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      // Host object ids such as ses_19cdc6c20ffe..., msg_1e3d..., job_ab12...
      .replace(/\b[a-z]{2,5}_[A-Za-z0-9]{8,}\b/g, "<id>")
      .replace(/\bpid[=:\s]*\d+\b/gi, "pid=<n>")
      .replace(/\b\d+(\.\d+)?\s*(ms|us|ns|s|sec|seconds|bytes|kb|mb|gb)\b/gi, "<num><unit>")
      .replace(/\/[^\s:'"]+/g, "<path>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400)
  );
}

export function signatureOf(project, text) {
  const digest = crypto
    .createHash("sha1")
    .update(`${project}\u0000${normalizeSignature(text)}`)
    .digest("hex");
  return digest.slice(0, 12);
}

export function dayKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// `.../proj/log` -> `.../proj`; the project marker is the nearest ancestor that
// looks like a real project root.
export function projectRootOf(logDir, exists = (p) => fs.existsSync(p)) {
  let dir = path.dirname(path.resolve(logDir));
  for (let i = 0; i < 4; i += 1) {
    if (
      exists(path.join(dir, "memory", "root.md")) ||
      exists(path.join(dir, "opencode.json")) ||
      exists(path.join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(logDir));
}

export function discoverLogDirs(root, maxDepth, skipDirs, skipLogParents = new Set()) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirs.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (entry.name === "log") {
        if (skipLogParents.has(path.basename(dir))) continue;
        found.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

const BINARY_EXT = new Set([
  ".gz",
  ".tgz",
  ".zip",
  ".tar",
  ".bz2",
  ".xz",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".bin",
  ".db",
  ".sqlite",
  ".so",
  ".pack",
  ".idx",
]);

// Log files keep history: a file appended today also contains lines written
// months ago. Counting those would report defects as "active" long after they
// stopped. Parse the leading timestamp when the format is recognised and let
// continuation lines (tracebacks, stack frames) inherit the last seen time.
const TS_PATTERNS = [
  /^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?(?:Z|[+-]\d{2}:?\d{2})?\]?/,
];

export function parseLeadingTimestamp(line) {
  const text = String(line ?? "");
  for (const pattern of TS_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [, date, time, fraction] = match;
    const ms = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
    // Timestamps are wall-clock in the host timezone; use local time parsing
    // so a freshly written line is never misclassified as stale.
    const stamp = Date.parse(`${date}T${time}.${String(ms).padStart(3, "0")}`);
    if (Number.isFinite(stamp)) return stamp;
  }
  return null;
}

async function scanFile(file, sinceMs, limits, onMatch) {
  if (BINARY_EXT.has(path.extname(file).toLowerCase())) return { skipped: "archive" };
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return { skipped: "stat" };
  }
  if (stat.mtimeMs < sinceMs) return { skipped: "old" };
  if (stat.size > limits.maxFileBytes) return { skipped: "large" };

  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (head.subarray(0, bytesRead).includes(0)) return { skipped: "binary" };
  } catch {
    return { skipped: "read" };
  } finally {
    await handle?.close();
  }

  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let matches = 0;
  let stale = 0;
  let lastTs = null;
  try {
    for await (const line of rl) {
      lineNo += 1;
      const ts = parseLeadingTimestamp(line);
      if (ts != null) lastTs = ts;
      const level = classifyLine(line);
      if (!level) continue;
      if (lastTs != null && lastTs < sinceMs) {
        stale += 1;
        continue;
      }
      matches += 1;
      onMatch({ lineNo, level, text: line });
      if (matches >= limits.maxMatchesPerFile) break;
    }
  } catch {
    return { skipped: "read", matches, stale };
  } finally {
    rl.close();
    stream.destroy();
  }
  return { matches, stale, capped: matches >= limits.maxMatchesPerFile };
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { firstRun: null, lastRun: null, days: {}, signatures: {}, issued: {} };
  }
}

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function appendRunLog(line) {
  const file = path.join(PROJECT_ROOT, "log", `log-audit.${dayKey(new Date())}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

// Per-project change against the previous day, so every report proves on its
// own whether the reported errors are going away. A project that disappears
// counts as 0 (eliminated), one that appears counts from 0 (new).
export function diffProjectCounts(previous = {}, current = {}) {
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...names]
    .map((project) => {
      const before = previous[project] ?? 0;
      const after = current[project] ?? 0;
      return { project, previous: before, current: after, delta: after - before };
    })
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.project.localeCompare(b.project));
}

function renderTrend(lines, trend, display) {
  if (!trend || trend.length === 0) return;
  lines.push(`## Change vs ${trend.day}`);
  lines.push("");
  lines.push("| project | previous | current | delta |");
  lines.push("|---|---|---|---|");
  for (const row of trend.rows) {
    const sign = row.delta > 0 ? "+" : "";
    lines.push(
      `| ${display(row.project)} | ${row.previous} | ${row.current} | ${sign}${row.delta} |`,
    );
  }
  lines.push("");
}

function renderReport({
  day,
  startedAt,
  sinceMs,
  scan,
  groups,
  recurring,
  resolved,
  trend,
  state,
  root,
}) {
  const lines = [];
  const totalErrors = groups.reduce((sum, g) => sum + g.errors, 0);
  const totalWarns = groups.reduce((sum, g) => sum + g.warns, 0);
  const display = (project) =>
    project.startsWith(`${root}/`) ? project.slice(root.length + 1) : project;
  lines.push(`# AI user log audit ${day}`);
  lines.push("");
  lines.push(`- run: ${startedAt.toISOString()}`);
  lines.push(`- window since: ${new Date(sinceMs).toISOString()}`);
  lines.push(`- monitored days: ${Object.keys(state.days).length}`);
  lines.push(
    `- monitoring progress: ${Object.keys(state.days).length}/30 days (target day: ${TARGET_DAYS} run days, started ${(state.firstRun ?? startedAt.toISOString()).slice(0, 10)})`,
  );
  lines.push(
    `- log dirs: ${scan.logDirs}, files read: ${scan.filesRead}, files skipped: ${scan.filesSkipped}, stale lines ignored: ${scan.staleMatches}`,
  );
  lines.push(
    `- findings: error lines ${totalErrors}, warn lines ${totalWarns}, projects with errors ${groups.length}`,
  );
  lines.push("");
  lines.push("## Projects with error lines");
  lines.push("");
  lines.push("| project | error lines | warn lines | files | new signatures | top signature |");
  lines.push("|---|---|---|---|---|---|");
  for (const group of groups) {
    lines.push(
      `| ${display(group.project)} | ${group.errors} | ${group.warns} | ${group.files} | ${group.newSignatures} | ${group.topSignature.replace(/\|/g, "\\|").slice(0, 120)} |`,
    );
  }
  lines.push("");
  renderTrend(lines, trend, display);
  if (resolved && resolved.length > 0) {
    lines.push("## Resolved since last run");
    lines.push("");
    lines.push("| project | signature | last seen | total lines | sample |");
    lines.push("|---|---|---|---|---|");
    for (const item of resolved) {
      lines.push(
        `| ${display(item.project ?? "-")} | ${item.id} | ${String(item.lastSeen ?? "").slice(0, 19)} | ${item.count ?? 0} | ${String(
          item.sample ?? "",
        )
          .replace(/\|/g, "\\|")
          .slice(0, 100)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Error samples");
  lines.push("");
  for (const group of groups) {
    lines.push(`### ${display(group.project)}`);
    lines.push("");
    lines.push(`- error lines: ${group.errors} (files: ${group.files})`);
    lines.push(
      `- signature: ${group.topSignatureId} (${recurring[group.topSignatureId] ? "recurring" : "new"})`,
    );
    lines.push("");
    lines.push("```text");
    for (const sample of group.samples) lines.push(sample);
    lines.push("```");
    lines.push("");
  }
  lines.push("## Warnings");
  lines.push("");
  const warnGroups = groups.filter((g) => g.warns > 0);
  if (warnGroups.length === 0) lines.push("_none_");
  else for (const g of warnGroups) lines.push(`- ${g.project}: ${g.warns} warn lines`);
  lines.push("");
  lines.push("## Skipped");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(scan.skipped, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export async function run(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = new Date();
  const day = dayKey(now);
  const auditDir = path.join(PROJECT_ROOT, "audit");
  const stateFile = path.join(auditDir, "state.json");
  const reportFile = path.join(auditDir, "reports", `log-audit.${day}.md`);
  const historyFile = path.join(auditDir, "findings.jsonl");

  const state = loadState(stateFile);
  // A fixed trailing window keeps every run comparable: an incremental
  // "since last run" window makes a manual re-run overwrite the daily report
  // with a few minutes of data. The 30-day counter lives in `state.days`.
  const sinceMs = now.getTime() - cfg.windowHours * 3600 * 1000;

  const scan = { logDirs: 0, filesRead: 0, filesSkipped: 0, staleMatches: 0, skipped: {} };
  const groups = new Map(); // project -> aggregate
  const signatureStats = new Map(); // signature -> { count, project, samples }

  const logDirs = discoverLogDirs(cfg.root, cfg.maxDepth, cfg.skipDirs, cfg.skipLogParents);
  scan.logDirs = logDirs.length;

  for (const logDir of logDirs) {
    const project = projectRootOf(logDir);
    let names = [];
    try {
      names = await fs.promises.readdir(logDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isFile()) continue;
      const file = path.join(logDir, entry.name);
      const result = await scanFile(file, sinceMs, cfg, ({ lineNo, level, text }) => {
        const group = groups.get(project) ?? {
          project,
          errors: 0,
          warns: 0,
          files: new Set(),
          samples: [],
          signatures: new Map(),
        };
        const sig = signatureOf(project, text);
        if (level === "error") {
          group.errors += 1;
          group.files.add(file);
          group.signatures.set(sig, (group.signatures.get(sig) ?? 0) + 1);
          if (group.samples.length < cfg.maxSampleLines * 3) {
            group.samples.push(
              `${path.relative(PROJECT_ROOT, file)}:${lineNo}: ${text.trim().slice(0, 240)}`,
            );
          }
          const stats = signatureStats.get(sig) ?? {
            count: 0,
            project,
            sample: text.trim().slice(0, 240),
            file,
          };
          stats.count += 1;
          signatureStats.set(sig, stats);
        } else {
          group.warns += 1;
        }
        groups.set(project, group);
      });
      if (result.skipped) {
        scan.filesSkipped += 1;
        scan.skipped[result.skipped] = (scan.skipped[result.skipped] ?? 0) + 1;
      } else {
        scan.filesRead += 1;
        scan.staleMatches += result.stale ?? 0;
      }
    }
  }

  const recurring = {};
  const seen = state.signatures ?? {};
  // Signatures that were present on the previous run but are gone now: the
  // direct evidence that a reported defect actually stopped, which is what
  // "eliminate the errors" is measured by.
  const previousIds = new Set(state.lastSignatureIds ?? []);
  const currentIds = new Set(signatureStats.keys());
  const resolved = [...previousIds]
    .filter((sig) => !currentIds.has(sig) && seen[sig])
    .map((sig) => ({ id: sig, ...seen[sig] }));
  for (const [sig, stats] of signatureStats) {
    const firstSeen = seen[sig]?.firstSeen ?? now.toISOString();
    state.signatures = state.signatures ?? {};
    state.signatures[sig] = {
      project: stats.project,
      firstSeen,
      lastSeen: now.toISOString(),
      count: (seen[sig]?.count ?? 0) + stats.count,
      sample: stats.sample,
    };
    recurring[sig] = firstSeen !== now.toISOString();
  }

  const projectGroups = [...groups.values()]
    .filter((group) => group.errors > 0)
    .map((group) => {
      const top = [...group.signatures.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        ...group,
        files: group.files.size,
        topSignatureId: top?.[0] ?? "-",
        topSignature: signatureStats.get(top?.[0])?.sample ?? "-",
        newSignatures: [...group.signatures.keys()].filter((sig) => !recurring[sig]).length,
      };
    })
    .sort((a, b) => b.errors - a.errors);

  state.firstRun = state.firstRun ?? now.toISOString();
  state.lastRun = now.toISOString();
  state.lastSignatureIds = [...currentIds];
  const display = (project) =>
    project.startsWith(`${cfg.root}/`) ? project.slice(cfg.root.length + 1) : project;
  const currentProjectCounts = Object.fromEntries(
    projectGroups.map((group) => [display(group.project), group.errors]),
  );
  const previousDays = Object.keys(state.days)
    .filter((key) => key < day)
    .sort();
  const previousDay = previousDays.at(-1);
  const trend = previousDay
    ? {
        day: previousDay,
        rows: diffProjectCounts(state.days[previousDay]?.projects ?? {}, currentProjectCounts),
      }
    : null;
  state.days[day] = {
    logDirs: scan.logDirs,
    filesRead: scan.filesRead,
    errorLines: projectGroups.reduce((sum, g) => sum + g.errors, 0),
    projectsWithErrors: projectGroups.length,
    projects: currentProjectCounts,
  };
  writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  writeFileAtomic(
    reportFile,
    renderReport({
      day,
      startedAt: now,
      sinceMs,
      scan,
      groups: projectGroups,
      recurring,
      resolved,
      trend,
      state,
      root: cfg.root,
    }),
  );
  for (const group of projectGroups) {
    fs.appendFileSync(
      historyFile,
      `${JSON.stringify({ day, project: group.project, errors: group.errors, warns: group.warns, topSignatureId: group.topSignatureId })}\n`,
    );
  }

  const summary = `day=${day} monitored_days=${Object.keys(state.days).length} log_dirs=${scan.logDirs} files_read=${scan.filesRead} error_lines=${projectGroups.reduce((s, g) => s + g.errors, 0)} projects_with_errors=${projectGroups.length}`;
  appendRunLog(`${now.toISOString()} ${summary}`);

  // Feedback loop: a daily digest in `issues/` is picked up by the project
  // monitor and turned into a triage task. Without it the cron scan would
  // collect reports nobody reviews, and errors would never be eliminated.
  if (cfg.writeIssueDigest && projectGroups.length > 0) {
    const digestFile = path.join(PROJECT_ROOT, "issues", `log-audit-${day}.md`);
    writeFileAtomic(
      digestFile,
      renderDigest({ day, summary, groups: projectGroups, root: cfg.root }),
    );
    appendRunLog(`${now.toISOString()} digest=${digestFile}`);
  }

  return { day, reportFile, stateFile, summary, groups: projectGroups, state };
}

function renderDigest({ day, summary, groups, root }) {
  const display = (project) =>
    project.startsWith(`${root}/`) ? project.slice(root.length + 1) : project;
  const lines = [];
  lines.push(`# 日志巡检 ${day}：待分诊的报错`);
  lines.push("");
  lines.push("## 来源");
  lines.push("");
  lines.push(`- 生成：scripts/audit-ai-logs.mjs（crontab 每日 06:40）`);
  lines.push(`- 完整报告：\`audit/reports/log-audit.${day}.md\``);
  lines.push(`- 统计：${summary}`);
  lines.push("");
  lines.push("## 本轮报错项目");
  lines.push("");
  lines.push("| 项目 | error 行 | warn 行 | 文件 | 新签名 | 首条样本 |");
  lines.push("|---|---|---|---|---|---|");
  for (const group of groups) {
    lines.push(
      `| ${display(group.project)} | ${group.errors} | ${group.warns} | ${group.files} | ${group.newSignatures} | ${group.topSignature.replace(/\|/g, "\\|").slice(0, 120)} |`,
    );
  }
  lines.push("");
  lines.push("## 分诊要求");
  lines.push("");
  lines.push(
    "1. 逐项判定真伪：真实缺陷 / 外部瞬时（网络 5xx、连接重置）/ 日志噪声（关键词误报）/ 历史残留。",
  );
  lines.push(
    "2. 真实缺陷按 `publish-issue` 向归属项目提 issue；噪声按 `log-error-review` 提日志级别整改。",
  );
  lines.push("3. 结论写入 `audit/triage.md` 台账（签名 → 判定 → 处置 → 状态），避免重复提 issue。");
  lines.push("4. 记录当日报错消除进度，监测满 30 天后统计趋势。");
  lines.push("");
  lines.push("## 反馈要求");
  lines.push("");
  lines.push("- 处理完成后删除本文件；未处理则保留，下一轮巡检继续累计。");
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((result) => {
      process.stdout.write(`${result.summary}\nreport: ${result.reportFile}\n`);
    })
    .catch((error) => {
      appendRunLog(`${new Date().toISOString()} FAILED ${error?.stack ?? error}`);
      process.stdout.write(`audit failed: ${error?.message ?? error}\n`);
    });
}
