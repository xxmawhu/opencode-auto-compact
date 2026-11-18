import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMPACT_THRESHOLD_TOKENS } from "../dist/constants.js";
import { createFileLogger } from "../dist/log.js";
import { createRuntime } from "../dist/runtime.js";
import hybrid from "../dist/index.js";
import { readMessageTokens, selectLatestSnapshot } from "../dist/usage.js";

const BASE_NOW = 1_000_000;
/** Sandboxes live under tests/ so nothing is written outside the project. */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function snapshot(tokens, overrides = {}) {
  return {
    effectiveTokens: tokens,
    providerID: "provider",
    modelID: "model",
    ...overrides,
  };
}

function createHarness(options = {}) {
  const clock = { now: BASE_NOW };
  const compactCalls = [];
  const logs = [];
  const ops = {
    async readSnapshot() {
      return options.snapshot ?? snapshot(210_000);
    },
    async compact(sessionID, snap) {
      if (options.failCompact) throw new Error("compaction exploded");
      compactCalls.push({ sessionID, snap });
    },
    ...(options.listIdleSessions
      ? {
          async listIdleSessions() {
            return options.listIdleSessions;
          },
        }
      : {}),
  };
  const runtime = createRuntime({
    ops,
    logger: { log: (level, message, extra) => logs.push({ level, message, extra }) },
    now: () => clock.now,
  });
  return { runtime, clock, compactCalls, logs };
}

function idleEvent(sessionID = "ses_1") {
  return { type: "session.idle", properties: { sessionID } };
}

function statusIdleEvent(sessionID = "ses_1") {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } };
}

function executionSucceededEvent(sessionID = "ses_1") {
  return { type: "session.execution.succeeded", properties: { sessionID } };
}

test("a finished execution counts as idle on hosts that publish no session.idle", async () => {
  // opencode 2.3.2 describes a finished turn with session.execution.succeeded;
  // session.idle is never published, so this event must drive compaction.
  const harness = createHarness();
  await harness.runtime.onEvent(executionSucceededEvent());
  assert.equal(harness.compactCalls.length, 1);

  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    const other = createHarness();
    await other.runtime.onEvent({ type, properties: { sessionID: "ses_1" } });
    assert.equal(other.compactCalls.length, 1, `${type} must be treated as a finished turn`);
  }
});

test("threshold is the fixed 200000 tokens", () => {
  assert.equal(COMPACT_THRESHOLD_TOKENS, 200_000);
});

test("exactly 200000 tokens does not compact, 200001 compacts", async () => {
  const atThreshold = createHarness({ snapshot: snapshot(200_000) });
  await atThreshold.runtime.onEvent(idleEvent());
  assert.equal(atThreshold.compactCalls.length, 0);

  const aboveThreshold = createHarness({ snapshot: snapshot(200_001) });
  await aboveThreshold.runtime.onEvent(idleEvent());
  assert.equal(aboveThreshold.compactCalls.length, 1);
  assert.deepEqual(aboveThreshold.compactCalls[0].snap, snapshot(200_001));
});

test("the threshold cannot be changed through the environment", async () => {
  process.env.OPENCODE_AUTO_COMPACT_THRESHOLD = "1";
  try {
    const harness = createHarness({ snapshot: snapshot(199_999) });
    await harness.runtime.onEvent(idleEvent());
    assert.equal(harness.compactCalls.length, 0);
  } finally {
    delete process.env.OPENCODE_AUTO_COMPACT_THRESHOLD;
  }
});

test("duplicate idle signals compact once", async () => {
  const harness = createHarness();
  await harness.runtime.onEvent(idleEvent());
  await harness.runtime.onEvent(statusIdleEvent());
  assert.equal(harness.compactCalls.length, 1);
});

test("a finished execution counts as an idle transition on 2.x hosts", async () => {
  // opencode 2.3.2 announces the end of a turn with session.execution.* and
  // never publishes session.idle, so these events must drive compaction.
  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]) {
    const harness = createHarness();
    await harness.runtime.onEvent({ type, properties: { sessionID: "ses_1" } });
    assert.equal(harness.compactCalls.length, 1, `${type} must count as idle`);
  }
});

