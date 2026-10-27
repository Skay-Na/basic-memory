import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.js'
import { Ledger } from '../ledger.js'

const waitUntil = async (fn) => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('timed out') }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bm-review-'))
  const token = join(dir, 'token'); writeFileSync(token, 'fixture', { mode: 0o600 })
  const requests = []; const notes = new Map(); const behavior = { failWrites: 0 }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''; for await (const part of req) body += part
    const msg = JSON.parse(body); requests.push(msg)
    if (!('id' in msg)) { res.writeHead(202).end(); return }
    const send = (result) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (msg.method === 'server/discover') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })); return }
    if (msg.method === 'initialize') { send({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); return }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params
      let value
      if (name === 'search_notes') value = { results: args.search_type === 'hybrid' ? [] : [{ title: 'existing', permalink: 'review/existing' }] }
      else if (name === 'read_note') value = notes.get(args.identifier) || { error: 'NOTE_NOT_FOUND' }
      else if (name === 'write_note') {
        if (behavior.failWrites > 0) { behavior.failWrites--; send({ isError: true, content: [{ type: 'text', text: 'offline' }] }); return }
        value = { action: 'created', title: args.title, permalink: `review/${args.title}`, checksum: 'a'.repeat(64), frontmatter: args.metadata }; notes.set(args.title, value)
      }
      else if (name === 'edit_note') value = { permalink: args.identifier, operation: args.operation, checksum: 'b'.repeat(64) }
      else value = { error: 'UNKNOWN_TOOL' }
      send({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: { result: value } }); return
    }
    send({})
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const handlers = new Map(); const tools = new Map(); let disposer
  const ctx = { tools: { register(t) { tools.set(t.name, t) } }, systemPrompt: { section() {} }, on(n, f) { handlers.set(n, f) }, effect(f) { disposer = f() }, logger: { warn() {} } }
  const config = { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, tokenFile: token, project: 'review', profileName: 'test', ledgerPath: join(dir, 'state', 'reviews.sqlite3'), toolTimeoutMs: 3000 }
  const cleanup = async () => { disposer?.(); await new Promise(r => setTimeout(r, 40)); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }) }
  return { dir, ctx, handlers, tools, config, requests, notes, behavior, cleanup }
}

test('normal DSH user events are captured, and empty hybrid search falls back to text', async () => {
  const f = await fixture()
  try {
    apply(f.ctx, f.config)
    const session = { id: 'test-session', header: { cwd: '/workspace/a' } }; const agent = { session }
    const emit = f.handlers.get('session/event')
    emit(session, { type: 'turn/start', data: { turn: 1 } })
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    const decision = await f.handlers.get('agent/pre-step')({ agent, messages: [msg], turn: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
    assert.match(decision.messages.at(-1).content[0].text, /review ID/)
    emit(session, { type: 'user/message', data: msg })
    emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } } })
    emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitUntil(() => f.requests.some(r => r.method === 'tools/call' && r.params.name === 'write_note'))
    const searchModes = f.requests.filter(r => r.method === 'tools/call' && r.params.name === 'search_notes').map(r => r.params.arguments.search_type)
    assert.deepEqual(searchModes, ['hybrid', 'text'])
    const write = f.requests.find(r => r.method === 'tools/call' && r.params.name === 'write_note').params.arguments
    assert.match(write.content, /hello/); assert.match(write.content, /answer/); assert.equal(write.overwrite, false)
  } finally { await f.cleanup() }
})

