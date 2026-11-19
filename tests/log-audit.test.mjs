import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyLine,
  normalizeSignature,
  signatureOf,
  dayKey,
  projectRootOf,
  parseLeadingTimestamp,
  parseJsonTimestamp,
  discoverLogDirs,
  diffProjectCounts,
  findUntriagedProjects,
  summarizePendingIssues,
  renderCoverageGaps,
  monitoringProgress,
  summarizePersistentSignatures,
  renderPersistentSignatures,
  mergeSignatureDays,
  run,
} from "../scripts/audit-ai-logs.mjs";

test("classifyLine flags real error shapes", () => {
  const errors = [
    "2026-11-19 01:02:03 [ERROR] load failed: missing column",
    "ERROR: connection refused",
    '{"level":"fatal","msg":"disk full"}',
    '{"level":"error","msg":"disk full"}',
    "ts=2026-11-19 level=error msg=boom",
    "Traceback (most recent call last):",
    "FileNotFoundError: [Errno 2] No such file or directory: 'x.csv'",
    "KeyError: 'trade_date'",
    "ValueError: invalid literal for int()",
    "panic: runtime error: index out of range",
    "UnhandledPromiseRejection: TypeError: x is not a function",
    "Error: connect ECONNREFUSED 127.0.0.1:443",
  ];
  for (const line of errors) assert.equal(classifyLine(line), "error", `expected error: ${line}`);
});

test("classifyLine does not treat prose, paths or warnings as errors", () => {
  const neutral = [
    "2026-11-18 00:05:06 | INFO | scanner: found AI project: /mnt/x/ana-daily-error/y",
    "248 |         # 故非 error 级真实故障，保留 warning 记录",
    '{"errors":0,"checked":120}',
    "[INFO] we find 0 error in today's batch",
  ];
  for (const line of neutral) assert.equal(classifyLine(line), null, `expected null: ${line}`);
  assert.equal(classifyLine("2026-11-18 05:28:29 [WARNING] failed to parse xrp-updown"), "warn");
});

test("classifyLine keeps warnings out of the error bucket", () => {
  assert.equal(classifyLine("2026-11-19 [WARN] retry 1/3 after timeout"), "warn");
  assert.equal(classifyLine("WARNING: deprecated config key"), "warn");
});

test("classifyLine drops counted-zero noise and code identifiers", () => {
  const noise = [
    "[INFO] we find 0 error in today's batch",
    '{"errors":0,"checked":120}',
    "no error detected in 42 shards",
    "error_count=0",
    "error_rate=0.0000",
    "error=null",
    "def parse_error(self, payload):",
    "function handleError(payload) {",
    "SIM105 Use `contextlib.suppress(OSError)` instead of `try`-`except`-`pass`",
  ];
  for (const line of noise) assert.equal(classifyLine(line), null, `expected noise: ${line}`);
  assert.equal(classifyLine(""), null);
  assert.equal(classifyLine("all good"), null);
});

test("classifyLine drops pass verdicts and zero counters", () => {
  const noise = [
    "[2026-11-19 06:20:42] [PASS] [stage:v1] round 1 无 LoadError、单激活、单次注入",
    '{"status": "PASS", "checks": [{"expected": "日志不含 ERROR 级别"}]}',
    "2026-11-19 02:30:04.435 +00:00 | INFO | __main__:main:591 - check done: ERROR 0 / WARN 0 / INFO 0",
  ];
  for (const line of noise) assert.equal(classifyLine(line), null, `expected noise: ${line}`);
  // Nonzero counters and real failures still count.
  assert.equal(classifyLine("check done: ERROR 3 / WARN 0 / INFO 0"), "error");
  assert.equal(
    classifyLine("[2026-11-19 06:16:49] [ERROR] [stage:verify-list] opencode debug info 执行失败"),
    "error",
  );
});

test("classifyLine judges structured records by declared level/status", () => {
  const pass = JSON.stringify({ status: "PASS", checks: [{ expected: "日志含 ERROR 级别" }] });
  assert.equal(classifyLine(pass), null);
  assert.equal(classifyLine(JSON.stringify({ status: "FAIL", checks: [] })), "error");
  assert.equal(classifyLine(JSON.stringify({ level: "error", msg: "boom" })), "error");
  assert.equal(classifyLine(JSON.stringify({ level: "info", msg: "ok" })), null);
});

