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
  const requests = []; const notes = new Map(); const behavior = { failWrites: 0, stateOffline: false, remoteOrdinal: 1 }
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
      if (name === 'bm_capture_turn' || name === 'bm_capture_review') {
        if (behavior.stateOffline) { send({ isError: true, content: [{ type: 'text', text: 'offline' }] }); return }
        value = name === 'bm_capture_turn' ? { turn_count: behavior.remoteOrdinal, interval: 5, review_due: true } : args.action === 'pending' ? { reviews: [] } : { id: args.payload.review_id ?? args.payload.id, status: 'collecting' }
      }
      else if (name === 'search_notes') {
        if (args.search_type === 'hybrid' && behavior.hybridError) {
          send({ isError: true, content: [{ type: 'text', text: 'semantic search is unavailable' }] })
          return
        }
        value = {
          results: args.search_type === 'hybrid'
            ? (behavior.hybridResults ?? [
                { title: 'existing', permalink: 'review/existing', updated_at: '2026-10-28T00:00:00Z' },
                { title: 'inbox-noise', permalink: 'review/dsh/inbox/noise', metadata: { status: 'pending_review' } },
              ])
            : [{ title: 'existing', permalink: 'review/existing', updated_at: '2026-10-28T00:00:00Z' }],
        }
      }
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
  const config = { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, tokenFile: token, project: 'review', profileName: 'test', ledgerPath: join(dir, 'state', 'reviews.sqlite3'), toolTimeoutMs: 3000, semanticCaptureInterval: 1 }
  const cleanup = async () => { disposer?.(); await new Promise(r => setTimeout(r, 40)); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }) }
  return { dir, ctx, handlers, tools, config, requests, notes, behavior, cleanup }
}

test('normal DSH user events are captured, failed hybrid falls back to text, and recall filters inbox/duplicates', async () => {
  const f = await fixture()
  f.behavior.hybridError = true
  try {
    apply(f.ctx, f.config)
    const session = { id: 'test-session', header: { cwd: '/workspace/a' } }; const agent = { session }
    const emit = f.handlers.get('session/event')
    emit(session, { type: 'turn/start', data: { turn: 1 } })
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'check architecture decision' }] }
    const decision = await f.handlers.get('agent/pre-step')({ agent, messages: [msg], turn: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
    assert.match(decision.messages.at(-1).content[0].text, /review ID/)
    assert.match(decision.messages.at(-1).content[0].text, /review\/existing/)
    // Turn 2 with same note should not re-inject the already seen note
    f.behavior.hybridError = false
    const decision2 = await f.handlers.get('agent/pre-step')({ agent, messages: [msg], turn: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg] }))
    assert.doesNotMatch(decision2.messages.at(-1).content[0].text, /<basic-memory-reference/)
    assert.doesNotMatch(decision2.messages.at(-1).content[0].text, /inbox-noise/)
    emit(session, { type: 'user/message', data: msg })
    emit(session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } } })
    emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await waitUntil(() => f.requests.some(r => r.method === 'tools/call' && r.params.name === 'write_note'))
    const searchModes = f.requests.filter(r => r.method === 'tools/call' && r.params.name === 'search_notes').map(r => r.params.arguments.search_type)
    assert.deepEqual(searchModes, ['hybrid', 'text', 'hybrid'])
    const write = f.requests.find(r => r.method === 'tools/call' && r.params.name === 'write_note').params.arguments
    assert.match(write.content, /check architecture decision/); assert.match(write.content, /answer/); assert.equal(write.overwrite, false)
  } finally { await f.cleanup() }
})

test('semantic review is prompted every five distinct turns per session', async () => {
  const f = await fixture()
  try {
    apply(f.ctx, { ...f.config, semanticCaptureInterval: 5, autoCapture: false, autoRecall: false })
    const agent = { session: { id: 'batch', header: { cwd: '/workspace/a' } } }
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    for (let turn = 1; turn <= 5; turn++) {
      const decision = await f.handlers.get('agent/pre-step')({ agent, turn }, async () => ({ kind: 'enter', messages: [msg] }))
      assert.equal(decision.messages.length, turn === 5 ? 2 : 1)
      if (turn === 5) assert.match(decision.messages[1].content[0].text, /last 5 user turns/)
    }
  } finally { await f.cleanup() }
})

