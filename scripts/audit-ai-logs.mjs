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
  // Every ai-user project tree, not just `dev/`: regular_task, release and
  // quant also host projects whose logs never appeared in the audit before
  // (e.g. /usr/maxx/regular_task/opencode-auto-compact/log/install.*.log).
  // `ai/`, `bdt2cpp/`, `hftapi/` and `history_data/` are registered ai-user
  // projects too; without them 11 registered projects had no log coverage.
  roots: [
    "/mnt/beegfs_data/usr/maxx/dev",
    "/mnt/beegfs_data/usr/maxx/regular_task",
    "/mnt/beegfs_data/usr/maxx/release",
    "/mnt/beegfs_data/usr/maxx/quant",
    "/mnt/beegfs_data/usr/maxx/ai",
    "/mnt/beegfs_data/usr/maxx/bdt2cpp",
    "/mnt/beegfs_data/usr/maxx/hftapi",
    "/mnt/beegfs_data/usr/maxx/history_data",
  ],
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
  // Some projects keep the real runtime log one level below `log/`
  // (`repo-updater/log/app/gitlab-daemon.log`). Reading only direct children
  // reported those projects as error-free, which is a blind spot, not a clean
  // log. Depth 1 means "files strictly inside `log/<one-subdir>/`".
  logSubdirDepth: 1,
  // Archive/scratch subdirectories under `log/` hold rotated or test output;
  // counting them would resurrect defects that already stopped.
  skipLogSubdirs: new Set([
    "archive",
    "history",
    "history_log",
    "old",
    "tmp",
    "temp",
    "test",
    "tests",
    "nanolog_compressed",
    "node_modules",
    ".git",
    ".var",
  ]),
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
  // A report section banner that quotes the level it looked for, not a record at
  // that level. Real sample (live-ops/ana-daily-error):
  //   --- MATCH lines WITHOUT 'ERROR' (旧探针盲区) ---
  /\bMATCH lines WITHOUT\s+['"](?:ERROR|WARN(?:ING)?)['"]/i,
  // Lint advice lines ("help: Replace ...").
  /^help:\s/,
  // Verification scripts record their own outcome as `key: value` metadata, and
  // the value may name the log level they searched for rather than report a
  // failure. Real samples from this project's own logs:
  //   target_head: 19beb97 fix(scan): ... 新增逐条 ERROR（issue 8b932531）
  //   reason: 今日仍有 ERROR 命中（5xx=0, list_comments:569=1）
  // Counting the mention made the audit blame itself for other projects' fixes.
  /^\s*(?:\[[^\]]*\]\s*)?(target_head|reason)\s*:/,
  /\bverdict\s*[:=]\s*(?:PASS|FAIL|INCONCLUSIVE)\b/i,
  // systemd unit directives, not runtime exceptions:
  //   StandardError=append:/.../log/back-shm-data.log
  /^\s*Standard(?:Error|Output)\s*=/,
  // All-caps banner that titles a report about errors, not an error record:
  //   LOG ERROR CHECK REPORT   (check-exists-kline, 1 line/day, its own body
  //                             then says "Total errors: 0")
  // Restricted to ... REPORT/SUMMARY titles so an uppercase failure line such
  // as "FATAL ERROR" still counts.
  /^[A-Z][A-Z ]*(?:REPORT|SUMMARY)$/,
  // Box-drawing table rows are report aggregates, not failure records. Real
  // sample (spike/spike-event-census build-availability, 2 rows/day):
  //   │ bybit    ┆ trade_read_error:ValueError ┆ 1398   ┆ 6         │
  // The row counts exceptions per exchange; its `ValueError` named a category,
  // yet the exception-class pattern counted the row as one more error. Only
  // box-drawing leaders are treated this way: an ASCII `| TS | ERROR |` record
  // starts with the timestamp and stays countable.
  /^\s*[│┆┌└├┏┗┣]/,
  // A verification script states its own successful outcome as `PASS: ...`, and
  // the wording may name the level it asserted. Real sample
  // (opencode-issue-trigger verify-issues-confirm, 3 rows):
  //   PASS: 只读配置目录失败时日志记录了 ERROR 原因
  /^\s*PASS\s*[:：]/,
];

