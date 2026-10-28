import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

const TTL = 7 * 24 * 60 * 60 * 1000
const delay = (attempts) => Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(attempts, 4))
const parse = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }
export const reviewId = (profile, session, turn, project) => createHash('sha256').update(JSON.stringify([profile, project, session, turn])).digest('hex').slice(0, 32)

export class Ledger {
  constructor(path, profile, project, mirror = false) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
        session TEXT NOT NULL, turn INTEGER NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', refs TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0,
        retry_after INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reviews_scope ON reviews(profile, project, cwd, status, retry_after);
      CREATE TABLE IF NOT EXISTS capture_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, project TEXT NOT NULL,
        session TEXT NOT NULL, turn INTEGER NOT NULL, created INTEGER NOT NULL,
        UNIQUE(profile, project, session, turn)
      );
      CREATE TABLE IF NOT EXISTS capture_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, cwd TEXT NOT NULL, action TEXT NOT NULL,
        payload TEXT NOT NULL, created INTEGER NOT NULL, review_id TEXT
      );
      CREATE TABLE IF NOT EXISTS capture_settings_cache (project TEXT PRIMARY KEY, interval INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
      );`)
    this.profile = profile; this.project = project; this.mirror = mirror
    if (!this.db.prepare('PRAGMA table_info(capture_outbox)').all().some(row => row.name === 'review_id')) this.db.exec('ALTER TABLE capture_outbox ADD COLUMN review_id TEXT')
    if (!this.db.prepare('PRAGMA table_info(capture_turns)').all().some(row => row.name === 'remote_ordinal')) this.db.exec('ALTER TABLE capture_turns ADD COLUMN remote_ordinal INTEGER')
    this.expire()
    const now = Date.now()
    this.db.prepare("UPDATE reviews SET status='unresolved',retry_after=?,updated=? WHERE profile=? AND project=? AND status='collecting'").run(now + 5 * 60_000, now, profile, project)
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  queue(cwd, action, payload) {
    if (this.mirror) this.db.prepare('INSERT INTO capture_outbox(cwd,action,payload,created,review_id) VALUES(?,?,?,?,?)').run(cwd, action, JSON.stringify(payload), Date.now(), payload.review_id ?? payload.id ?? null)
  }
  outbox() { this.expire(); return this.db.prepare("SELECT * FROM capture_outbox WHERE action!='expired' ORDER BY seq LIMIT 100").all().map(row => ({ ...row, payload: JSON.parse(row.payload) })) }
  expiredOutbox() { return this.db.prepare("SELECT COUNT(*) AS count FROM capture_outbox WHERE action='expired'").get().count }
  acknowledge(seq) { this.db.prepare('DELETE FROM capture_outbox WHERE seq=?').run(seq) }
  captureInterval(fallback) { return this.db.prepare('SELECT interval FROM capture_settings_cache WHERE project=?').get(this.project)?.interval ?? fallback }
  setCaptureInterval(interval) { if (Number.isInteger(interval) && interval >= 1 && interval <= 100) this.db.prepare('INSERT INTO capture_settings_cache(project,interval) VALUES(?,?) ON CONFLICT(project) DO UPDATE SET interval=excluded.interval').run(this.project, interval) }
  setRemoteOrdinal(session, turn, ordinal) { if (Number.isInteger(ordinal) && ordinal > 0) this.db.prepare('UPDATE capture_turns SET remote_ordinal=? WHERE profile=? AND project=? AND session=? AND turn=?').run(ordinal, this.profile, this.project, session, Number(turn)) }
  remoteOrdinal(session, turn) { return this.db.prepare('SELECT remote_ordinal FROM capture_turns WHERE profile=? AND project=? AND session=? AND turn=?').get(this.profile, this.project, session, turn)?.remote_ordinal }
  expire(now = Date.now()) {
    this.db.prepare("UPDATE reviews SET status='expired', data='{}', refs='[]', updated=? WHERE status IN ('collecting','pending','unresolved') AND created < ?").run(now, now - TTL)
    this.db.prepare('DELETE FROM inbox WHERE created < ?').run(now - TTL)
    const expired = this.db.prepare("SELECT DISTINCT review_id FROM capture_outbox WHERE review_id IS NOT NULL AND action!='expired' AND created<?").all(now - TTL)
    for (const { review_id } of expired) {
      this.db.prepare("UPDATE reviews SET status='expired',data='{}',refs='[]',updated=? WHERE id=?").run(now, review_id)
      this.db.prepare("UPDATE capture_outbox SET action='expired',payload='{}' WHERE review_id=?").run(review_id)
    }
  }
  captureTurn(session, turn, cwd = '', interval = 5) {
    return this.transaction(() => {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO capture_turns(profile,project,session,turn,created) VALUES(?,?,?,?,?)').run(this.profile, this.project, session, turn, Date.now())
    if (inserted.changes) this.queue(cwd, 'turn', { session, turn: String(turn), interval })
    const row = this.db.prepare('SELECT seq FROM capture_turns WHERE profile=? AND project=? AND session=? AND turn=?').get(this.profile, this.project, session, turn)
    return this.db.prepare('SELECT COUNT(*) AS count FROM capture_turns WHERE profile=? AND project=? AND session=? AND seq<=?').get(this.profile, this.project, session, row.seq).count
    })
  }
  start(session, turn, cwd) {
    this.expire()
    const now = Date.now(); const id = reviewId(this.profile, session, turn, this.project)
    this.transaction(() => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO reviews(id,profile,project,cwd,session,turn,status,created,updated) VALUES(?,?,?,?,?,?,'collecting',?,?)").run(id, this.profile, this.project, cwd, session, turn, now, now)
      if (inserted.changes) this.queue(cwd, 'start', { review_id: id, session, turn: String(turn) })
    })
    return this.get(id, cwd)
  }
  get(id, cwd) {
    const row = this.db.prepare('SELECT * FROM reviews WHERE id=? AND profile=? AND project=? AND cwd=?').get(id, this.profile, this.project, cwd)
    if (!row) throw new Error('Review is not available in this profile, project, and workspace')
    return { ...row, data: parse(row.data, {}), refs: parse(row.refs, []) }
  }
  ref(id, cwd, ref) {
    const row = this.get(id, cwd)
    if (!['collecting', 'pending', 'unresolved'].includes(row.status)) throw new Error('Review is already complete')
    const refs = [...new Set([...row.refs, ref])]
    this.transaction(() => {
      this.db.prepare('UPDATE reviews SET refs=?, updated=? WHERE id=?').run(JSON.stringify(refs), Date.now(), id)
      this.queue(cwd, 'start', { review_id: id, session: row.session, turn: String(row.turn) })
      this.queue(cwd, 'ref', { id, reference: ref })
    })
  }
  progress(id, cwd, context) {
    const row = this.get(id, cwd)
    if (row.status === 'collecting') this.transaction(() => {
      this.db.prepare('UPDATE reviews SET data=?,updated=? WHERE id=?').run(JSON.stringify(context), Date.now(), id)
      this.queue(cwd, 'start', { review_id: id, session: row.session, turn: String(row.turn) })
      this.queue(cwd, 'progress', { id, data: context })
    })
  }
  complete(id, cwd, status, reason, refs, drafts) {
    const row = this.get(id, cwd)
    if (!['collecting', 'pending', 'unresolved'].includes(row.status)) {
      if (row.status === status && JSON.stringify(row.data) === JSON.stringify({ reason, references: refs })) return row
      throw new Error('Review is already complete')
    }
    if (!['saved', 'no_memory', 'pending'].includes(status)) throw new Error('Invalid review status')
    if (status === 'saved' && (!refs.length || refs.some(ref => !row.refs.includes(ref)))) throw new Error('Saved references must be confirmed by bm_read or bm_review_save for this review')
    if (status === 'no_memory' && !reason) throw new Error('no_memory requires a reason')
    if (refs.some(ref => !row.refs.includes(ref))) throw new Error('References must be verified for this review')
    if (status === 'pending' && (!drafts.length || drafts.some(d => typeof d.title !== 'string' || !d.title.trim() || typeof d.content !== 'string' || !d.content.trim()))) throw new Error('pending requires structured drafts')
    if (drafts.length > 20 || JSON.stringify(drafts).length > 100_000) throw new Error('Drafts exceed storage limits')
    const now = Date.now(); const attempts = row.attempts + (status === 'pending' ? 1 : 0)
    const data = status === 'pending' ? { reason, references: refs, drafts: drafts.map(({ title, content }) => ({ title, content })) } : { reason, references: refs }
    this.transaction(() => {
      this.db.prepare('UPDATE reviews SET status=?, data=?, attempts=?, retry_after=?, updated=? WHERE id=?').run(status, JSON.stringify(data), attempts, status === 'pending' ? now + delay(attempts - 1) : 0, now, id)
      this.queue(cwd, 'start', { review_id: id, session: row.session, turn: String(row.turn) })
      for (const reference of refs) this.queue(cwd, 'ref', { id, reference })
      this.queue(cwd, 'complete', { id, status, data })
    })
    return this.get(id, cwd)
  }
  unresolved(id, cwd, context) {
    const row = this.get(id, cwd)
    if (row.status !== 'collecting') return
    const now = Date.now()
    this.transaction(() => {
      this.db.prepare("UPDATE reviews SET status='unresolved', data=?, retry_after=?, updated=? WHERE id=? AND status='collecting'").run(JSON.stringify(context), now + 5 * 60_000, now, id)
      this.queue(cwd, 'start', { review_id: id, session: row.session, turn: String(row.turn) })
      this.queue(cwd, 'unresolved', { id, data: context })
    })
  }
  pending(cwd, exclude) {
    this.expire()
    const rows = this.db.prepare("SELECT * FROM reviews WHERE profile=? AND project=? AND cwd=? AND id<>? AND status IN ('pending','unresolved') AND retry_after<=? ORDER BY created LIMIT 3").all(this.profile, this.project, cwd, exclude, Date.now())
    const now = Date.now()
    for (const row of rows) this.db.prepare('UPDATE reviews SET attempts=attempts+1,retry_after=?,updated=? WHERE id=?').run(now + delay(row.attempts), now, row.id)
    return rows.map(r => ({ id: r.id, status: r.status, session: r.session, turn: r.turn, data: parse(r.data, {}), references: parse(r.refs, []) }))
  }
  importPending(cwd, row) {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id) || !['pending', 'unresolved'].includes(row.status) || typeof row.session !== 'string' || !Number.isSafeInteger(Number(row.turn)) || !row.data || typeof row.data !== 'object' || !Array.isArray(row.verified_references)) throw new Error('Invalid remote pending review')
    const now = Date.now()
    this.db.prepare('INSERT OR IGNORE INTO reviews(id,profile,project,cwd,session,turn,status,data,refs,attempts,retry_after,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, this.profile, this.project, cwd, row.session, Number(row.turn), row.status, JSON.stringify(row.data), JSON.stringify(row.verified_references), Number(row.attempts || 0), 0, Number(row.created ? row.created * 1000 : now), now)
  }
  queueInbox(id, cwd, title, content, metadata) {
    this.db.prepare('INSERT OR IGNORE INTO inbox(id,profile,project,cwd,title,content,metadata,created) VALUES(?,?,?,?,?,?,?,?)').run(id, this.profile, this.project, cwd, title, content, JSON.stringify(metadata), Date.now())
  }
  inbox(cwd) {
    this.expire()
    return this.db.prepare('SELECT * FROM inbox WHERE profile=? AND project=? AND cwd=? AND retry_after<=? ORDER BY created LIMIT 3').all(this.profile, this.project, cwd, Date.now()).map(r => ({ ...r, metadata: parse(r.metadata, {}) }))
  }
  inboxSuccess(id) { this.db.prepare('DELETE FROM inbox WHERE id=? AND profile=? AND project=?').run(id, this.profile, this.project) }
  inboxFailed(id) {
    const row = this.db.prepare('SELECT attempts FROM inbox WHERE id=? AND profile=? AND project=?').get(id, this.profile, this.project)
    if (row) this.db.prepare('UPDATE inbox SET attempts=attempts+1,retry_after=? WHERE id=?').run(Date.now() + delay(row.attempts), id)
  }
  close() { this.db.close() }
}
