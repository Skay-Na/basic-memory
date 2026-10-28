import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { OpenCodeMemoryConfig } from './config.js';
import { call } from './bm.js';

function localLedger(config: OpenCodeMemoryConfig, cwd: string, op: string, data: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [fileURLToPath(new URL('./ledger.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.on('error', reject);
    child.on('close', code => { if (code) reject(new Error(err.trim() || 'Review ledger failed')); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } });
    child.stdin.end(JSON.stringify({ ...data, op, path: join(homedir(), '.local', 'share', 'opencode', 'basic-memory', 'reviews.sqlite3'), project: config.project, cwd, mirror: config.stateBackend === 'remote' }));
  });
}

const flushes = new Map<string, Promise<void>>();
async function flush(config: OpenCodeMemoryConfig, cwd: string): Promise<void> {
  const key = JSON.stringify([config.endpoint, config.project, cwd]);
  const previous = flushes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const scope = createHash('sha256').update(cwd).digest('hex');
    const events = await localLedger(config, cwd, 'outbox_list');
    for (const event of events) {
      const response = event.action === 'turn'
        ? await call(config, 'bm_capture_turn', { agent: 'opencode', scope, ...event.payload })
        : await call(config, 'bm_capture_review', { agent: 'opencode', scope, action: event.action, payload: event.payload });
      if (event.action === 'start' && response.id !== event.payload.expected_id) throw new Error('Remote review identity mismatch');
      if (event.action === 'turn' && Number.isInteger(response.interval) && Number.isInteger(response.turn_count)) await localLedger(config, cwd, 'set_turn_state', { interval: response.interval, ordinal: response.turn_count, session: event.payload.session, message: event.payload.turn });
      await localLedger(config, cwd, 'outbox_ack', { seq: event.seq });
    }
  });
  flushes.set(key, current);
  try { await current; } finally { if (flushes.get(key) === current) flushes.delete(key); }
}

export async function ledger(config: OpenCodeMemoryConfig, cwd: string, op: string, data: Record<string, unknown> = {}): Promise<any> {
  if (config.stateBackend === 'remote' && op === 'pending') {
    try {
      await flush(config, cwd);
      const scope = createHash('sha256').update(cwd).digest('hex');
      const remote = await call(config, 'bm_capture_review', { agent: 'opencode', scope, action: 'pending', payload: {} });
      if (!Array.isArray(remote.reviews)) throw new Error('Invalid remote pending reviews');
      for (const row of remote.reviews) await localLedger(config, cwd, 'import_pending', { row });
    } catch { /* Local pending reviews remain available when the service is offline. */ }
  }
  const result = await localLedger(config, cwd, op, data);
  if (config.stateBackend === 'remote') {
    try { await flush(config, cwd); } catch { /* Durable outbox retries on the next ledger operation. */ }
  }
  return config.stateBackend === 'remote' && op === 'turn' ? localLedger(config, cwd, 'get_interval', { interval: data.interval, session: data.session, message: data.message }) : result;
}
