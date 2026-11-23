// Picks which scraped jobs to try. Pure functions so they are unit-testable.
import { FINAL, NEEDS_YOU } from './ledger.mjs';

// Hosted Greenhouse boards only. Company-site embeds (?gh_jid=) don't carry the
// board token, so they are skipped rather than guessed.
const HOSTED = /^https?:\/\/(?:job-boards(?:\.eu)?|boards(?:\.eu)?)\.greenhouse\.io\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/i;
const EMBED = /^https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_app\?(.+)$/i;

export function greenhouseTarget(url) {
  if (typeof url !== 'string') return null;
  let board, jobId, eu = /\.eu\.greenhouse\.io/i.test(url);
  const m = HOSTED.exec(url);
  if (m) [, board, jobId] = m;
  else {
    const e = EMBED.exec(url);
    if (!e) return null;
    const q = new URLSearchParams(e[1]);
    board = q.get('for'); jobId = q.get('token');
    if (!board || !/^\d+$/.test(jobId || '')) return null;
  }
  board = board.toLowerCase();
  const host = eu ? 'job-boards.eu.greenhouse.io' : 'job-boards.greenhouse.io';
  return { key: `${board}/${jobId}`, board, jobId, url: `https://${host}/${board}/jobs/${jobId}` };
}

function postedDate(job) {
  const raw = job.date_posted || job.first_seen;
  if (typeof raw !== 'string') return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const toRegexes = list => (list || []).map(s => new RegExp(s, 'i'));

export function selectCandidates(jobs, ledger, {
  now = new Date(), days = 7, retry = false,
  includeTitles = [], excludeTitles = [], excludeCompanies = [],
} = {}) {
  const inc = toRegexes(includeTitles), exc = toRegexes(excludeTitles), excCo = toRegexes(excludeCompanies);
  // Whole calendar days: on the 23rd, days=3 keeps anything posted on the 20th or later.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  const cutoff = start.getTime();
  const seen = new Set();
  const out = [];
  for (const job of jobs || []) {
    const target = greenhouseTarget(job?.url);
    if (!target || seen.has(target.key)) continue;
    seen.add(target.key);
    const title = String(job.title || ''), company = String(job.company || '');
    if (inc.length && !inc.some(r => r.test(title))) continue;
    if (exc.some(r => r.test(title)) || excCo.some(r => r.test(company))) continue;
    const posted = postedDate(job);
    if (!posted || posted.getTime() < cutoff) continue;
    const prev = ledger.jobs[target.key];
    if (prev && FINAL.has(prev.status)) continue;
    if (prev && NEEDS_YOU.has(prev.status) && !retry) continue;
    out.push({ ...target, title, company, location: job.location || '', posted: posted.toISOString(), prev: prev || null });
  }
  // Newest first; dry-run jobs (already judged a fit) ahead of unjudged ones.
  return out.sort((a, b) => (b.prev?.status === 'dry_run') - (a.prev?.status === 'dry_run') || b.posted.localeCompare(a.posted));
}