test("a running execution does not count as idle", async () => {
  const harness = createHarness();
  await harness.runtime.onEvent({
    type: "session.execution.started",
    properties: { sessionID: "ses_1" },
  });
  await harness.runtime.onEvent({ type: "session.step.ended", properties: { sessionID: "ses_1" } });
  assert.equal(harness.compactCalls.length, 0);
});

test("non-idle events are ignored", async () => {
  const harness = createHarness();
  await harness.runtime.onEvent({ type: "message.updated", properties: { sessionID: "ses_1" } });
  await harness.runtime.onEvent({
    type: "session.status",
    properties: { sessionID: "ses_1", status: { type: "busy" } },
  });
  assert.equal(harness.compactCalls.length, 0);
});

test("a missing provider or model skips compaction and logs a warning", async () => {
  const harness = createHarness({ snapshot: snapshot(250_000, { modelID: "" }) });
  await harness.runtime.onEvent(idleEvent());
  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.logs.at(-1).level, "warn");
});

test("compaction failures never escape and honour the failure cooldown", async () => {
  const harness = createHarness({ failCompact: true });
  await assert.doesNotReject(() => harness.runtime.onEvent(idleEvent()));
  assert.equal(harness.logs.at(-1).level, "error");

  harness.clock.now += 3_000;
  await harness.runtime.onEvent(idleEvent());
  assert.equal(harness.logs.filter((entry) => entry.level === "error").length, 1);

  harness.clock.now += 61_000;
  await harness.runtime.onEvent(idleEvent());
  assert.equal(harness.logs.filter((entry) => entry.level === "error").length, 2);
});

test("the startup sweep only touches sessions the host reports as idle", async () => {
  const harness = createHarness({ listIdleSessions: ["ses_1", "ses_2"] });
  await harness.runtime.sweep();
  assert.deepEqual(
    harness.compactCalls.map((call) => call.sessionID),
    ["ses_1", "ses_2"],
  );
});

test("assistant prompt size is input plus cache read (v1 message shape)", () => {
  const entry = {
    info: {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      tokens: { input: 150_000, output: 9_999, cache: { read: 60_000 } },
    },
  };
  assert.equal(readMessageTokens(entry), 210_000);
  assert.deepEqual(selectLatestSnapshot([entry]), {
    effectiveTokens: 210_000,
    providerID: "p",
    modelID: "m",
  });
});

test("assistant prompt size is input plus cache read (v2 flat message shape)", () => {
  const entry = {
    id: "msg_1",
    type: "assistant",
    model: { id: "deepseek-v4.1-flash", providerID: "bailian-token-plan" },
    tokens: { input: 132, output: 500, reasoning: 0, cache: { read: 106_240, write: 0 } },
  };
  assert.equal(readMessageTokens(entry), 106_372);
  assert.deepEqual(selectLatestSnapshot([entry]), {
    effectiveTokens: 106_372,
    providerID: "bailian-token-plan",
    modelID: "deepseek-v4.1-flash",
  });
});

test("a streaming assistant message without token data is skipped", () => {
  const finished = {
    type: "assistant",
    model: { id: "m", providerID: "p" },
    tokens: { input: 1_000, cache: { read: 200_000 } },
  };
  const streaming = { id: "msg_live", type: "assistant", model: { id: "m", providerID: "p" } };
  const user = { id: "msg_user", type: "user" };
  assert.deepEqual(selectLatestSnapshot([finished, user, streaming]), {
    effectiveTokens: 201_000,
    providerID: "p",
    modelID: "m",
  });
});

test("the newest assistant message wins and user messages are skipped", () => {
  const messages = [
    {
      info: {
        role: "assistant",
        tokens: { input: 10, cache: { read: 10 } },
        providerID: "p",
        modelID: "m",
      },
    },
    { info: { role: "user" } },
    {
      info: {
        role: "assistant",
        tokens: { input: 250_000, cache: { read: 1_000 } },
        providerID: "p2",
        modelID: "m2",
      },
    },
  ];
  assert.deepEqual(selectLatestSnapshot(messages), {
    effectiveTokens: 251_000,
    providerID: "p2",
    modelID: "m2",
  });
});

