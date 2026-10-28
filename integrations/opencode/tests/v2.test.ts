import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import V2Plugin from '../src/v2.js';
import { parseConfig } from '../src/config.js';

interface Mocks {
  calls: any[];
  turns: number;
  messages: any[];
  hooks: Record<string, (input: any) => Promise<void> | void>;
  tools: Map<string, { execute(input: any, context: any): Promise<any> }>;
  push(event: any): void;
}

/**
 * Fake OpenCode 2.x plugin context: records hooks/tools and lets a test drive the hooks directly.
 * MCP is a real local HTTP server so the plugin's own client and ledger run unmodified.
 */
async function harness(interval = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-'));
  const token = join(dir, 'token');
  writeFileSync(token, 'fixture', { mode: 0o600 });
  const mock: Mocks = { calls: [], turns: 0, messages: [], hooks: {}, tools: new Map(), push() {} };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result: any;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (msg.method === 'server/discover') result = { tools: [], prompts: [], resources: [] };
    else if (msg.method === 'tools/call') {
      mock.calls.push(msg.params);
      if (msg.params.name === 'bm_capture_turn') {
        mock.turns += 1;
        result = { interval, turn_count: mock.turns, review_due: mock.turns % interval === 0 };
      } else if (msg.params.name === 'bm_capture_review') {
        const { action, payload } = msg.params.arguments;
        if (action === 'pending') result = { reviews: [] };
        else if (action === 'idle') result = { ok: true };
        else result = { id: payload.id ?? payload.review_id, status: 'collecting', turn: 'm', data: { user: 'x' }, verified_references: [] };
      } else if (msg.params.name === 'search_notes') result = { results: [] };
      else if (msg.params.name === 'read_note') result = { permalink: 'main/found', content: 'x', checksum: 'a'.repeat(64) };
      else if (msg.params.name === 'write_note') result = { permalink: 'main/saved', action: 'created' };
      else if (msg.params.name === 'edit_note') result = { permalink: 'main/found', operation: 'find_replace', checksum: 'b'.repeat(64) };
      else throw Error(`Unexpected tool ${msg.params.name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } else throw Error(`Unexpected ${msg.method}`);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('missing address');
  const options = { endpoint: `http://127.0.0.1:${address.port}/mcp`, tokenFile: token, project: 'main', stateBackend: 'remote' };
  const originalHome = process.env.HOME;
  process.env.HOME = dir;

  let wake: (() => void) | undefined;
  const events: any[] = [];
  mock.push = (event: any) => { events.push(event); wake?.(); };

  const ctx = {
    options,
    location: { directory: '/workspace' },
    session: {
      get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: '/workspace' } }),
      context: async () => mock.messages,
      hook: async (name: string, callback: any) => { mock.hooks[name] = callback; return { dispose: async () => {} }; },
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        const editor = {
          add: (tool: any) => mock.tools.set(tool.name, tool),
          update: () => {}, remove: () => {}, list: () => [], get: () => undefined, namespace: () => {},
        };
        callback(editor);
        return { dispose: async () => {} };
      },
    },
    event: {
      async *subscribe() {
        for (;;) {
          if (events.length) { yield events.shift(); continue; }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
    },
  };

  const cleanup = await V2Plugin.setup(ctx as any);
  return {
    mock,
    config: parseConfig(options),
    async close() {
      await cleanup?.();
      process.env.HOME = originalHome;
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function userTurn(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }] };
}

test('V2 counts each user turn once and opens a review at the batch boundary', async () => {
  const h = await harness(3);
  try {
    const context = h.mock.hooks.context;
    assert.ok(context, 'context hook registered');
    for (const [n, id] of ['m1', 'm2', 'm3'].entries()) {
      h.mock.messages = [userTurn(id, `turn ${n + 1}`)];
      const out = { system: [] as any[] };
      await context({ sessionID: 'ses_test', messages: h.mock.messages, system: out.system });
      assert.equal(out.system.filter((part) => String(part.text).includes('semantic review ID')).length, n === 2 ? 1 : 0);
      if (n === 2) assert.match(String(out.system.find((part) => String(part.text).includes('semantic review ID')).text), /last 3 user turns/);
    }
    // Re-running the same message must not double count or retrigger a review.
    const again = { system: [] as any[] };
    await context({ sessionID: 'ses_test', messages: h.mock.messages, system: again.system });
    assert.equal(h.mock.turns, 3, JSON.stringify(h.mock.calls.filter((call) => call.name === 'bm_capture_turn').map((call) => call.arguments)));
    const turnCalls = h.mock.calls.filter((call) => call.name === 'bm_capture_turn');
    assert.deepEqual(turnCalls.map((call) => call.arguments.turn), ['m1', 'm2', 'm3']);
    const starts = h.mock.calls.filter((call) => call.name === 'bm_capture_review' && call.arguments.action === 'start');
    assert.equal(starts.length, 1, JSON.stringify(starts.map((call) => call.arguments)));
  } finally { await h.close(); }
});

test('V2 review tools complete a review and idle closes an unanswered one', async () => {
  const h = await harness(1);
  try {
    const context = h.mock.hooks.context;
    h.mock.messages = [userTurn('m1', 'remember this')];
    const out = { system: [] as any[] };
    await context({ sessionID: 'ses_test', messages: h.mock.messages, system: out.system });
    const instruction = out.system.map((part: any) => String(part.text)).find((text: string) => text.includes('semantic review ID'))!;
    const reviewId = /semantic review ID: ([a-f0-9]{64})/.exec(instruction)![1];

    assert.ok(h.mock.tools.has('bm_read'));
    assert.ok(h.mock.tools.has('bm_review_save'));
    assert.ok(h.mock.tools.has('bm_review_edit'));
    assert.ok(h.mock.tools.has('bm_review_complete'));

    const toolContext = { sessionID: 'ses_test' };
    const read = JSON.parse((await h.mock.tools.get('bm_read')!.execute({ review_id: reviewId, identifier: 'main/found' }, toolContext)).content);
    assert.equal(read.permalink, 'main/found');
    const completed = JSON.parse((await h.mock.tools.get('bm_review_complete')!.execute({ review_id: reviewId, status: 'saved', references: ['main/found'] }, toolContext)).content);
    assert.equal(completed.status, 'saved');

    // A fresh session with an unanswered review must be closed by the idle receipt.
    h.mock.messages = [userTurn('m2', 'second session')];
    const next = { system: [] as any[] };
    await context({ sessionID: 'ses_other', messages: h.mock.messages, system: next.system });
    h.mock.push({ type: 'session.idle', data: { sessionID: 'ses_other' } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(h.mock.calls.some((call) => call.name === 'bm_capture_review' && call.arguments.action === 'idle'));
  } finally { await h.close(); }
});