export function isNoise(line) {
  if (NOISE_PATTERNS.some((re) => re.test(line))) return true;
  // Summary counters: `check done: ERROR 0 / WARN 0 / INFO 0` is a clean run.
  // A nonzero counter on the same line still reports a failure, so the zero
  // test alone must not hide it.
  // Chinese summaries put a short label between the keyword and the colon:
  // `- ERROR 行数: 0` and `- ERROR 行: 0 条, 归组 0 类`. Both report a clean
  // run, yet the plain pattern missed them because `行` sits before the colon,
  // so two healthy lines were counted as errors. The same allowance must apply
  // to `nonzero`, otherwise `ERROR 行: 3 条` would be read as noise and hide a
  // real failure.
  const label = "(?:[\\u4e00-\\u9fff]{1,3}\\s*)?";
  const zero = new RegExp(`\\b(ERROR|WARN(?:ING)?)\\s*${label}[:=]?\\s*0\\b`).test(line);
  const nonzero = new RegExp(`\\b(ERROR|WARN(?:ING)?)\\s*${label}[:=]?\\s*[1-9]\\d*\\b`).test(line);
  return zero && !nonzero;
}

function classifyText(text) {
  if (ERROR_PATTERNS.some((re) => re.test(text))) return "error";
  if (WARN_PATTERNS.some((re) => re.test(text))) return "warn";
  return null;
}

// Loggers that print a dedicated level column state their severity there, and
// the message may legitimately name other levels: `| INFO | alert_levels:
// ['ERROR', 'WARNING', 'CRITICAL']` is a configuration dump, not a failure.
// Bracket-style loggers (`[2026-11-19 06:47:49] [INFO] 窗口内无 ERROR`) behave
// the same way. The level column wins over keywords in the message body.
const LEVEL_FIELD = /\|\s*(TRACE|DEBUG|INFO|SUCCESS|WARNING|WARN|ERROR|CRITICAL|FATAL)\s*\|/;
// `[ts] [LEVEL] body`: the leading timestamp is bracketed too, so skip that
// first bracket group before matching the level token. Bare timestamps
// (`2026-11-19T15:30:30Z [info] body`, the shape our own bash jobs write) and
// lowercase levels must be recognized as well: without them the declared level
// is invisible, the body keyword wins, and `[info] ... 每 30 分钟 ERROR）` was
// counted as an error of this project (2026-11-19 15:41 report, 4 lines).
const BRACKET_LEVEL =
  /^(?:\[[^\]]*\]|\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]+)\s*\[(TRACE|DEBUG|INFO|SUCCESS|WARNING|WARN|ERROR|CRITICAL|FATAL)\]/i;

// Terminals colour shell logs, and an escape sequence in front of the record
// hides its level: `\x1b[0;32m[2026-11-19 08:02:24] [INFO] ... [ERROR] ...` is
// an INFO line replaying an old error, but BRACKET_LEVEL cannot see the [INFO]
// because the line no longer starts with `[`. Strip colour first so "declared
// level wins" holds for coloured output too (scan_issue: 5 of 10 counted lines).
// eslint-disable-next-line no-control-regex -- ESC is the whole point of this pattern
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function classifyLine(line) {
  const text = String(line ?? "").replace(ANSI_ESCAPE, "");
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isNoise(trimmed)) return null;

  const declared = LEVEL_FIELD.exec(trimmed) ?? BRACKET_LEVEL.exec(trimmed);
  if (declared) {
    const level = declared[1].toUpperCase();
    if (level === "ERROR" || level === "CRITICAL" || level === "FATAL") return "error";
    if (level === "WARN" || level === "WARNING") return "warn";
    // TRACE/DEBUG/INFO/SUCCESS: the record is informational whatever the body
    // says. Tracebacks below it are separate lines without a level column.
    return null;
  }

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

