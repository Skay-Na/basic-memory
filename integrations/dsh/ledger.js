import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

const TTL = 7 * 24 * 60 * 60 * 1000
const delay = (attempts) => Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(attempts, 4))
const parse = (s, fallback) => { try { return JSON.parse(s) } catch { return fallback } }
export const reviewId = (profile, session, turn, project) => createHash('sha256').update(JSON.stringify([profile, project, session, turn])).digest('hex').slice(0, 32)

export class Ledger {
  constructor(path, profile, project) {
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
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
      );`)
    this.profile = profile; this.project = project
    this.expire()
    const now = Date.now()
    this.db.prepare("UPDATE reviews SET status='unresolved',retry_after=?,updated=? WHERE profile=? AND project=? AND status='collecting'").run(now + 5 * 60_000, now, profile, project)
  }
  expire(now = Date.now()) {
    this.db.prepare("UPDATE reviews SET status='expired', data='{}', refs='[]', updated=? WHERE status IN ('collecting','pending','unresolved') AND created < ?").run(now, now - TTL)
    this.db.prepare('DELETE FROM inbox WHERE created < ?').run(now - TTL)
  }
  start(session, turn, cwd) {
    this.expire()
    const now = Date.now(); const id = reviewId(this.profile, session, turn, this.project)
    this.db.prepare("INSERT OR IGNORE INTO reviews(id,profile,project,cwd,session,turn,status,created,updated) VALUES(?,?,?,?,?,?,'collecting',?,?)").run(id, this.profile, this.project, cwd, session, turn, now, now)
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
    this.db.prepare('UPDATE reviews SET refs=?, updated=? WHERE id=?').run(JSON.stringify(refs), Date.now(), id)
  }
  progress(id, cwd, context) {
    const row = this.get(id, cwd)
    if (row.status === 'collecting') this.db.prepare('UPDATE reviews SET data=?,updated=? WHERE id=?').run(JSON.stringify(context), Date.now(), id)
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
    this.db.prepare('UPDATE reviews SET status=?, data=?, attempts=?, retry_after=?, updated=? WHERE id=?').run(status, JSON.stringify(data), attempts, status === 'pending' ? now + delay(attempts - 1) : 0, now, id)
    return this.get(id, cwd)
  }
  unresolved(id, cwd, context) {
    const row = this.get(id, cwd)
    if (row.status !== 'collecting') return
    const now = Date.now()
    this.db.prepare("UPDATE reviews SET status='unresolved', data=?, retry_after=?, updated=? WHERE id=? AND status='collecting'").run(JSON.stringify(context), now + 5 * 60_000, now, id)
  }
  pending(cwd, exclude) {
    this.expire()
    const rows = this.db.prepare("SELECT * FROM reviews WHERE profile=? AND project=? AND cwd=? AND id<>? AND status IN ('pending','unresolved') AND retry_after<=? ORDER BY created LIMIT 3").all(this.profile, this.project, cwd, exclude, Date.now())
    const now = Date.now()
    for (const row of rows) this.db.prepare('UPDATE reviews SET attempts=attempts+1,retry_after=?,updated=? WHERE id=?').run(now + delay(row.attempts), now, row.id)
    return rows.map(r => ({ id: r.id, status: r.status, session: r.session, turn: r.turn, data: parse(r.data, {}), references: parse(r.refs, []) }))
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