test('remote state outbox survives an outage and replays in order', async () => {
  const f = await fixture(); f.behavior.stateOffline = true
  try {
    apply(f.ctx, { ...f.config, stateBackend: 'remote', autoCapture: false, autoRecall: false })
    const agent = { session: { id: 'offline', header: { cwd: '/workspace/a' } } }
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    const pre = f.handlers.get('agent/pre-step')
    await pre({ agent, turn: 1 }, async () => ({ kind: 'enter', messages: [msg] }))
    const db = new DatabaseSync(f.config.ledgerPath)
    try {
      await waitUntil(() => f.requests.some(r => r.params?.name === 'bm_capture_turn'))
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM capture_outbox WHERE action!='expired'").get().n, 2)
      f.behavior.stateOffline = false
      await pre({ agent, turn: 2 }, async () => ({ kind: 'enter', messages: [msg] }))
      await waitUntil(() => db.prepare("SELECT COUNT(*) AS n FROM capture_outbox WHERE action!='expired'").get().n === 0)
      assert.ok(f.requests.some(r => r.params?.name === 'bm_capture_review' && r.params.arguments.action === 'start'))
    } finally { db.close() }
  } finally { await f.cleanup() }
})

test('remote ordinal restores a batch after local state loss', async () => {
  const f = await fixture(); f.behavior.remoteOrdinal = 5
  try {
    apply(f.ctx, { ...f.config, stateBackend: 'remote', semanticCaptureInterval: 5, autoCapture: false, autoRecall: false })
    const agent = { session: { id: 'restored', header: { cwd: '/workspace/a' } } }
    const msg = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
    const decision = await f.handlers.get('agent/pre-step')({ agent, turn: 5 }, async () => ({ kind: 'enter', messages: [msg] }))
    assert.match(decision.messages.at(-1).content[0].text, /last 5 user turns/)
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

test('batch turn counts survive reopening and ignore duplicate turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bm-count-')); const path = join(dir, 'db')
  try {
    let store = new Ledger(path, 'desktop', 'main')
    for (let turn = 1; turn <= 4; turn++) assert.equal(store.captureTurn('session', turn), turn)
    store.close()
    store = new Ledger(path, 'desktop', 'main')
    assert.equal(store.captureTurn('session', 4), 4)
    assert.equal(store.captureTurn('session', 5), 5)
    assert.equal(store.captureTurn('session', 2), 2)
    assert.equal(store.captureTurn('other', 5), 1)
    store.close()
    store = new Ledger(path, 'desktop', 'other')
    assert.equal(store.captureTurn('session', 5), 1)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('remote pending can be restored and stale unsent content expires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bm-restore-')); const path = join(dir, 'db')
  try {
    const store = new Ledger(path, 'desktop', 'main', true)
    store.setCaptureInterval(2)
    assert.equal(store.captureInterval(5), 2)
    store.importPending('/a', { id: 'a'.repeat(32), session: 's', turn: '1', status: 'pending', data: { drafts: [{ title: 't', content: 'secret' }] }, verified_references: [], created: Date.now() / 1000 })
    assert.equal(store.pending('/a', '')[0].id, 'a'.repeat(32))
    const local = store.start('s2', 1, '/a')
    store.db.prepare('UPDATE capture_outbox SET created=? WHERE review_id=?').run(Date.now() - 8 * 86400000, local.id)
    store.expire()
    assert.equal(store.get(local.id, '/a').status, 'expired')
    assert.equal(store.expiredOutbox(), 1)
    assert.equal(store.db.prepare('SELECT payload FROM capture_outbox WHERE review_id=?').get(local.id).payload, '{}')
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy local receipt enqueues its remote start and verified references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bm-migrate-')); const path = join(dir, 'db')
  try {
    let store = new Ledger(path, 'desktop', 'main'); const row = store.start('s', 1, '/a')
    store.ref(row.id, '/a', 'main/fact'); store.close()
    store = new Ledger(path, 'desktop', 'main', true)
    store.complete(row.id, '/a', 'saved', '', ['main/fact'], [])
    assert.deepEqual(store.outbox().map(event => event.action), ['start', 'ref', 'complete'])
    store.close()
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