// Collect the files a `log/` tree holds, descending `depth` levels into
// subdirectories. A directory that cannot be listed is reported back instead of
// being silently skipped: the report must never claim coverage that it did not
// have. A subdirectory that disappears between readdir and stat is a neighbour's
// test race and is reported separately, same as `run()` does for `log/` itself.
export async function collectLogFiles(logDir, depth = 0, skipSubdirs = new Set()) {
  const files = [];
  const unreadableDirs = [];
  const vanishedDirs = [];
  const walk = async (dir, remaining) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isVanishedDirError(error?.code)) vanishedDirs.push(dir);
      else unreadableDirs.push(dir);
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isFile()) {
        files.push(child);
        continue;
      }
      if (!entry.isDirectory() || remaining <= 0) continue;
      if (skipSubdirs.has(entry.name)) continue;
      await walk(child, remaining - 1);
    }
  };
  await walk(logDir, depth);
  return { files, unreadableDirs, vanishedDirs };
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

// JSONL logs carry the timestamp inside the record, so the leading-timestamp
// parser never fires and every old record inherits "now" from the file's
// rotation time. `{"status":"FAIL","timestamp":"2026-11-18T02:00:02"}` written
// into a file rotated today would otherwise be reported as an active failure.
export function parseJsonTimestamp(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(text);
  if (!match) return null;
  const stamp = Date.parse(match[1]);
  return Number.isFinite(stamp) ? stamp : null;
}

// Rotated or archived logs are sometimes left directly inside `log/` instead of
// being moved into an `archive/`/`history/` subdirectory — for example
// `log/check/cron.log.20261119_history_modules`, a verbatim copy of a previous
// day's crashes. Such a copy carries no timestamps at all, so every line is
// counted as current and a defect that already stopped is re-reported on every
// run: the project can never reach zero.
//
// The name alone is not enough to skip a file: the live log of a project whose
// name contains "history" (`check-hft-restapi-history/log/check-history-contract
// -test.log`) matches it too. Only the combination is decisive — an
// archive-looking name whose content has no parseable timestamp whatsoever. A
// live logger stamps its lines, so those files are still scanned.
const ARCHIVE_FILE_NAME =
  /(?:^|[._-])(?:archived?|rotated|old|bak)(?:[._-]|$)|[._-]history(?:[._-]|$)/i;

export function isArchiveFileName(file) {
  return ARCHIVE_FILE_NAME.test(path.basename(file));
}