test("classifyLine trusts the logged level column over the message body", () => {
  // log-daily-alter writes a config dump; the words are levels, the record is INFO.
  assert.equal(
    classifyLine(
      "2026-11-19 06:25:03.632 +00:00 | INFO     | __main__:main:889 - alert_levels: ['ERROR', 'WARNING', 'CRITICAL']",
    ),
    null,
  );
  assert.equal(
    classifyLine("2026-11-19 06:25:03.632 +00:00 | WARNING  | main:1 - retry after ERROR budget"),
    "warn",
  );
  assert.equal(
    classifyLine("2026-11-18 07:00:05.381 +00:00 | ERROR    | loader:133 - dropped 156 rows"),
    "error",
  );
  // Bracket-style loggers put the level in `[LEVEL]` right after the timestamp.
  assert.equal(classifyLine("[2026-11-19 06:47:49] [INFO] 窗口内无 ERROR"), null);
  assert.equal(classifyLine("[2026-11-19 06:16:49] [ERROR] load failed"), "error");
  assert.equal(classifyLine("[2026-11-19 06:16:49] [WARN] retry"), "warn");
});

test("parseJsonTimestamp reads the record timestamp for window filtering", () => {
  const old = '{"status": "FAIL", "timestamp": "2026-11-18T02:00:02.536018", "checks": []}';
  assert.equal(parseJsonTimestamp(old), Date.parse("2026-11-18T02:00:02.536"));
  assert.equal(parseJsonTimestamp('{"status": "PASS"}'), null);
  assert.equal(parseJsonTimestamp("not json"), null);
});

test("summarizePendingIssues sums today's error lines per filed issue", () => {
  const entries = [
    { id: "aaa", target: "poly", match: ["poly/poly-account-data"] },
    { id: "bbb", target: "listen", match: ["replay-tg-msg/listen_msg_from_tg"] },
    { id: "ccc", target: "gone", match: ["no/such-project"] },
  ];
  const projects = [
    { name: "poly/poly-account-data", errors: 368 },
    { name: "poly/poly-account-data/poly-account-data", errors: 56 },
    { name: "replay-tg-msg/listen_msg_from_tg", errors: 3 },
  ];
  const rows = summarizePendingIssues(entries, projects);
  assert.equal(rows[0].errors, 424);
  assert.deepEqual(rows[0].projects, [
    "poly/poly-account-data",
    "poly/poly-account-data/poly-account-data",
  ]);
  assert.equal(rows[1].errors, 3);
  // An issue whose target stopped logging reports zero instead of vanishing.
  assert.equal(rows[2].errors, 0);
  assert.deepEqual(summarizePendingIssues(null, projects), []);
});

test("findUntriagedProjects flags projects missing from the triage ledger", () => {
  const ledger = [
    "| poly/poly-account-data | 779e6546812a | 真实缺陷 | issue | open |",
    "| qa/check-logroll/check-logroll | ed3948557957 | closed |",
  ].join("\n");
  assert.deepEqual(
    findUntriagedProjects(["poly/poly-account-data", "qa/check-logroll"], ledger),
    [],
  );
  assert.deepEqual(
    findUntriagedProjects(["poly/poly-account-data", "new-project/new-project"], ledger),
    ["new-project/new-project"],
  );
  assert.deepEqual(findUntriagedProjects(["x/y"], ""), ["x/y"]);
});

test("normalizeSignature collapses timestamps, ids and paths", () => {
  const a =
    "2026-11-19T01:02:03Z session ses_19cdc6c20ffeI2WuZ5rzKn47at failed to read /data/x/1.csv pid=4242 after 12 ms";
  const b =
    "2026-11-20T11:22:33Z session ses_aaaaaaaaaaaa failed to read /data/y/2.csv pid=9 after 7 ms";
  assert.equal(normalizeSignature(a), normalizeSignature(b));
  assert.ok(!normalizeSignature(a).includes("4242"));
});

test("signatureOf separates projects and root causes", () => {
  const line = "FileNotFoundError: missing config";
  assert.equal(signatureOf("/a", line), signatureOf("/a", line));
  assert.notEqual(signatureOf("/a", line), signatureOf("/b", line));
  assert.notEqual(signatureOf("/a", line), signatureOf("/a", "KeyError: missing config"));
});

test("dayKey uses local calendar day", () => {
  assert.equal(dayKey(new Date(2026, 10, 19, 23, 59, 59)), "20261119");
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 0, 0)), "20260101");
});

test("projectRootOf stops at the project marker", () => {
  const marker = new Set(["/srv/p/memory/root.md", "/srv/p/.git"]);
  const exists = (p) => marker.has(p);
  assert.equal(projectRootOf("/srv/p/log", exists), "/srv/p");
  // No marker: fall back to the parent of the log dir.
  assert.equal(projectRootOf("/srv/plain/log", exists), "/srv/plain");
});

