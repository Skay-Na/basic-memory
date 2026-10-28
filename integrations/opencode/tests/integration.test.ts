import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConfig } from '../src/config.js';
import { capture, recall } from '../src/bm.js';

test('V1 batches review by session message count', async () => {
  const { BasicMemoryOpenCodeV1 } = await import('../src/index.js');
  const original = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'opencode-batch-')); process.env.HOME = dir;
  let count = 0;
  const client = { session: { messages: async () => ({ data: Array.from({ length: count }, (_, i) => ({ info: { id: String(i), role: 'user' }, parts: [{ type: 'text', text: 'hello' }] })) }) }, app: { log: async () => {} } };
  try {
    const plugin = await BasicMemoryOpenCodeV1({ client, directory: '/workspace' }, { endpoint: 'https://example.test', tokenFile: '/tmp/token', project: 'main', autoRecall: false });
    for (count = 1; count <= 5; count++) {
      const out = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 's' }, out);
      assert.equal(out.system.length, count === 5 ? 1 : 0);
      if (count === 5) assert.match(out.system[0], /last 5 user turns/);
    }
  } finally { process.env.HOME = original; rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated remote recall falls back and explicit capture cannot overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-bm-'));
  const token = join(dir, 'token'); writeFileSync(token, 'test-token', { mode: 0o600 });
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result: any;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (msg.method === 'server/discover') result = { tools: [], prompts: [], resources: [] };
    else if (msg.method === 'tools/call') {
      calls.push(msg.params);
      if (msg.params.name === 'search_notes' && msg.params.arguments.search_type === 'hybrid') {
        result = { isError: true, content: [{ type: 'text', text: 'semantic search is unavailable' }] };
      } else {
        const data = msg.params.name === 'search_notes' ? { results: [{ title: 'found', permalink: 'main/found', updated_at: '2026-10-28T00:00:00Z' }, { title: 'inbox', permalink: 'main/opencode/inbox/raw', metadata: { status: 'pending_review' } }] } : { permalink: 'main/test' };
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
    } else throw Error(`Unexpected ${msg.method}`);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
    const config = parseConfig({ endpoint: `http://127.0.0.1:${address.port}/mcp`, tokenFile: token, project: 'isolated' });
    const seen = new Map<string, string>();
    const firstRecall = await recall(config, 'topic', { auto: true, seen });
    assert.match(firstRecall, /main\/found/);
    assert.doesNotMatch(firstRecall, /inbox/);
    // Second auto recall with same note version should be suppressed
    assert.equal(await recall(config, 'topic', { auto: true, seen }), '');
    assert.match(await capture(config, { sessionId: 'session', cwd: '/tmp', turns: [{ role: 'user', text: 'hello' }] }), /main\/test/);
    assert.deepEqual(calls.map(c => c.arguments.search_type).slice(0, 2), ['hybrid', 'text']);
    assert.equal(calls.at(-1).arguments.overwrite, false);
    assert.equal(calls.at(-1).arguments.project, 'isolated');
    assert.throws(() => parseConfig({ endpoint: 'https://example.com', tokenFile: token, project: 'x', autoCapture: true }), /disabled/);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('semantic review persists scoped pending drafts and validates references', async () => {
  const { ledger } = await import('../src/ledger.js');
  const original = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'opencode-ledger-')); process.env.HOME = dir;
  const config = parseConfig({ endpoint: 'https://example.test/mcp', tokenFile: '/tmp/token', project: 'isolated' });
  try {
    const row = await ledger(config, '/workspace', 'start', { session: 's', message: 'm', user: 'test user' });
    await assert.rejects(ledger(config, '/other', 'get', { id: row.id }));
    await assert.rejects(ledger(config, '/workspace', 'complete', { id: row.id, status: 'saved', references: ['unverified'] }));
    await ledger(config, '/workspace', 'ref', { id: row.id, ref: 'isolated/example' });
    const pending = await ledger(config, '/workspace', 'complete', { id: row.id, status: 'pending', references: ['isolated/example'], drafts: [{ title: 'Fact', content: 'Confirmed fact' }] });
    assert.equal(pending.status, 'pending'); assert.equal(pending.data.drafts[0].title, 'Fact');
    const recovered = await ledger(config, '/workspace', 'get', { id: row.id }); assert.equal(recovered.data.drafts[0].content, 'Confirmed fact');
    const saved = await ledger(config, '/workspace', 'complete', { id: row.id, status: 'saved', references: ['isolated/example'] });
    assert.equal(saved.status, 'saved'); assert.equal(saved.data.drafts, undefined);
  } finally { process.env.HOME = original; rmSync(dir, { recursive: true, force: true }); }
});