export async function scanFile(file, sinceMs, limits, onMatch) {
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
  let stale = 0;
  let lastTs = null;
  let sawTimestamp = false;
  // Matches are held until the whole file is read: whether an undated line is
  // current or an archival copy is only decidable once we know whether the file
  // ever stamps its lines. Bounded by maxMatchesPerFile, so memory stays flat.
  const pending = [];
  // Appended files are read oldest-first, so the head of a dated file is its
  // oldest segment. An undated head block (e.g. a months-old traceback) cannot
  // be dated on its own; it is parked until the first timestamp decides its
  // age. Counting it unconditionally re-reports a stopped defect on every run:
  // `check-funding_rate_api/log/qa/cron.log` carried ~400 undated
  // `ModuleNotFoundError` frames ahead of its first stamp.
  const headPending = [];
  const releaseHead = (isCurrent) => {
    if (!headPending.length) return;
    for (const match of headPending) {
      if (!isCurrent) {
        stale += 1;
      } else if (match.level === "error") {
        if (pending.length < limits.maxMatchesPerFile) pending.push(match);
      } else {
        onMatch(match);
      }
    }
    headPending.length = 0;
  };
  try {
    for await (const line of rl) {
      lineNo += 1;
      const ts = parseLeadingTimestamp(line) ?? parseJsonTimestamp(line);
      if (ts != null) {
        lastTs = ts;
        sawTimestamp = true;
        releaseHead(ts >= sinceMs);
      }
      const level = classifyLine(line);
      if (!level) continue;
      if (lastTs != null && lastTs < sinceMs) {
        stale += 1;
        continue;
      }
      const match = { lineNo, level, text: line };
      if (lastTs == null) {
        headPending.push(match);
        if (headPending.length >= limits.maxMatchesPerFile) break;
      } else if (level === "error") {
        // Only error lines need the buffered copy: the cap exists to bound
        // memory, and letting a chatty WARNING stream consume it silently
        // dropped the errors that follow (observed: a watchdog log whose 500
        // slots were spent on warnings before the first real error).
        pending.push(match);
        if (pending.length >= limits.maxMatchesPerFile) break;
      } else {
        onMatch(match);
      }
    }
  } catch {
    return { skipped: "read", matches: 0, stale };
  } finally {
    rl.close();
    stream.destroy();
  }

  // Undated archive-named file: a copy of history, not live output. Counting it
  // would re-report a stopped defect every day and the project could never
  // reach zero.
  if (!sawTimestamp && isArchiveFileName(file)) {
    return { skipped: "archive", matches: 0, stale: stale + pending.length + headPending.length };
  }

  // No timestamp anywhere: the project simply does not stamp its logs, and the
  // file mtime is the only clock. Hiding it would be a coverage blind spot.
  if (!sawTimestamp) releaseHead(true);

  for (const match of pending) onMatch(match);
  return { matches: pending.length, stale, capped: pending.length >= limits.maxMatchesPerFile };
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

// `findings.jsonl` is the per-day series behind a 30-day trend: one line per
// (day, project). Appending on every run duplicated a day's entries 39 times on
// 2026-11-19 (reruns while the audit was being written), so anything summing
// the file over-counted that day. Rewrite the day's block instead; other days
// are kept verbatim, and unknown lines are preserved rather than dropped.
export function writeDailyFindings(historyFile, day, groups = []) {
  const kept = [];
  try {
    for (const line of fs.readFileSync(historyFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        kept.push(line);
        continue;
      }
      if (parsed?.day !== day) kept.push(line);
    }
  } catch {
    // First run of the project: no history yet.
  }
  const rows = groups.map((group) =>
    JSON.stringify({
      day,
      project: group.project,
      errors: group.errors,
      warns: group.warns,
      topSignatureId: group.topSignatureId,
    }),
  );
  const tmp = `${historyFile}.tmp`;
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(tmp, `${[...kept, ...rows].join("\n")}\n`);
  fs.renameSync(tmp, historyFile);
}

function appendRunLog(line, logDir = path.join(PROJECT_ROOT, "log"), at = new Date()) {
  const file = path.join(logDir, `log-audit.${dayKey(at)}.log`);
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

// The 30-day claim is about days *monitored*, not days elapsed. A week of
// missed cron runs leaves the counter low, so printing the calendar span next
// to it exposes the gap instead of hiding it behind a growing date range.
export function monitoringProgress(
  dayKeys = [],
  firstRunIso,
  now = new Date(),
  target = TARGET_DAYS,
) {
  const monitored = dayKeys.length;
  const start = firstRunIso ? new Date(firstRunIso) : now;
  const dayMs = 24 * 3600 * 1000;
  const elapsed = Math.max(1, Math.floor((now.getTime() - start.getTime()) / dayMs) + 1);
  return { monitored, elapsed, target };
}

export function renderPersistentSignatures(rows = [], display = (p) => p) {
  if (rows.length === 0) return [];
  return [
    "## Not yet eliminated",
    "",
    "| project | signature | days seen | first seen | total lines | sample |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${display(row.project)} | ${row.id} | ${row.daysSeen} | ${String(row.firstSeen).slice(0, 10)} | ${row.count} | ${String(
          row.sample,
        )
          .replace(/\|/g, "\\|")
          .slice(0, 100)} |`,
    ),
    "",
  ];
}

// Days a signature has been seen, as a sorted set. A signature that reappears
// after quiet days must keep the earlier days: seeding from `firstSeen` when an
// older entry has no `days` field is what stops the count from restarting.
export function mergeSignatureDays(prior, day) {
  const days = new Set(
    prior?.days ?? (prior?.firstSeen ? [dayKey(new Date(prior.firstSeen))] : []),
  );
  days.add(day);
  return [...days].sort();
}

// "Eliminated" is a claim about persistence, not about one quiet day. A
// signature seen on two or more distinct days has survived at least one
// attempted fix window, so it is the set that must still be driven to zero.
export function summarizePersistentSignatures(signatures = {}, { minDays = 2, limit = 15 } = {}) {
  return Object.entries(signatures)
    .map(([id, entry]) => ({
      id,
      project: entry.project ?? "-",
      daysSeen: (entry.days ?? []).length,
      firstSeen: entry.firstSeen ?? "",
      count: entry.count ?? 0,
      sample: entry.sample ?? "",
    }))
    .filter((row) => row.daysSeen >= minDays)
    .sort((a, b) => b.daysSeen - a.daysSeen || b.count - a.count)
    .slice(0, limit);
}

// readdir can fail because the directory is protected (a real blind spot) or
// because it was removed after enumeration (a race with another project's
// tests). Only the first one hides errors and belongs in the report.
export function isVanishedDirError(code) {
  return code === "ENOENT";
}

// A log dir that cannot be listed hides every error of the project behind it.
// Rendering the gap explicitly is what stops a report from looking complete
// while a project was never read.
// A directory that disappears between discovery and read is not the same as a
// protected one: nothing there was audited either, but the cause (deleted, or
// unmounted) is different and the reader needs to know which. Naming both keeps
// the daily "is anything hidden?" question answerable without re-running the scan.
export function renderCoverageGaps(unreadable = [], vanished = []) {
  if (unreadable.length === 0 && vanished.length === 0) return [];
  return [
    "## Coverage gaps",
    "",
    ...unreadable.map((dir) => `- ${dir}: not readable, errors in it are NOT audited`),
    ...vanished.map((dir) => `- ${dir}: disappeared during the scan, errors in it are NOT audited`),
    "",
  ];
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

// Project label relative to whichever audited root it lives under, so the
// report stays readable across the four trees.
export function displayProject(project, roots) {
  const label = (() => {
    for (const root of roots) {
      if (project.startsWith(`${root}/`)) return project.slice(root.length + 1);
    }
    return project;
  })();
  // Several ai-users keep their Linux HOME below the audited roots, and
  // services started from $HOME write `~/log/*`. Without this marker such a
  // directory looks like a separate project: repo-updater and
  // poly-account-data each appeared twice, splitting one project's errors
  // across two rows. The marker keeps the counts intact but tells the reader
  // that the row is a home directory, not a checkout.
  return isHomeDirectory(project) ? `${label} (home)` : label;
}

function isHomeDirectory(dir) {
  try {
    if (fs.existsSync(path.join(dir, ".git"))) return false;
    return (
      fs.existsSync(path.join(dir, ".bashrc")) ||
      fs.existsSync(path.join(dir, ".bash_profile")) ||
      fs.existsSync(path.join(dir, ".profile"))
    );
  } catch {
    return false;
  }
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
  roots,
  pending = [],
  persistent = [],
}) {
  const lines = [];
  const totalErrors = groups.reduce((sum, g) => sum + g.errors, 0);
  const totalWarns = groups.reduce((sum, g) => sum + g.warns, 0);
  const display = (project) => displayProject(project, roots);
  lines.push(`# AI user log audit ${day}`);
  lines.push("");
  lines.push(`- run: ${startedAt.toISOString()}`);
  lines.push(`- window since: ${new Date(sinceMs).toISOString()}`);
  const progress = monitoringProgress(Object.keys(state.days), state.firstRun, startedAt);
  lines.push(`- monitored days: ${progress.monitored}`);
  lines.push(
    `- monitoring progress: ${progress.monitored}/${TARGET_DAYS} days (calendar ${progress.elapsed} day(s) since ${(state.firstRun ?? startedAt.toISOString()).slice(0, 10)}; target day: ${TARGET_DAYS} run days)`,
  );
  lines.push(
    `- log dirs: ${scan.logDirs}, files read: ${scan.filesRead}, files skipped: ${scan.filesSkipped}, stale lines ignored: ${scan.staleMatches}`,
  );
  lines.push(
    `- unreadable log dirs: ${scan.unreadableDirs.length}, vanished mid-scan: ${(scan.vanishedDirs ?? []).length}`,
  );
  lines.push(
    `- findings: error lines ${totalErrors}, warn lines ${totalWarns}, projects with errors ${groups.length}`,
  );
  lines.push(
    `- multi-sink duplicates collapsed: ${scan.duplicateMatches ?? 0} (same record written to more than one log file)`,
  );
  lines.push("");
  lines.push(...renderCoverageGaps(scan.unreadableDirs, scan.vanishedDirs ?? []));
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
  if (pending.length > 0) {
    lines.push("## Pending issue targets");
    lines.push("");
    lines.push("| issue | target | status | error lines today | matched projects |");
    lines.push("|---|---|---|---|---|");
    for (const row of pending) {
      lines.push(
        `| ${row.id} | ${row.target} | ${row.status} | ${row.errors} | ${row.projects.join("<br>") || "-"} |`,
      );
    }
    lines.push("");
  }
  if (persistent.length > 0) {
    lines.push(...renderPersistentSignatures(persistent, display));
  }
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
  // Injectable clock and output roots so the whole pipeline can be exercised
  // against fixtures in tests/.tmp-*/: the production defaults are unchanged,
  // and the tests prove classification, the day counter and the persistence
  // table without waiting a day for a real cron run.
  const now = options.now instanceof Date ? options.now : new Date();
  const day = dayKey(now);
  const auditDir = options.auditDir ?? path.join(PROJECT_ROOT, "audit");
  const issuesDir = options.issuesDir ?? path.join(PROJECT_ROOT, "issues");
  const logDir = options.logDir ?? path.join(PROJECT_ROOT, "log");
  const stateFile = path.join(auditDir, "state.json");
  const reportFile = path.join(auditDir, "reports", `log-audit.${day}.md`);
  const historyFile = path.join(auditDir, "findings.jsonl");

  const state = loadState(stateFile);
  // A fixed trailing window keeps every run comparable: an incremental
  // "since last run" window makes a manual re-run overwrite the daily report
  // with a few minutes of data. The 30-day counter lives in `state.days`.
  const sinceMs = now.getTime() - cfg.windowHours * 3600 * 1000;

  const scan = {
    logDirs: 0,
    filesRead: 0,
    filesSkipped: 0,
    staleMatches: 0,
    duplicateMatches: 0,
    skipped: {},
    // A log dir that cannot be listed is a blind spot for the whole project it
    // belongs to: silently `continue`-ing would let the report claim full
    // coverage while a project's errors were never read.
    unreadableDirs: [],
    // Directories that vanished between discovery and readdir: evidence of a
    // race with a neighbour's tests, not of missing log coverage.
    vanishedDirs: [],
  };
  const groups = new Map(); // project -> aggregate
  const signatureStats = new Map(); // signature -> { count, project, samples }
  // (project, timestamp+text) -> first file that carried the record, used to
  // collapse multi-sink duplicates.
  const recordFiles = new Map();

  const logDirs = cfg.roots.flatMap((root) =>
    discoverLogDirs(root, cfg.maxDepth, cfg.skipDirs, cfg.skipLogParents),
  );
  scan.logDirs = logDirs.length;

  for (const logDir of logDirs) {
    const project = projectRootOf(logDir);
    const collected = await collectLogFiles(
      logDir,
      cfg.logSubdirDepth ?? 0,
      cfg.skipLogSubdirs ?? new Set(),
    );
    scan.unreadableDirs.push(...collected.unreadableDirs);
    scan.vanishedDirs.push(...collected.vanishedDirs);
    for (const file of collected.files) {
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
          // One loguru record can reach several sinks (e.g. `task_<day>.log`
          // and `error_<day>.log`), which made the audit count the same event
          // twice — get-task-from-notion reported 4 errors where only 2
          // distinct records existed. Collapse a record seen in a *different*
          // file of the same project; repeats inside one file are kept, since
          // those are genuinely re-logged events.
          const recordKey = `${parseLeadingTimestamp(text) ?? parseJsonTimestamp(text) ?? ""}\u0000${text.trim()}`;
          const scopedKey = `${project}\u0000${recordKey}`;
          const firstFile = recordFiles.get(scopedKey);
          if (firstFile !== undefined && firstFile !== file) {
            scan.duplicateMatches += 1;
            return;
          }
          recordFiles.set(scopedKey, file);
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
    const prior = seen[sig];
    const firstSeen = prior?.firstSeen ?? now.toISOString();
    // Distinct days a signature appeared, not the calendar span since it was
    // first seen: an error that hit on day 1 and again on day 20 is not a
    // 20-day-old problem, and calling it one would overstate what is stuck.
    const days = mergeSignatureDays(prior, day);
    state.signatures = state.signatures ?? {};
    state.signatures[sig] = {
      project: stats.project,
      firstSeen,
      lastSeen: now.toISOString(),
      count: (prior?.count ?? 0) + stats.count,
      days,
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
  const display = (project) => displayProject(project, cfg.roots);
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
  // Filed issues live in audit/pending-issues.json so every run prints their
  // current error count; without it "is the fix working yet?" needs a manual
  // diff of the whole report.
  let pendingEntries = [];
  try {
    pendingEntries = JSON.parse(
      fs.readFileSync(path.join(auditDir, "pending-issues.json"), "utf8"),
    );
  } catch {
    // Missing or invalid ledger: report no pending rows rather than fail a scan.
  }
  const pending = summarizePendingIssues(
    pendingEntries,
    projectGroups.map((group) => ({ name: display(group.project), errors: group.errors })),
  );
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
      roots: cfg.roots,
      pending,
      persistent: summarizePersistentSignatures(state.signatures),
    }),
  );
  writeDailyFindings(historyFile, day, projectGroups);

  const summary = `day=${day} monitored_days=${Object.keys(state.days).length} log_dirs=${scan.logDirs} unreadable_dirs=${scan.unreadableDirs.length} vanished_dirs=${(scan.vanishedDirs ?? []).length} files_read=${scan.filesRead} error_lines=${projectGroups.reduce((s, g) => s + g.errors, 0)} projects_with_errors=${projectGroups.length}`;
  appendRunLog(`${now.toISOString()} ${summary}`, logDir, now);

  // Feedback loop: a daily digest in `issues/` is picked up by the project
  // monitor and turned into a triage task. Without it the cron scan would
  // collect reports nobody reviews, and errors would never be eliminated.
  // Once the day's digest is archived the to-do is done, so a manual re-run
  // must not recreate it (that would re-triage the same content and keep
  // `issues/` from ever reaching zero).
  const endTaskDir = options.endTaskDir ?? path.join(PROJECT_ROOT, "end_task");
  const errorProjects = projectGroups.map((group) => display(group.project));
  if (
    cfg.writeIssueDigest &&
    projectGroups.length > 0 &&
    !isDigestArchived(endTaskDir, day, errorProjects)
  ) {
    const digestFile = path.join(issuesDir, `log-audit-${day}.md`);
    let triageText = "";
    try {
      triageText = fs.readFileSync(path.join(auditDir, "triage.md"), "utf8");
    } catch {
      // No ledger yet: every project is untriaged, which is the honest answer.
    }
    const untriaged = findUntriagedProjects(errorProjects, triageText);
    writeFileAtomic(
      digestFile,
      renderDigest({ day, summary, groups: projectGroups, roots: cfg.roots, untriaged, pending }),
    );
    appendRunLog(
      `${now.toISOString()} digest=${digestFile} untriaged=${untriaged.length}${untriaged.length > 0 ? ` [${untriaged.join("; ")}]` : ""}`,
      logDir,
      now,
    );
  }

  return { day, reportFile, stateFile, summary, groups: projectGroups, state, scan };
}

// The digest is a to-do handed to the project monitor: it is written to
// `issues/`, triaged into `audit/triage.md`, then archived under `end_task/`.
// A manual re-run used to recreate the file, so the same digest got triaged
// twice and `issues/` never stayed empty. Once the day's digest is archived,
// later runs only refresh the report.
//
// Archiving the morning digest must not blind the later runs: a project that
// starts failing at 10:00 appears only in the 13:00 report, and its triage
// to-do has to be filed even though the day already has an archive. So the
// archive counts as done only when it already names every project in the
// current report; anything new re-opens the digest.
export function isDigestArchived(endTaskDir, day, projects = [], exists = (p) => fs.existsSync(p)) {
  const name = `log-audit-${day}.md`;
  let entries;
  try {
    entries = fs.readdirSync(endTaskDir, { withFileTypes: true });
  } catch {
    return false;
  }
  const archived = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(endTaskDir, entry.name, name))
    .find((candidate) => exists(candidate));
  if (archived === undefined) return false;
  if (projects.length === 0) return true;
  let text;
  try {
    text = fs.readFileSync(archived, "utf8");
  } catch {
    return false;
  }
  // Match on the directory basename with the ` (home)` display label removed:
  // the label was added after some digests were written, and a path can move
  // one level up or down without becoming a different project. Comparing full
  // paths would re-file the whole digest for a pure label change.
  const baseOf = (name) => path.basename(String(name).replace(/\s+\(home\)$/, ""));
  return projects.every((project) => text.includes(baseOf(project)));
}