test('review receipt accepts verified writes, and blocks cross-workspace access', async () => {
  const f = await fixture()
  try {
    apply(f.ctx, { ...f.config, autoCapture: false, autoRecall: false })
    const session = { id: 'semantic-session', header: { cwd: '/workspace/a' } }; const agent = { session }
    f.handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 4 } })
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember a stable preference' }] }
    const decision = await f.handlers.get('agent/pre-step')({ agent, messages: [msg], turn: 4, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
    const id = decision.messages.at(-1).content[0].text.match(/review ID: ([a-f0-9]+)/)[1]
    const exec = { agent, signal: new AbortController().signal }
    await assert.rejects(() => f.tools.get('bm_review_complete').execute({ review_id: id, status: 'saved', references: ['forged'] }, exec), /confirmed|verified/)
    const saved = JSON.parse((await f.tools.get('bm_review_save').execute({ review_id: id, title: 'preference', content: 'A durable preference' }, exec)).text)
    const read = JSON.parse((await f.tools.get('bm_read').execute({ review_id: id, identifier: 'preference' }, exec)).text)
    await f.tools.get('bm_review_edit').execute({ review_id: id, identifier: read.permalink, expected_checksum: read.checksum, find_text: 'old', content: 'new' }, exec)
    const edit = f.requests.find(r => r.method === 'tools/call' && r.params.name === 'edit_note').params.arguments
    assert.equal(edit.expected_checksum, 'a'.repeat(64)); assert.equal(edit.expected_replacements, 1)
    const receipt = JSON.parse((await f.tools.get('bm_review_complete').execute({ review_id: id, status: 'saved', references: [saved.permalink] }, exec)).text)
    assert.equal(receipt.status, 'saved')
    await assert.rejects(() => f.tools.get('bm_read').execute({ review_id: id, identifier: 'preference' }, { agent: { session: { id: 'other', header: { cwd: '/workspace/b' } } }, signal: exec.signal }), /not available/)
  } finally { await f.cleanup() }
})

test('ledger persists pending drafts, recovers interrupted reviews, and isolates scopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bm-ledger-')); const path = join(dir, 'state', 'db')
  try {
    let store = new Ledger(path, 'desktop', 'main'); const row = store.start('s', 1, '/a')
    store.complete(row.id, '/a', 'pending', 'offline', [], [{ title: 'fact', content: 'confirmed' }]); store.close()
    store = new Ledger(path, 'desktop', 'main')
    assert.equal(store.get(row.id, '/a').status, 'pending'); assert.throws(() => store.get(row.id, '/b'))
    const interrupted = store.start('s', 2, '/a'); store.progress(interrupted.id, '/a', { user: 'request', assistant: 'answer' }); store.close()
    store = new Ledger(path, 'desktop', 'main'); assert.equal(store.get(interrupted.id, '/a').status, 'unresolved'); assert.equal(store.get(interrupted.id, '/a').data.user, 'request'); store.close()
    store = new Ledger(path, 'desktop', 'main'); const empty = store.start('s', 3, '/a')
    store.complete(empty.id, '/a', 'no_memory', 'ordinary question', [], [])
    assert.equal(store.complete(empty.id, '/a', 'no_memory', 'ordinary question', [], []).status, 'no_memory')
    assert.throws(() => store.complete(empty.id, '/a', 'saved', '', ['forged'], [])); store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('inbox survives a failed write and retries on a later turn', async () => {
  const f = await fixture(); f.behavior.failWrites = 1
  try {
    apply(f.ctx, { ...f.config, semanticCapture: false, autoRecall: false })
    const session = { id: 'retry-session', header: { cwd: '/workspace/a' } }; const emit = f.handlers.get('session/event')
    emit(session, { type: 'turn/start', data: { turn: 1 } })
    emit(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'request' }] } })
    emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } } })
    emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const db = new DatabaseSync(f.config.ledgerPath)
    try {
      await waitUntil(() => db.prepare('SELECT attempts FROM inbox').get()?.attempts === 1)
      db.exec('UPDATE inbox SET retry_after=0')
      emit(session, { type: 'turn/start', data: { turn: 2 } })
      await waitUntil(() => db.prepare('SELECT COUNT(*) AS count FROM inbox').get().count === 0)
      assert.equal(f.notes.size, 1)
    } finally { db.close() }
  } finally { await f.cleanup() }
})
