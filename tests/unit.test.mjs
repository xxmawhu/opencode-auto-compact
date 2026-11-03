import assert from "node:assert/strict";
import test from "node:test";

import { COMPACT_THRESHOLD_TOKENS } from "../dist/constants.js";
import { createRuntime } from "../dist/runtime.js";
import hybrid from "../dist/index.js";
import { readMessageTokens, selectLatestSnapshot } from "../dist/usage.js";

const BASE_NOW = 1_000_000;

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

test("assistant prompt size is input plus cache read", () => {
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
    },
  };
}

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
  const cleanup = await hybrid.setup(undefined);
  assert.equal(typeof cleanup, "function");
  cleanup();
});
