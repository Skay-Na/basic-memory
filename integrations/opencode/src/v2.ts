import { Plugin } from "@opencode/plugin";

import { capture, recall, turnsFromMessages } from "./bm.js";
import { parseConfig } from "./config.js";

interface ToolInput {
  query?: string;
  title?: string;
}

export default Plugin.define({
  id: "basic-memory.opencode",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const recalledSessions = new Set<string>();
    const subscription = new AbortController();

    async function sessionContext(sessionID: string) {
      const [session, messages] = await Promise.all([
        ctx.session.get({ sessionID }),
        ctx.session.context({ sessionID }),
      ]);
      return {
        cwd: session.location.directory,
        turns: turnsFromMessages(messages),
      };
    }

    async function captureCurrent(sessionID: string, title?: string) {
      const { cwd, turns } = await sessionContext(sessionID);
      const transcriptSize = turns.reduce((total, turn) => total + turn.text.length, 0);
      if (transcriptSize < config.captureMinChars) return "Conversation is below captureMinChars.";
      return capture(config, { sessionId: sessionID, cwd, turns, title });
    }

    async function logFailure(action: string, error: unknown) {
      console.warn(
        `[basic-memory-opencode] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (config.autoRecall) {
      await ctx.session.hook("context", async (event) => {
        if (recalledSessions.has(event.sessionID)) return;
        recalledSessions.add(event.sessionID);
        try {
          const content = await recall(config);
          event.system.push({ type: "text", text: content });
        } catch (error) {
          recalledSessions.delete(event.sessionID);
          await logFailure("Automatic recall", error);
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
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
          if (event.type !== "session.idle" || !config.autoCapture) continue;
          try {
            await captureCurrent(event.data.sessionID);
          } catch (error) {
            await logFailure("Automatic capture", error);
          }
        }
      } catch (error) {
        if (!subscription.signal.aborted) await logFailure("Event subscription", error);
      }
    })();

    return () => subscription.abort();
  },
});
