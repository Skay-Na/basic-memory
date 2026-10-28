import { Plugin } from "@opencode/plugin";

import { capture, recall, turnsFromMessages } from "./bm.js";
import { parseConfig } from "./config.js";
import { ledger } from "./ledger.js";
import { reviewComplete, reviewEdit, reviewInstruction, reviewRead, reviewSave } from "./review.js";

interface ToolInput {
  query?: string;
  title?: string;
  review_id?: string;
  identifier?: string;
  content?: string;
  expected_checksum?: string;
  find_text?: string;
  status?: "saved" | "no_memory" | "pending";
  reason?: string;
  references?: string[];
  drafts?: { title: string; content: string }[];
}

interface TurnState {
  message: string;
  instruction?: string;
}

const reviewToolInput = {
  type: "object",
  properties: {
    review_id: { type: "string", description: "Review ID from the injected semantic review instruction" },
  },
  required: ["review_id"],
  additionalProperties: false,
} as const;

export default Plugin.define({
  id: "basic-memory.opencode",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const recalledSessions = new Map<string, { query: string; content: string }>();
    // One prepared turn per session. Re-entrant context hooks reuse it instead of double counting.
    const turnStates = new Map<string, TurnState>();
    const turnWork = new Map<string, Promise<TurnState>>();
    const subscription = new AbortController();

    async function cwdFor(sessionID: string): Promise<string> {
      const session = await ctx.session.get({ sessionID: sessionID as never });
      return session.location.directory;
    }

    async function sessionContext(sessionID: string) {
      const [session, messages] = await Promise.all([
        ctx.session.get({ sessionID: sessionID as never }),
        ctx.session.context({ sessionID: sessionID as never }),
      ]);
      return {
        cwd: session.location.directory,
        turns: turnsFromMessages(messages),
      };
    }

    async function logFailure(action: string, error: unknown) {
      console.warn(
        `[basic-memory-opencode] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    /**
     * Count the turn on the backend and, when a batch boundary is reached, open a review and build the
     * instruction that the context hook appends to the system prompt.
     */
    async function prepareTurn(sessionID: string, cwd: string, message: string, user: string, userTurns: number): Promise<TurnState> {
      let interval = config.semanticCaptureInterval;
      let ordinal: number | undefined;
      try {
        const state = await ledger(config, cwd, "turn", { session: sessionID, message, interval });
        if (Number.isInteger(state?.interval)) interval = state.interval;
        if (Number.isInteger(state?.ordinal) && state.ordinal > 0) ordinal = state.ordinal;
      } catch (error) {
        await logFailure("Capture turn state", error);
      }
      // Offline or local state has no remote ordinal; fall back to the local count for this session.
      const count = ordinal ?? userTurns;
      if (!Number.isInteger(count) || count < 1 || count % interval !== 0) return { message };
      try {
        const row = await ledger(config, cwd, "start", { session: sessionID, message, user });
        const pending = await ledger(config, cwd, "pending", { id: row.id });
        const queue = config.stateBackend === "remote" ? await ledger(config, cwd, "outbox_status") : null;
        const notice = (queue?.pending ? ` Basic Memory has ${queue.pending} locally queued state operations awaiting synchronization; do not report them as synchronized.` : "") +
          (queue?.expired ? ` Basic Memory has ${queue.expired} expired undelivered queue entries. Their contents were cleared after seven days and must not be reported as synchronized; tell the user.` : "");
        if ((await ledger(config, cwd, "get", { id: row.id })).status !== "collecting") return { message };
        return { message, instruction: reviewInstruction(row.id, pending, interval) + notice };
      } catch (error) {
        await logFailure("Semantic review", error);
        return { message };
      }
    }

    async function captureCurrent(sessionID: string, title?: string) {
      const { cwd, turns } = await sessionContext(sessionID);
      const transcriptSize = turns.reduce((total, turn) => total + turn.text.length, 0);
      if (transcriptSize < config.captureMinChars) return "Conversation is below captureMinChars.";
      return capture(config, { sessionId: sessionID, cwd, turns, title });
    }

    // Always installed: the hook carries both recall and the semantic review instruction.
    {
      await ctx.session.hook("context", async (event) => {
        try {
          const messages = Array.isArray(event.messages) ? event.messages : [];
          const users = messages.filter((item: any) => item?.role === "user");
          const lastUser = users[users.length - 1] as any;
          const messageID = typeof lastUser?.id === "string" ? lastUser.id : "";
          // Message IDs are optional in the AI message schema; without one we cannot dedupe a turn safely.
          if (!messageID) return;
          const userText = turnsFromMessages(messages).filter((turn) => turn.role === "user").at(-1)?.text ?? "";
          const cwd = await cwdFor(event.sessionID);

          let state = turnStates.get(event.sessionID);
          if (state?.message !== messageID) {
            const key = `${event.sessionID}:${messageID}`;
            let work = turnWork.get(key);
            if (!work) {
              work = prepareTurn(event.sessionID, cwd, messageID, userText, users.length);
              turnWork.set(key, work);
            }
            state = await work;
            turnWork.delete(key);
            turnStates.set(event.sessionID, state);
          }
          if (state?.instruction) event.system.push({ type: "text", text: state.instruction });

          if (config.autoRecall && userText) {
            const cached = recalledSessions.get(event.sessionID);
            const content = cached?.query === userText ? cached.content : await recall(config, userText);
            recalledSessions.set(event.sessionID, { query: userText, content });
            event.system.push({ type: "text", text: content });
          }
        } catch (error) {
          await logFailure("Recall and review context", error);
        }
      });
    }

    if (config.autoCapture) {
      await ctx.session.hook("compaction", async (event) => {
        try {
          await captureCurrent(event.sessionID);
        } catch (error) {
          await logFailure("Compaction checkpoint", error);
        }
      });
    }

    const callWithCwd = async (sessionID: string, run: (cwd: string) => Promise<string>) => run(await cwdFor(sessionID));

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "bm_recall",
        description: "Recall prior OpenCode session checkpoints from Basic Memory.",
        input: {
          type: "object",
          properties: { query: { type: "string", description: "Topic or search query" } },
          additionalProperties: false,
        },
        async execute(input) {
          return { content: await recall(config, (input as ToolInput).query) };
        },
      });
      editor.add({
        name: "bm_capture",
        description: "Capture the current OpenCode session as a durable Basic Memory checkpoint.",
        input: {
          type: "object",
          properties: { title: { type: "string", description: "Optional checkpoint title" } },
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: await captureCurrent(context.sessionID, (input as ToolInput).title) };
        },
      });
      editor.add({
        name: "bm_read",
        description: "Read a possible Basic Memory match and verify its reference for this review.",
        input: {
          type: "object",
          properties: {
            ...reviewToolInput.properties,
            identifier: { type: "string", description: "Exact permalink of the note to read" },
          },
          required: ["review_id", "identifier"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const a = input as ToolInput;
          return { content: await callWithCwd(context.sessionID, (cwd) => reviewRead(config, cwd, a as never)) };
        },
      });
      editor.add({
        name: "bm_review_save",
        description: "Save a confirmed durable memory after searching and reading possible duplicates.",
        input: {
          type: "object",
          properties: {
            ...reviewToolInput.properties,
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["review_id", "title", "content"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const a = input as ToolInput;
          return { content: await callWithCwd(context.sessionID, (cwd) => reviewSave(config, cwd, a as never)) };
        },
      });
      editor.add({
        name: "bm_review_edit",
        description: "Update one exact passage of a previously read note using its checksum.",
        input: {
          type: "object",
          properties: {
            ...reviewToolInput.properties,
            identifier: { type: "string" },
            expected_checksum: { type: "string" },
            find_text: { type: "string" },
            content: { type: "string" },
          },
          required: ["review_id", "identifier", "expected_checksum", "find_text", "content"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const a = input as ToolInput;
          return { content: await callWithCwd(context.sessionID, (cwd) => reviewEdit(config, cwd, a as never)) };
        },
      });
      editor.add({
        name: "bm_review_complete",
        description: "Record saved, no_memory, or pending outcome for a semantic review.",
        input: {
          type: "object",
          properties: {
            ...reviewToolInput.properties,
            status: { type: "string", enum: ["saved", "no_memory", "pending"] },
            reason: { type: "string" },
            references: { type: "array", items: { type: "string" } },
            drafts: {
              type: "array",
              items: {
                type: "object",
                properties: { title: { type: "string" }, content: { type: "string" } },
                required: ["title", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["review_id", "status"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const a = input as ToolInput;
          return { content: await callWithCwd(context.sessionID, (cwd) => reviewComplete(config, cwd, a as never)) };
        },
      });
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
          if (event.type !== "session.idle") continue;
          const sessionID = (event as any).data?.sessionID;
          if (typeof sessionID !== "string") continue;
          try {
            const cwd = await cwdFor(sessionID);
            // Close any review still in `collecting`: the turn ended without a receipt.
            await ledger(config, cwd, "idle", { session: sessionID });
          } catch (error) {
            await logFailure("Review receipt", error);
          }
        }
      } catch (error) {
        if (!subscription.signal.aborted) await logFailure("Event subscription", error);
      }
    })();

    return () => subscription.abort();
  },
});