test("parseLeadingTimestamp reads common log prefixes", () => {
  const iso = parseLeadingTimestamp("2026-11-19T05:32:48.981Z [ERROR] boom");
  assert.equal(iso, Date.parse("2026-11-19T05:32:48.981"));
  assert.equal(
    parseLeadingTimestamp("2026-11-18 05:28:29,971 [WARNING] failed"),
    Date.parse("2026-11-18T05:28:29.971"),
  );
  assert.equal(
    parseLeadingTimestamp("[2026-11-19T02:00:41.383091Z] [ERROR] judge FAIL"),
    Date.parse("2026-11-19T02:00:41.383"),
  );
  assert.equal(
    parseLeadingTimestamp("2026-11-18 00:00:06.709 +00:00 | ERROR | dropped"),
    Date.parse("2026-11-18T00:00:06.709"),
  );
});

test("parseLeadingTimestamp returns null for continuation lines", () => {
  assert.equal(parseLeadingTimestamp("Traceback (most recent call last):"), null);
  assert.equal(parseLeadingTimestamp('  File "x.py", line 3, in <module>'), null);
  assert.equal(parseLeadingTimestamp(""), null);
});

// Fixtures must live inside the project (tests/.tmp-*): writing them to the
// system temp dir is forbidden, and a rejected fixture leaves no trace behind.
function makeFixtureDir(prefix) {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  return fs.mkdtempSync(path.join(dirname, `.tmp-${prefix}-`));
}