// A project that reports errors but has no row in `audit/triage.md` is a gap:
// the daily digest is the only place where the next session learns which
// projects still need a verdict. Matching is by directory basename because the
// ledger records short names while the report records absolute paths.
export function findUntriagedProjects(projects, triageText) {
  const ledger = String(triageText ?? "");
  return projects.filter((name) => {
    // The report tags logs found under a user's home directory as
    // "<project> (home)". The suffix is a display hint, not part of the
    // project name, so it must be stripped before matching the ledger —
    // otherwise every home-directory project looks untriaged forever.
    const cleaned = String(name).replace(/\s+\(home\)$/, "");
    const base = path.basename(cleaned);
    return base !== "" && !ledger.includes(base);
  });
}

// Filed issues need a daily number, otherwise "is it getting better?" costs a
// manual diff of a 25-row report. The ledger of open issues lives in
// audit/pending-issues.json; each entry matches display project names.
// Match strings are written by whoever filed the issue, sometimes as the
// absolute-ish path under an audited root (`dev/qa/check-funding_rate_api/...`)
// and sometimes as the display name the report prints (`qa/check-funding_rate_api/...`).
// Comparing them verbatim silently reports 0 errors for the biggest sources —
// a 502-line project looked clean — so both sides are normalised: drop the
// audited-root prefix and the ` (home)` display label.
const AUDIT_ROOT_PREFIX = /^(?:dev|regular_task|release|quant|ai|bdt2cpp|hftapi|history_data)\//;

