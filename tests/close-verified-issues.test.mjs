import assert from "node:assert/strict";
import test from "node:test";

import {
  errorTotal,
  evaluateClosures,
  invalidIds,
  normalizeRow,
  parseReportCounts,
} from "../scripts/close-verified-issues.mjs";

// The report that triggered this fix: repo-updater is checked out in two roots,
// so the same project owns two rows (663 + 396). Grading only the dev row would
// close the ledger while the second root still logged 396 errors.
const REPORT = `# AI user log audit 20261119

| project | error lines | warn lines | files | new signatures | top signature |
|---|---|---|---|---|---|
| shell-tools/repo-updater/repo-updater | 663 | 5955 | 3 | 0 | boom |
| shell-tools/repo-updater (home) | 396 | 3058 | 1 | 0 | boom |
| poly/poly-account-data/poly-account-data | 426 | 0 | 20 | 0 | boom |

## Pending issue targets

| id | target | status | lines | match |
|---|---|---|---|---|
| 6f10ee5e | repo-updater | verifying | 1059 | shell-tools/repo-updater |

## Resolved since last run

| project | signature | last seen | total lines | sample |
|---|---|---|---|---|
| agents-tools/plugin/opencode-auto-compact | 92083d1d70f0 | 2026-11-19T13:00:04 | 5 | reason: x |
`;

test("parseReportCounts reads only the error table", () => {
  const counts = parseReportCounts(REPORT);
  assert.equal(counts.get("shell-tools/repo-updater/repo-updater"), 663);
  assert.equal(counts.get("shell-tools/repo-updater (home)"), 396);
  // Pending/resolved tables start with an id or a signature, never `<name>|<n>|`.
  assert.equal(counts.has("6f10ee5e"), false);
  assert.equal(counts.has("agents-tools/plugin/opencode-auto-compact"), false);
});

test("parseReportCounts ignores the change table's previous-window counts", () => {
  // 2026-11-21 production: a project fixed today appears as
  // `| proj | 1 | 0 | -1 |` (previous=1, current=0). The old first-two-cells
  // regex read 1 as today's count and blocked the close; a project broken today
  // appears as `| proj | 0 | 87 | +87 |`, which it read as 0 and would have
  // closed while 87 lines were current.
  const report = `| project | error lines | warn lines | files | new signatures | top signature |
|---|---|---|---|---|
| a/live | 3 | 4 | 1 | 0 | boom |

## Change vs 20261120

| project | previous | current | delta |
|---|---|---|---|
| a/fixed | 1 | 0 | -1 |
| b/broken | 0 | 87 | +87 |
`;
  const counts = parseReportCounts(report);
  assert.equal(counts.get("a/live"), 3);
  assert.equal(counts.has("a/fixed"), false);
  assert.equal(counts.has("b/broken"), false);
});

test("normalizeRow strips the home marker and the audit root", () => {
  assert.equal(normalizeRow("shell-tools/repo-updater (home)"), "shell-tools/repo-updater");
  assert.equal(
    normalizeRow("/mnt/beegfs_data/usr/maxx/dev/poly/poly-account-data (home)"),
    "poly/poly-account-data",
  );
  assert.equal(normalizeRow("  x/y  "), "x/y");
});

test("errorTotal sums every root that belongs to the entry", () => {
  const counts = parseReportCounts(REPORT);
  // This is the regression: 663 alone would look closable.
  assert.deepEqual(errorTotal({ match: ["shell-tools/repo-updater"] }, counts).total, 663 + 396);
  assert.deepEqual(errorTotal({ match: ["poly/poly-account-data"] }, counts).total, 426);
  // An entry without `match` still works off its exact project row.
  assert.deepEqual(
    errorTotal({ closeWhen: { project: "poly/poly-account-data/poly-account-data" } }, counts)
      .total,
    426,
  );
  // A project that vanished from the report is genuinely zero.
  assert.deepEqual(errorTotal({ closeWhen: { project: "gone/project" } }, counts).total, 0);
});

