import { PLUGIN_ID } from "./constants.js";
import { claimActivation } from "./registry.js";
import { createRuntime, type CompactOps, type LogLevel, type RuntimeLogger } from "./runtime.js";
import { selectLatestSnapshot, unwrap, type TokenSnapshot } from "./usage.js";

/** Minimal structural view of the OpenCode v1 client handed to plugins. */
export interface V1Client {
  session?: {
    messages?(input: unknown): Promise<unknown>;
    summarize?(input: unknown): Promise<unknown>;
    status?(input?: unknown): Promise<unknown>;
    list?(input?: unknown): Promise<unknown>;
  };
  app?: {
    log?(input: {
      body: {
        service: string;
        level: LogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

export interface V1PluginInput {
  client?: V1Client;
  directory?: string;
  worktree?: string;
}

export interface PluginHooks {
  event(input: { event: unknown }): Promise<void>;
  dispose?(): Promise<void>;
}

function createLogger(client: V1Client | undefined): RuntimeLogger {
  return {
    log(level, message, extra): void {
      const app = client?.app;
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

function buildOps(client: V1Client, directory: string | undefined): CompactOps {
  const scoped = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    directory ? { ...extra, query: { directory } } : extra;

  return {
    async readSnapshot(sessionID: string): Promise<TokenSnapshot | null> {
      const session = client.session;
      if (typeof session?.messages !== "function") return null;
      const response = await session.messages({
        path: { id: sessionID },
        ...scoped(),
      });
      return selectLatestSnapshot(response);
    },

    async compact(sessionID: string, snapshot: TokenSnapshot): Promise<void> {
      const session = client.session;
      if (typeof session?.summarize !== "function") {
        throw new Error("host client does not expose session.summarize");
      }
      await session.summarize({
        path: { id: sessionID },
        body: { providerID: snapshot.providerID, modelID: snapshot.modelID },
        ...scoped(),
      });
    },

    async listIdleSessions(): Promise<string[]> {
      const session = client.session;
      if (typeof session?.status !== "function" || typeof session.list !== "function") return [];

      const statuses = unwrap<Record<string, { type?: string }>>(await session.status());
      if (!statuses || typeof statuses !== "object") return [];

      const sessions = unwrap<Array<{ id?: unknown }>>(
        await session.list({ query: { directory } }),
      );
      if (!Array.isArray(sessions)) return [];

      const ids: string[] = [];
      for (const session of sessions) {
        const id = session?.id;
        if (typeof id !== "string") continue;
        if (statuses[id]?.type === "idle") ids.push(id);
      }
      return ids;
    },
  };
}

/** Build the classic v1 hook map. Returns `{}` when the host context is unusable. */
export function createV1Hooks(input: V1PluginInput | undefined): PluginHooks {
  const client = input?.client;
  if (!client?.session) return {} as PluginHooks;

  // A host that scans both plugin directories loads this library twice; only
  // the first activation may own the runtime.
  const activation = claimActivation();
  if (!activation) return {} as PluginHooks;

  const directory = input?.directory ?? input?.worktree;
  const runtime = createRuntime({
    ops: buildOps(client, directory),
    logger: createLogger(client),
  });
  runtime.start();

  return {
    async event({ event }): Promise<void> {
      await runtime.onEvent(event as Parameters<typeof runtime.onEvent>[0]);
    },
    dispose(): Promise<void> {
      runtime.stop();
      activation.release();
      return Promise.resolve();
    },
  };
}