test('remote review ledger uses authenticated MCP and preserves receipt operations', async () => {
  const { ledger } = await import('../src/ledger.js');
  const dir = mkdtempSync(join(tmpdir(), 'opencode-remote-')); const token = join(dir, 'token');
  const originalHome = process.env.HOME; process.env.HOME = dir;
  writeFileSync(token, 'fixture', { mode: 0o600 });
  const calls: any[] = []; let offline = true;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result: any;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (msg.method === 'server/discover') result = { tools: [], prompts: [], resources: [] };
    else if (msg.method === 'tools/call') {
      if (offline) { res.writeHead(503).end(); return; }
      calls.push(msg.params); const { action, payload } = msg.params.arguments;
      const row = msg.params.name === 'bm_capture_turn' ? { interval: 2, turn_count: 1, review_due: false } : action === 'pending' ? { reviews: [{ id: 'restored-id', status: 'unresolved', session: 'old', turn: 'old-message', data: { user: 'earlier' }, verified_references: [] }] } : { id: payload.expected_id ?? payload.id, status: action === 'complete' ? payload.status : 'collecting', turn: 'm', data: payload.data ?? {}, verified_references: action === 'ref' ? [payload.reference] : [] };
      result = { content: [{ type: 'text', text: JSON.stringify(row) }], structuredContent: row };
    } else throw Error(`Unexpected ${msg.method}`);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
    const config = parseConfig({ endpoint: `http://127.0.0.1:${address.port}/mcp`, tokenFile: token, project: 'main', stateBackend: 'remote' });
    const started = await ledger(config, '/workspace', 'start', { session: 's', message: 'm', user: 'hello' }); assert.match(started.id, /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 0); offline = false;
    await ledger(config, '/workspace', 'get', { id: started.id });
    const verified = await ledger(config, '/workspace', 'ref', { id: started.id, ref: 'main/fact' }); assert.deepEqual(verified.refs, ['main/fact']);
    const completed = await ledger(config, '/workspace', 'complete', { id: started.id, status: 'saved', references: ['main/fact'] }); assert.equal(completed.status, 'saved');
    const restored = await ledger(config, '/workspace', 'pending', { id: started.id }); assert.equal(restored[0].id, 'restored-id');
    const turn = await ledger(config, '/workspace', 'turn', { session: 's', message: 'next', interval: 5 }); assert.equal(turn.interval, 2); assert.equal(turn.ordinal, 1);
    assert.deepEqual(calls.map(call => call.arguments.action ?? 'turn'), ['start', 'start', 'ref', 'start', 'ref', 'complete', 'pending', 'turn']);
    assert.ok(calls.every(call => ['bm_capture_review', 'bm_capture_turn'].includes(call.name) && !('output_format' in call.arguments)));
  } finally { process.env.HOME = originalHome; server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired unsent review is scrubbed and remains visible as unconfirmed', async () => {
  const { ledger } = await import('../src/ledger.js');
  const originalHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'opencode-expired-')); process.env.HOME = dir;
  const token = join(dir, 'token'); writeFileSync(token, 'fixture', { mode: 0o600 });
  const config = parseConfig({ endpoint: 'http://127.0.0.1:1/mcp', tokenFile: token, project: 'main', stateBackend: 'remote' });
  try {
    const row = await ledger(config, '/workspace', 'start', { session: 's', message: 'm', user: 'private text' });
    const db = join(dir, '.local/share/opencode/basic-memory/reviews.sqlite3');
    execFileSync('python3', ['-c', 'import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE outbox SET created=?",(time.time()-604801,)); c.commit()', db]);
    const status = await ledger(config, '/workspace', 'outbox_status');
    assert.equal(status.pending, 0); assert.equal(status.expired, 1);
    const expired = await ledger(config, '/workspace', 'get', { id: row.id });
    assert.equal(expired.status, 'expired'); assert.deepEqual(expired.data, {});
  } finally { process.env.HOME = originalHome; rmSync(dir, { recursive: true, force: true }); }
});

test('legacy local pending review queues its original id for remote migration', async () => {
  const { ledger } = await import('../src/ledger.js');
  const originalHome = process.env.HOME, dir = mkdtempSync(join(tmpdir(), 'opencode-legacy-')); process.env.HOME = dir;
  const token = join(dir, 'token'); writeFileSync(token, 'fixture', { mode: 0o600 });
  const base = { endpoint: 'http://127.0.0.1:1/mcp', tokenFile: token, project: 'main' };
  try {
    const local = parseConfig(base), remote = parseConfig({ ...base, stateBackend: 'remote' });
    const row = await ledger(local, '/workspace', 'start', { session: 's', message: 'm', user: 'test' });
    await ledger(local, '/workspace', 'complete', { id: row.id, status: 'pending', drafts: [{ title: 'a', content: 'b' }] });
    await ledger(remote, '/workspace', 'complete', { id: row.id, status: 'no_memory', reason: 'reviewed' });
    const db = join(dir, '.local/share/opencode/basic-memory/reviews.sqlite3');
    const result = execFileSync('python3', ['-c', 'import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("SELECT action,payload FROM outbox ORDER BY seq").fetchall()))', db], { encoding: 'utf8' });
    const events = JSON.parse(result); assert.deepEqual(events.map((event: string[]) => event[0]), ['start', 'complete']);
    assert.equal(JSON.parse(events[0][1]).review_id, row.id);
  } finally { process.env.HOME = originalHome; rmSync(dir, { recursive: true, force: true }); }
});