test("errorTotal sums a home row when the ledger match is the nested repo path", () => {
  // Production shape: the ledger entry names the checkout directory while the
  // HOME install appears as its parent. Substring matching missed the second
  // root here even though the unit test above passed, because the test used the
  // shorter parent as `match`.
  const counts = parseReportCounts(REPORT);
  const entry = { match: ["shell-tools/repo-updater/repo-updater"] };
  assert.deepEqual(errorTotal(entry, counts).rows.sort(), [
    "shell-tools/repo-updater (home)",
    "shell-tools/repo-updater/repo-updater",
  ]);
  assert.equal(errorTotal(entry, counts).total, 663 + 396);
  // Path-boundary matching: `a/b` must not absorb `a/bc`.
  const other = parseReportCounts("| shell-tools/repo-updater-extra | 9 | 0 | 1 | 0 | x |\n");
  assert.equal(errorTotal(entry, other).total, 0);
});

test("evaluateClosures stays waiting while either root still logs errors", () => {
  const counts = parseReportCounts(REPORT);
  const entries = [
    {
      id: "a",
      status: "verifying",
      match: ["shell-tools/repo-updater"],
      note: "",
      closeWhen: {
        project: "shell-tools/repo-updater/repo-updater",
        dir: "/tmp/x",
        from: "20261119",
      },
    },
  ];
  const { closed, waiting } = evaluateClosures(entries, counts, "20261120", {
    dirExists: () => true,
  });
  assert.deepEqual(closed, []);
  assert.match(waiting[0], /still 1059/);
  assert.equal(entries[0].status, "verifying");
});

test("evaluateClosures closes only when date, dir, zero rows and verify all pass", () => {
  const make = (overrides = {}) => ({
    id: "b",
    status: "verifying",
    match: ["poly/poly-account-data"],
    note: "prior",
    closeWhen: {
      project: "poly/poly-account-data/poly-account-data",
      dir: "/tmp/x",
      from: "20261120",
      ...(overrides.closeWhen ?? {}),
    },
    ...overrides,
  });

  // Future `from`: must not close even with a zero row.
  const zero = parseReportCounts(
    "| poly/poly-account-data/poly-account-data | 0 | 0 | 1 | 0 | ok |\n",
  );
  const future = [make()];
  assert.deepEqual(
    evaluateClosures(future, zero, "20261119", { dirExists: () => true }).closed,
    [],
  );

  // Missing directory: a deleted project is not a fixed project.
  const gone = [make()];
  assert.deepEqual(evaluateClosures(gone, zero, "20261120", { dirExists: () => false }).closed, []);

  // Verification script failing: no closure.
  const unverified = [make({ closeWhen: { requireVerify: "scripts/verify-x.sh" } })];
  const blocked = evaluateClosures(unverified, zero, "20261120", {
    dirExists: () => true,
    runVerify: () => 1,
  });
  assert.deepEqual(blocked.closed, []);
  assert.match(blocked.waiting[0], /verify .* rc=1/);

  // All four conditions hold.
  const ok = [make()];
  const done = evaluateClosures(ok, zero, "20261120", {
    dirExists: () => true,
    runVerify: () => 0,
  });
  assert.deepEqual(done.closed, ["b"]);
  assert.equal(ok[0].status, "closed");
  assert.match(
    ok[0].note,
    /20261120 报告 poly\/poly-account-data\/poly-account-data=0（目录存在）→ closed/,
  );
});

test("evaluateClosures ignores entries that are not verifying", () => {
  const entries = [
    {
      id: "c",
      status: "closed",
      match: ["p/x"],
      closeWhen: { project: "p/x", dir: "/tmp", from: "20260101" },
    },
    {
      id: "d",
      status: "observing",
      match: ["p/x"],
      closeWhen: { project: "p/x", dir: "/tmp", from: "20260101" },
    },
  ];
  const { closed, waiting } = evaluateClosures(entries, new Map(), "20261120", {
    dirExists: () => true,
  });
  assert.deepEqual(closed, []);
  assert.deepEqual(waiting, []);
});

test("invalidIds flags blank, dash and duplicate ids", () => {
  const bad = invalidIds([{ id: "ok" }, { id: "-" }, { id: "" }, { id: "ok" }]);
  assert.equal(bad.length, 3);
  assert.deepEqual(invalidIds([{ id: "a" }, { id: "b" }]), []);
});
