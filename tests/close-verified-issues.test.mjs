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