test("unwraps SDK responses that nest the payload under data", () => {
  const messages = {
    data: [
      {
        info: {
          role: "assistant",
          tokens: { input: 201_000, cache: { read: 0 } },
          providerID: "p",
          modelID: "m",
        },
      },
    ],
  };
  assert.equal(selectLatestSnapshot(messages).effectiveTokens, 201_000);
});

function fakeClient() {
  return {
    session: {
      // opencode 1.x surface.
      async messages() {
        return { data: [] };
      },
      async summarize() {
        return true;
      },
      async status() {
        return { data: {} };
      },
      async list() {
        return { data: [] };
      },
      // opencode 2.x surface.
      async context() {
        return [];
      },
      async compact() {
        return true;
      },
    },
  };
}

test("the default export satisfies both host contracts", () => {
  // opencode2 requires an object with id + setup; opencode 1.x calls server().
  assert.equal(typeof hybrid.id, "string");
  assert.ok(hybrid.id.length > 0);
  assert.equal(typeof hybrid.setup, "function");
  assert.equal(typeof hybrid.server, "function");
});

test("the v1 and v2 entries share one process-wide runtime", async () => {
  const first = await hybrid.server({ client: fakeClient() });
  assert.equal(typeof first.dispose, "function");

  // The second entry must stay inert instead of starting a second runtime.
  assert.deepEqual(await hybrid.server({ client: fakeClient() }), {});
  const v2Cleanup = await hybrid.setup({ session: fakeClient().session });
  v2Cleanup();

  await first.dispose();

  // Releasing the claim lets the next load become active again.
  const reloaded = await hybrid.server({ client: fakeClient() });
  assert.equal(typeof reloaded.dispose, "function");
  await reloaded.dispose();
});

test("v2 setup resolves to a cleanup function", async () => {
  const cleanup = await hybrid.setup({ app: captureApp().app });
  assert.equal(typeof cleanup, "function");
  cleanup();
});

function captureApp() {
  const logs = [];
  return {
    app: {
      async log(input) {
        logs.push(input.body);
        return true;
      },
    },
    logs,
  };
}

/** Push-driven async iterable, standing in for ctx.event.subscribe. */
function createEventStream() {
  const queue = [];
  let wake;
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          await new Promise((resolve) => {
            wake = resolve;
          });
          return { value: queue.shift(), done: false };
        },
        async return() {
          return { value: undefined, done: true };
        },
      };
    },
  };
  return {
    iterable,
    push(event) {
      queue.push(event);
      const resume = wake;
      wake = undefined;
      if (resume) resume();
    },
  };
}

/**
 * Wait for an async predicate. Termination: the variant `200 - attempt` is a
 * natural number that strictly decreases each iteration and is bounded below by
 * 0, so the loop always exits; exhausting the deadline throws, because a
 * condition that never becomes true is a test failure, not a reason to hang.
 */
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function v2Context({ tokens, events, logs }) {
  const contextCalls = [];
  const compactCalls = [];
  const subscribeCalls = [];
  const ctx = {
    event: {
      subscribe(options) {
        subscribeCalls.push(options);
        return events.iterable;
      },
    },
    session: {
      async context(input) {
        contextCalls.push(input);
        return [
          { id: "msg_user", type: "user" },
          {
            id: "msg_assistant",
            type: "assistant",
            model: { id: "deepseek-v4.1-flash", providerID: "bailian-token-plan" },
            tokens: {
              input: tokens - 50_000,
              output: 10,
              cache: { read: 50_000, write: 0 },
            },
          },
        ];
      },
      async compact(input) {
        compactCalls.push(input);
      },
    },
  };
  if (logs) {
    ctx.app = {
      async log(input) {
        logs.push(input.body);
        return true;
      },
    };
  }
  return { ctx, contextCalls, compactCalls, subscribeCalls };
}

