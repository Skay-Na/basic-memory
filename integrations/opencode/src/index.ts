import { z } from "zod";
import type { ZodType } from "zod";

import { capture, recall, turnsFromMessages } from "./bm.js";
import { parseConfig } from "./config.js";
import V2Plugin from "./v2.js";

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

interface V1PluginHooks {
  "experimental.chat.system.transform": (
    input: { sessionID?: string },
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.session.compacting": (input: { sessionID: string }) => Promise<void>;
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
  tool: {
    bm_recall: {
      description: string;
      args: ZodType<{ query?: string }>;
      execute(args: { query?: string }): Promise<string>;
    };
    bm_capture: {
      description: string;
      args: ZodType<{ title?: string }>;
      execute(args: { title?: string }, context: V1ToolContext): Promise<string>;
    };
  };
}

export const BasicMemoryOpenCodeV1 = async (
  { client, directory }: V1PluginInput,
  options?: unknown,
): Promise<V1PluginHooks> => {
  const config = parseConfig(options ?? {});
  const recalledSessions = new Set<string>();

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
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!config.autoRecall || !sessionID || recalledSessions.has(sessionID)) return;
      recalledSessions.add(sessionID);
      try {
        const content = await recall(config);
        if (output.system.length) output.system[0] = `${output.system[0]}\n\n${content}`;
        else output.system.push(content);
      } catch (error) {
        recalledSessions.delete(sessionID);
        await logFailure("Automatic recall", error);
      }
    },
    "experimental.session.compacting": async ({ sessionID }) => {
      if (!config.autoCapture) return;
      try {
        await captureCurrent(sessionID);
      } catch (error) {
        await logFailure("Compaction checkpoint", error);
      }
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle" || !config.autoCapture) return;
      const sessionID = (event.properties as { sessionID?: unknown } | undefined)?.sessionID;
      if (typeof sessionID !== "string") return;
      try {
        await captureCurrent(sessionID);
      } catch (error) {
        await logFailure("Automatic capture", error);
      }
    },
    tool: {
      bm_recall: {
        description: "Recall prior OpenCode session checkpoints from Basic Memory.",
        args: z.object({ query: z.string().optional() }),
        async execute(args) {
          return recall(config, args.query);
        },
      },
      bm_capture: {
        description: "Capture the current OpenCode session as a durable Basic Memory checkpoint.",
        args: z.object({ title: z.string().optional() }),
        async execute(args, context) {
          return captureCurrent(context.sessionID, args.title);
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