export function normalizeProjectName(name) {
  let out = String(name ?? "")
    .trim()
    .replace(/\s+\(home\)$/, "");
  while (AUDIT_ROOT_PREFIX.test(out)) out = out.replace(AUDIT_ROOT_PREFIX, "");
  return out;
}

export function summarizePendingIssues(entries, projects) {
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const matches = Array.isArray(entry?.match) ? entry.match : [entry?.match].filter(Boolean);
    if (matches.length === 0) continue;
    const wanted = matches.map(normalizeProjectName).filter((m) => m !== "");
    const hit = projects.filter((project) => {
      const name = normalizeProjectName(project.name);
      return wanted.some((m) => name.includes(m));
    });
    rows.push({
      id: String(entry.id ?? "-"),
      target: String(entry.target ?? matches.join(" / ")),
      status: String(entry.status ?? "-"),
      errors: hit.reduce((sum, project) => sum + project.errors, 0),
      projects: hit.map((project) => project.name),
    });
  }
  return rows;
}

function renderDigest({ day, summary, groups, roots, untriaged = [], pending = [] }) {
  const display = (project) => displayProject(project, roots);
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
  lines.push("## 未登记台账的项目");
  lines.push("");
  if (untriaged.length === 0) {
    lines.push("无：全部报错项目在 `audit/triage.md` 已有判定行。");
  } else {
    lines.push("以下项目本轮有报错但台账无判定行，必须补行后再删除本文件：");
    lines.push("");
    for (const name of untriaged) lines.push(`- ${name}`);
  }
  lines.push("");
  lines.push("## 已提 issue 的目标项目");
  lines.push("");
  if (pending.length === 0) {
    lines.push("无在册 issue（`audit/pending-issues.json` 为空或缺失）。");
  } else {
    lines.push("| issue | 目标项目 | 状态 | 当日 error 行 | 命中项目 |");
    lines.push("|---|---|---|---|---|");
    for (const row of pending) {
      lines.push(
        `| ${row.id} | ${row.target} | ${row.status} | ${row.errors} | ${row.projects.join("<br>") || "-"} |`,
      );
    }
    lines.push("");
    lines.push("对比上一日同表即可判定修复是否生效；归零后把该行状态改为 `待验证`/`closed`。");
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