test("v2 compacts a finished turn through session.context and session.compact", async () => {
  const events = createEventStream();
  const logs = [];
  const { ctx, contextCalls, compactCalls, subscribeCalls } = v2Context({
    tokens: 210_000,
    events,
    logs,
  });

  const cleanup = await hybrid.setup(ctx);
  assert.ok(
    subscribeCalls[0].types.includes("session.execution.succeeded"),
    "a 2.x host never publishes session.idle; the turn-end event must be subscribed",
  );

  // The real 2.3.2 stream reports a finished turn this way; session.idle never
  // arrives, so this is the trigger that has to work in production.
  events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_v2" } });
  await until(() => compactCalls.length === 1, "v2 compaction");

  assert.deepEqual(contextCalls, [{ sessionID: "ses_v2" }]);
  assert.deepEqual(compactCalls, [{ sessionID: "ses_v2" }]);
  assert.equal(
    logs.filter((entry) => entry.message === "compacted an idle session over the fixed threshold")
      .length,
    1,
  );

  cleanup();
});

test("v2 leaves an idle session under the fixed threshold alone", async () => {
  const events = createEventStream();
  const logs = [];
  const { ctx, contextCalls, compactCalls } = v2Context({ tokens: 199_990, events, logs });

  const cleanup = await hybrid.setup(ctx);
  events.push({ type: "session.idle", data: { sessionID: "ses_v2" } });
  await until(() => contextCalls.length === 1, "v2 snapshot read");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(compactCalls.length, 0);
  cleanup();
});

test("v2 records its own log file when the host exposes no app.log", async () => {
  const stateHome = mkdtempSync(join(ROOT, "tests", ".tmp-state-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    const cleanup = await hybrid.setup(undefined);
    cleanup();

    const file = join(stateHome, "opencode-auto-compact", "auto-compact.log");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.ok(
      lines.some((line) => line.includes("no session namespace")),
      `expected a file log line, got ${JSON.stringify(lines)}`,
    );
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.equal(entry.service, "opencode-auto-compact");
      assert.equal(entry.level, "info");
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(stateHome, { recursive: true, force: true });
  }
});

test("the file logger degrades to stderr when the state dir is not writable", () => {
  const root = mkdtempSync(join(ROOT, "tests", ".tmp-state-"));
  const blocker = join(root, "blocker");
  // A regular file where the log dir should be makes mkdir/append fail.
  writeFileSync(blocker, "not a directory\n");
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    createFileLogger(join(blocker, "opencode-auto-compact")).log("info", "compaction skipped", {
      sessionID: "ses_1",
    });
  } finally {
    process.stderr.write = original;
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(
    lines.some((line) => line.includes("compaction skipped")),
    `expected a stderr fallback line, got ${JSON.stringify(lines)}`,
  );
});

test("the file logger falls back to stderr when the state dir is unwritable", () => {
  const root = mkdtempSync(join(ROOT, "tests", ".tmp-state-"));
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory\n");
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    createFileLogger(join(blocked, "nested")).log("info", "compaction skipped", {
      sessionID: "ses_1",
    });
  } finally {
    process.stderr.write = original;
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(
    lines.some((line) => line.includes("compaction skipped")),
    `expected a stderr fallback line, got ${JSON.stringify(lines)}`,
  );
});

test("activation is logged exactly once per process across both entries", async () => {
  const { app, logs } = captureApp();
  const first = await hybrid.server({ client: { ...fakeClient(), app } });
  // The second entry stays inert and must not log a second activation.
  assert.deepEqual(await hybrid.server({ client: { ...fakeClient(), app } }), {});
  const cleanup = await hybrid.setup({ session: fakeClient().session, app });
  cleanup();

  const activations = logs.filter((entry) => entry.message === "auto-compact runtime activated");
  assert.equal(activations.length, 1);

  await first.dispose();
});

test("v2 setup uses INFO for design-internal degradations", async () => {
  const withoutSession = captureApp();
  const cleanup = await hybrid.setup({ app: withoutSession.app });
  cleanup();
  assert.equal(withoutSession.logs.length, 1);
  assert.equal(withoutSession.logs[0].level, "info");

  const withoutSubscribe = captureApp();
  const active = await hybrid.setup({
    session: fakeClient().session,
    app: withoutSubscribe.app,
  });
  active();
  assert.ok(withoutSubscribe.logs.length >= 2);
  for (const entry of withoutSubscribe.logs) assert.equal(entry.level, "info");
  assert.match(withoutSubscribe.logs[0].message, /auto-compact runtime activated/);
});
