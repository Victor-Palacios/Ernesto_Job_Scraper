// Local state for the Greenhouse auto-applier. Nothing here is ever committed:
// the repo is public and served by GitHub Pages, so the ledger, profile,
// screenshots and answer logs live in a private directory on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateDir(env = process.env) {
  return env.AUTOAPPLY_HOME || path.join(os.homedir(), '.job-autoapply');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Statuses that are final: a later run never touches these jobs again.
export const FINAL = new Set(['submitted', 'skipped_fit', 'closed']);
// Statuses that need you to look before the job is retried (pass --retry).
export const NEEDS_YOU = new Set(['needs_review', 'needs_human', 'failed']);

export function loadLedger(dir) {
  const file = path.join(dir, 'ledger.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.jobs === 'object') return data;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Unreadable ledger ${file}: ${err.message}`);
  }
  return { version: 1, jobs: {} };
}

export function writePrivate(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function saveLedger(dir, ledger) {
  writePrivate(path.join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2) + '\n');
}

export function record(ledger, key, patch, now = new Date()) {
  const prev = ledger.jobs[key] || { history: [] };
  const at = now.toISOString();
  const next = { ...prev, ...patch, updated_at: at };
  if (patch.status && patch.status !== prev.status) {
    next.history = [...(prev.history || []), { status: patch.status, at, ...(patch.detail ? { detail: patch.detail } : {}) }];
  }
  if (patch.status === 'submitted') next.submitted_at = at;
  ledger.jobs[key] = next;
  return next;
}

const localDay = d => new Date(d).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

export function submittedOnDay(ledger, now = new Date()) {
  const today = localDay(now);
  return Object.values(ledger.jobs).filter(j => j.submitted_at && localDay(j.submitted_at) === today).length;
}

// One run at a time: cron can fire while a slow run is still going.
export function acquireLock(dir, now = Date.now(), staleMs = 3 * 60 * 60 * 1000) {
  ensureDir(dir);
  const file = path.join(dir, 'run.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const age = now - fs.statSync(file).mtimeMs;
    if (age < staleMs) return null;
    fs.rmSync(file, { force: true });
    return acquireLock(dir, now, staleMs);
  }
  return () => fs.rmSync(file, { force: true });
}