test("discoverLogDirs reaches depth-6 project logs", async () => {
  const tmp = makeFixtureDir("audit-depth");
  try {
    const deep = path.join(tmp, "group", "repo", "proj", "proj2");
    await fs.promises.mkdir(path.join(deep, "log"), { recursive: true });
    await fs.promises.mkdir(path.join(tmp, "group", "repo", "proj", "log"), { recursive: true });
    const found = discoverLogDirs(tmp, 6, new Set([".git"]), new Set(["scripts"]));
    assert.equal(found.length, 2, `expected 2 log dirs, got ${found.length}`);
    assert.ok(found.some((d) => d.endsWith(path.join("proj", "proj2", "log"))));
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("discoverLogDirs skips .local homes and scripts/log", async () => {
  const tmp = makeFixtureDir("audit-skip");
  try {
    const skipDirs = new Set([".local", ".git"]);
    const skipLogParents = new Set(["scripts"]);
    await fs.promises.mkdir(path.join(tmp, "acct", ".local", "share", "tool", "log"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tmp, "acct", ".local", "bin", "log"), { recursive: true });
    await fs.promises.mkdir(path.join(tmp, "proj", "scripts", "log"), { recursive: true });
    await fs.promises.mkdir(path.join(tmp, "proj", "log"), { recursive: true });
    const found = discoverLogDirs(tmp, 6, skipDirs, skipLogParents);
    assert.deepEqual(
      found.map((d) => path.relative(tmp, d)),
      [path.join("proj", "log")],
    );
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("diffProjectCounts reports eliminated, new and changed projects", () => {
  const rows = diffProjectCounts(
    { "a/proj": 10, "b/proj": 3, "c/proj": 1 },
    { "a/proj": 4, "b/proj": 3, "d/proj": 2 },
  );
  assert.deepEqual(
    rows.map((row) => [row.project, row.previous, row.current, row.delta]),
    [
      ["d/proj", 0, 2, 2],
      ["c/proj", 1, 0, -1],
      ["a/proj", 10, 4, -6],
    ].sort((x, y) => Math.abs(y[3]) - Math.abs(x[3]) || x[0].localeCompare(y[0])),
  );
  assert.deepEqual(diffProjectCounts({}, {}), []);
});

test("renderCoverageGaps surfaces unreadable log dirs and stays quiet otherwise", () => {
  assert.deepEqual(renderCoverageGaps(), []);
  assert.deepEqual(renderCoverageGaps([]), []);
  const lines = renderCoverageGaps(["/x/y/log"]);
  assert.equal(lines[0], "## Coverage gaps");
  assert.ok(lines.includes("- /x/y/log: not readable, errors in it are NOT audited"));
});

test("monitoringProgress separates monitored days from calendar days", () => {
  assert.deepEqual(
    monitoringProgress(["20261119"], "2026-11-19T05:37:44Z", new Date("2026-11-19T09:00:00Z")),
    { monitored: 1, elapsed: 1, target: 30 },
  );
  const gap = monitoringProgress(
    ["20261119"],
    "2026-11-19T05:37:44Z",
    new Date("2026-11-25T09:00:00Z"),
  );
  assert.equal(gap.monitored, 1);
  assert.equal(gap.elapsed, 7);
});

test("summarizePersistentSignatures keeps only signatures seen on 2+ days", () => {
  const sigs = {
    aaaa: { project: "p1", days: ["20261119"], count: 5, sample: "one day only" },
    bbbb: { project: "p2", days: ["20261118", "20261119"], count: 9, sample: "two days" },
    cccc: { project: "p3", days: ["20261116", "20261117", "20261119"], count: 2, sample: "three" },
  };
  const rows = summarizePersistentSignatures(sigs);
  assert.deepEqual(
    rows.map((r) => [r.id, r.daysSeen]),
    [
      ["cccc", 3],
      ["bbbb", 2],
    ],
  );
  assert.equal(rows[1].project, "p2");
  assert.equal(summarizePersistentSignatures({}, { minDays: 1 }).length, 0);
  assert.equal(summarizePersistentSignatures(sigs, { limit: 1 }).length, 1);
});

test("renderPersistentSignatures escapes pipes and renders nothing when empty", () => {
  assert.deepEqual(renderPersistentSignatures([]), []);
  const lines = renderPersistentSignatures(
    [
      {
        id: "bbbb",
        project: "/x/p2",
        daysSeen: 3,
        firstSeen: "2026-11-18T00:00:00Z",
        count: 9,
        sample: "a|b failed",
      },
    ],
    () => "p2",
  );
  assert.equal(lines[0], "## Not yet eliminated");
  assert.equal(lines[4], "| p2 | bbbb | 3 | 2026-11-18 | 9 | a\\|b failed |");
});

test("mergeSignatureDays accumulates distinct days and survives gaps", () => {
  assert.deepEqual(mergeSignatureDays(undefined, "20261119"), ["20261119"]);
  assert.deepEqual(mergeSignatureDays({ firstSeen: "2026-11-19T05:00:00Z" }, "20261119"), [
    "20261119",
  ]);
  assert.deepEqual(
    mergeSignatureDays(
      { days: ["20261119", "20261121"], firstSeen: "2026-11-19T05:00:00Z" },
      "20261122",
    ),
    ["20261119", "20261121", "20261122"],
  );
  // Same-day re-runs must not inflate the count.
  assert.deepEqual(mergeSignatureDays({ days: ["20261119"] }, "20261119"), ["20261119"]);
  // A legacy entry without `days` keeps the day it was first seen.
  assert.deepEqual(mergeSignatureDays({ firstSeen: "2026-11-18T23:00:00Z" }, "20261119"), [
    "20261118",
    "20261119",
  ]);
});

// End-to-end: the daily report is the evidence for both "errors are gone" and
// "days monitored", so the whole pipeline runs twice on fixtures — one day
test("run() two consecutive days: counts, day counter and persistence table", async () => {
  const dirname = path.dirname(new URL(import.meta.url).pathname);
  const root = fs.mkdtempSync(path.join(dirname, ".tmp-audit-e2e-"));
  const dayA = new Date(2026, 10, 19, 10, 0, 0);
  const dayB = new Date(2026, 10, 20, 10, 0, 0);
  const two = (n) => String(n).padStart(2, "0");
  const stamp = (d) =>
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.000 +00:00`;
  const projectLog = path.join(root, "proj", "log");
  const opts = {
    roots: [root],
    auditDir: path.join(root, "audit"),
    issuesDir: path.join(root, "issues"),
    logDir: path.join(root, "log"),
  };
  const writeDay = (when) => {
    const file = path.join(projectLog, "app.log");
    fs.mkdirSync(projectLog, { recursive: true });
    fs.writeFileSync(
      file,
      [
        `${stamp(when)} | ERROR    | mod:fn:1 - boom one`,
        `${stamp(when)} | INFO     | mod:fn:2 - steady`,
        "[PASS] all checks good, errors=0",
        `${stamp(new Date(2026, 9, 1, 10, 0, 0))} | ERROR    | mod:fn:3 - long gone`,
        "",
      ].join("\n"),
    );
    fs.utimesSync(file, when, when);
  };
  try {
    writeDay(dayA);
    const first = await run({ ...opts, now: dayA });
    assert.equal(first.groups.length, 1);
    assert.equal(first.groups[0].errors, 1, "only the in-window ERROR line counts");
    const reportA = fs.readFileSync(first.reportFile, "utf8");
    assert.match(reportA, /monitoring progress: 1\/30/);
    assert.match(reportA, /findings: error lines 1/);
    assert.equal(
      reportA.includes("## Not yet eliminated"),
      false,
      "one day cannot show persistence",
    );
    assert.equal(
      fs.existsSync(path.join(opts.issuesDir, `log-audit-${first.day}.md`)),
      true,
      `digest for ${first.day} expected in ${opts.issuesDir}`,
    );

    writeDay(dayB);
    const second = await run({ ...opts, now: dayB });
    assert.equal(second.groups[0].errors, 1);
    const reportB = fs.readFileSync(second.reportFile, "utf8");
    assert.match(reportB, /monitoring progress: 2\/30/);
    assert.match(reportB, /## Change vs 20261119/);
    assert.match(reportB, /## Not yet eliminated/);
    assert.match(reportB, /boom one/);
    const sig = Object.values(second.state.signatures).find((s) => s.days?.length === 2);
    assert.ok(sig, "signature seen on both days records both days");
    assert.deepEqual(sig.days, ["20261119", "20261120"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
