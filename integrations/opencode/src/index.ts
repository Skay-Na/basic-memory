import { z } from "zod";

import { call, capture, recall, turnsFromMessages } from "./bm.js";
import { parseConfig } from "./config.js";
import V2Plugin from "./v2.js";
import { ledger } from "./ledger.js";
import { reviewTools, reviewInstruction } from "./review.js";

interface V1SessionMessages {
  data?: unknown[];
}

interface V1PluginInput {
  client: {
    session: {
      messages(input: { path: { id: string } }): Promise<V1SessionMessages>;
    };
    app: {
      log(input: { body: { service: string; level: "warn"; message: string } }): Promise<unknown>;
    };
  };
  directory: string;
}

interface V1ToolContext {
  sessionID: string;
}

export const BasicMemoryOpenCodeV1 = async (
  { client, directory }: V1PluginInput,
  options?: unknown,
) => {
  const config = parseConfig(options ?? {});
  const recalledSessions = new Map<string, { messageID: string; content: string }>();
  const seenSessionNotes = new Map<string, Map<string, string>>();
  const reviews = new Map<string, { message: string; id: string; instruction: string }>();

  async function messages(sessionID: string) {
    const result = await client.session.messages({ path: { id: sessionID } }) as V1SessionMessages;
    return turnsFromMessages(result.data);
  }

  async function captureCurrent(sessionID: string, title?: string) {
    const turns = await messages(sessionID);
    const transcriptSize = turns.reduce((total, turn) => total + turn.text.length, 0);
    if (transcriptSize < config.captureMinChars) return "Conversation is below captureMinChars.";
    return capture(config, { sessionId: sessionID, cwd: directory, turns, title });
  }

  async function logFailure(action: string, error: unknown) {
    await client.app.log({ body: {
      service: "basic-memory-opencode",
      level: "warn",
      message: `${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    } });
  }

  return {
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      let latest: any; let query: string | undefined; let turnCount = 0;
      try {
        const raw = await client.session.messages({ path: { id: sessionID } });
        latest = [...(raw.data ?? [])].reverse().find((item: any) => item?.info?.role === "user");
        turnCount = (raw.data ?? []).filter((item: any) => item?.info?.role === "user").length;
        query = [...turnsFromMessages(raw.data)].reverse().find((turn) => turn.role === "user")?.text;
      } catch (error) { await logFailure("Reading session", error); return; }
      if (!query || !latest?.info?.id) return;
      let reviewInterval = config.semanticCaptureInterval;
      let reviewCount = turnCount;
      if (config.stateBackend === 'remote') try {
        const state = await ledger(config, directory, 'turn', { session: sessionID, message: latest.info.id, interval: reviewInterval });
        reviewInterval = state.interval;
        if (Number.isInteger(state.ordinal) && state.ordinal > 0) reviewCount = state.ordinal;
      } catch (error) { await logFailure("Capture turn state", error); }
      if (reviewCount % reviewInterval === 0) try {
        let review = reviews.get(sessionID);
        if (review?.message !== latest.info.id) {
          const row = await ledger(config, directory, "start", { session: sessionID, message: latest.info.id, user: query });
          const pending = await ledger(config, directory, "pending", { id: row.id });
          const queue = config.stateBackend === "remote" ? await ledger(config, directory, "outbox_status") : null;
          const notice = (queue?.pending ? ` Basic Memory has ${queue.pending} locally queued state operations awaiting synchronization; do not report them as synchronized.` : "") + (queue?.expired ? ` Basic Memory has ${queue.expired} expired undelivered queue entries. Their contents were cleared after seven days and must not be reported as synchronized; tell the user.` : "");
          review = { message: latest.info.id, id: row.id, instruction: reviewInstruction(row.id, pending, reviewInterval) + notice };
          reviews.set(sessionID, review);
        }
        if (review && (await ledger(config, directory, "get", { id: review.id })).status === "collecting") output.system.push(review.instruction);
      } catch (error) { await logFailure("Semantic review", error); }
      if (config.autoRecall) try {
        const cached = recalledSessions.get(sessionID);
        let content: string;
        if (cached && cached.messageID === latest.info.id) {
          content = cached.content;
        } else {
          let seen = seenSessionNotes.get(sessionID);
          if (!seen) { seen = new Map(); seenSessionNotes.set(sessionID, seen); }
          content = await recall(config, query, { auto: true, seen });
          recalledSessions.set(sessionID, { messageID: latest.info.id, content });
        }
        if (content) output.system.push(content);
      } catch (error) { recalledSessions.delete(sessionID); await logFailure("Automatic recall", error); }
    },
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event.properties as { sessionID?: unknown } | undefined)?.sessionID;
      if (typeof sessionID === "string") {
        try { await ledger(config, directory, "idle", { session: sessionID }); } catch (error) { await logFailure("Review receipt", error); }
      }
    },
    tool: {
      ...reviewTools(config, directory),
      bm_capture: {
        description: "Explicitly capture this session transcript as a pending-review checkpoint.",
        args: { title: z.string().optional() },
        async execute(args: { title?: string }, context: V1ToolContext) { return captureCurrent(context.sessionID, args.title); },
      },
      bm_capture_status: {
        description: "Show the effective semantic capture interval and configuration priority for this project.",
        args: {},
        async execute() {
          let effective = config.semanticCaptureInterval;
          let source = "OpenCode semanticCaptureInterval";
          if (config.stateBackend === "remote") {
            try {
              const setting = await call(config, "bm_capture_settings", { command: "get" });
              if (Number.isInteger(setting?.interval)) { effective = setting.interval; source = "server project setting"; }
            } catch { source = "server unavailable; using local setting"; }
          }
          return `Effective semantic capture interval: ${effective} user turns. Priority: server project setting overrides OpenCode semanticCaptureInterval in remote mode; otherwise the OpenCode setting applies (default 5). Current source: ${source}.`;
        },
      },
    },
  };
};

export const BasicMemoryOpenCode = {
  ...V2Plugin,
  server: BasicMemoryOpenCodeV1,
};

export { V2Plugin as BasicMemoryOpenCodeV2 };
export default BasicMemoryOpenCode;
