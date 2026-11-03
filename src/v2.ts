import { PLUGIN_ID } from "./constants.js";
import { claimActivation } from "./registry.js";
import { createRuntime, type CompactOps, type LogLevel, type RuntimeLogger } from "./runtime.js";
import { selectLatestSnapshot, unwrap, type TokenSnapshot } from "./usage.js";

/**
 * Minimal structural view of the v2 session namespace. The exact verb names
 * differ between v2 hosts, so each capability is probed at call time and the
 * runtime degrades to "no action" instead of throwing when one is missing.
 */
export interface V2Session {
  messages?(input: unknown): Promise<unknown>;
  summarize?(input: unknown): Promise<unknown>;
  compact?(input: unknown): Promise<unknown>;
  status?(input?: unknown): Promise<unknown>;
  list?(input?: unknown): Promise<unknown>;
}

export interface V2App {
  log?(input: {
    body: {
      service: string;
      level: LogLevel;
      message: string;
      extra?: Record<string, unknown>;
    };
  }): Promise<unknown>;
}

export interface V2Context {
  client?: { session?: V2Session; app?: V2App };
  session?: V2Session;
  app?: V2App;
  directory?: string;
  event?: {
    subscribe?(options: {
      types: string[];
      signal: AbortSignal;
    }): AsyncIterable<unknown> | undefined;
  };
}

interface NormalizedEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    status?: { type?: string };
  };
}

function normalizeEvent(raw: unknown): NormalizedEvent {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as {
    type?: unknown;
    properties?: { sessionID?: unknown; status?: { type?: unknown } };
    data?: { sessionID?: unknown; status?: { type?: unknown } };
  };
  const properties = record.properties ?? record.data;
  const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
  const statusType =
    properties?.status && typeof properties.status.type === "string"
      ? properties.status.type
      : undefined;

  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(properties
      ? {
          properties: {
            ...(sessionID === undefined ? {} : { sessionID }),
            ...(statusType === undefined ? {} : { status: { type: statusType } }),
          },
        }
      : {}),
  };
}

function createLogger(app: V2App | undefined): RuntimeLogger {
  return {
    log(level, message, extra): void {
      if (typeof app?.log !== "function") return;
      void Promise.resolve(
        app.log({
          body: {
            service: PLUGIN_ID,
            level,
            message,
            ...(extra === undefined ? {} : { extra }),
          },
        }),
      ).catch(() => {
        // Logging must never affect session handling.
      });
    },
  };
}

function buildOps(session: V2Session, directory: string | undefined): CompactOps {
  const scoped = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    directory ? { ...extra, query: { directory } } : extra;

  async function readSnapshot(sessionID: string): Promise<TokenSnapshot | null> {
    if (typeof session.messages !== "function") return null;

    let response: unknown;
    try {
      response = await session.messages({ path: { id: sessionID }, ...scoped() });
    } catch {
      // Older v2 hosts take a flat argument object.
      response = await session.messages({ sessionID });
    }
    return selectLatestSnapshot(response);
  }

  async function compact(sessionID: string, snapshot: TokenSnapshot): Promise<void> {
    if (typeof session.summarize === "function") {
      await session.summarize({
        path: { id: sessionID },
        body: { providerID: snapshot.providerID, modelID: snapshot.modelID },
        ...scoped(),
      });
      return;
    }

    if (typeof session.compact === "function") {
      await session.compact({
        sessionID,
        providerID: snapshot.providerID,
        modelID: snapshot.modelID,
      });
      return;
    }

    throw new Error("host session does not expose summarize() or compact()");
  }

  async function listIdleSessions(): Promise<string[]> {
    if (typeof session.status !== "function" || typeof session.list !== "function") return [];

    const statuses = unwrap<Record<string, { type?: string }>>(await session.status());
    if (!statuses || typeof statuses !== "object") return [];

    const sessions = unwrap<Array<{ id?: unknown }>>(await session.list({ query: { directory } }));
    if (!Array.isArray(sessions)) return [];

    const ids: string[] = [];
    for (const item of sessions) {
      const id = item?.id;
      if (typeof id === "string" && statuses[id]?.type === "idle") ids.push(id);
    }
    return ids;
  }

  return { readSnapshot, compact, listIdleSessions };
}

/**
 * v2 server part. Subscribes to idle events and resolves to the cleanup
 * function expected by the v2 plugin contract.
 */
export function setupV2(ctx: V2Context | undefined): Promise<() => void> {
  const session = ctx?.client?.session ?? ctx?.session;
  const logger = createLogger(ctx?.client?.app ?? ctx?.app);
  if (!session) {
    logger.log("error", "v2 context has no session namespace");
    return Promise.resolve(() => {});
  }

  // Stay inert when the v1 entry already owns the process-wide runtime.
  const activation = claimActivation();
  if (!activation) return Promise.resolve(() => {});

  const runtime = createRuntime({ ops: buildOps(session, ctx?.directory), logger });
  const controller = new AbortController();

  const events = ctx?.event;
  if (typeof events?.subscribe === "function") {
    const stream = events.subscribe({
      types: ["session.idle", "session.status"],
      signal: controller.signal,
    });
    if (stream) {
      void (async () => {
        try {
          for await (const raw of stream) {
            await runtime.onEvent(normalizeEvent(raw));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            logger.log("error", "idle event subscription failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();
    }
  } else {
    // WARN (downgraded from error): the plugin cannot observe idle transitions
    // on this host build, so it does nothing instead of failing the session.
    logger.log("warn", "v2 context has no event.subscribe(); auto compaction is inactive");
  }

  runtime.start();

  return Promise.resolve(() => {
    controller.abort();
    runtime.stop();
    activation.release();
  });
}
