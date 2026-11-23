#!/usr/bin/env node
// Greenhouse auto-applier. Runs on your own machine; the only model is the
// local `claude` CLI (your Claude Code login, no tools, no API key).
//
//   node auto_apply/cli.mjs run                 # dry run: judge, fill, screenshot, never submit
//   node auto_apply/cli.mjs run --submit        # same, then click Submit when everything checks out
//   node auto_apply/cli.mjs apply <url> [--submit] [--skip-fit]
//   node auto_apply/cli.mjs status
//
// See auto_apply/README.md for setup and scheduling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stateDir, ensureDir, loadLedger, saveLedger, record, submittedOnDay, acquireLock, writePrivate } from './ledger.mjs';
import { greenhouseTarget, selectCandidates } from './select.mjs';
import { buildPlan, resolve } from './answers.mjs';
import { runClaude, extractJson, fitPrompt, parseFit, answersPrompt, validateAnswers } from './claude.mjs';
import { launch, openJob, scanFields, addOptions, fill, submit, waitForConfirmation, FillError } from './greenhouse.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const expandHome = p => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export function loadProfile(file) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(`Can't read profile ${file} (${err.code || err.message}). Copy auto_apply/profile.example.json there and fill it in.`);
  }
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'resume_path']) {
    if (!p[k]) throw new Error(`profile.${k} is required`);
  }
  p.resume_path = path.resolve(expandHome(p.resume_path));
  if (!fs.existsSync(p.resume_path)) throw new Error(`Resume not found: ${p.resume_path}`);
  if (p.cover_letter_path) p.cover_letter_path = path.resolve(expandHome(p.cover_letter_path));
  return p;
}

// What Claude sees: profile facts minus file paths and EEO choices, plus your
// gitignored candidate_profile.md / resume.md if present.
export function modelContext(profile, repo = REPO) {
  const { resume_path, cover_letter_path, eeo, limits, search, answers, context_files, ...facts } = profile;
  const documents = [];
  for (const rel of context_files || ['candidate_profile.md', 'resume.md']) {
    const file = path.resolve(repo, expandHome(rel));
    try { documents.push({ name: path.basename(file), text: fs.readFileSync(file, 'utf8').slice(0, 40_000) }); } catch { /* optional */ }
  }
  if (!documents.length) throw new Error('No candidate documents: add resume.md (and ideally candidate_profile.md) to the repo root or list files in profile.context_files');
  return { facts, documents };
}

function jobDir(dir, key) {
  return ensureDir(path.join(dir, 'runs', key.replace(/[^\w-]+/g, '_')));
}

async function shot(page, file) {
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

// One job, start to finish. Returns the ledger status it ended in.
export async function processJob({ page, job, profile, ctx, ledger, dir, opts, claude = runClaude }) {
  const key = job.key, out = jobDir(dir, key);
  const save = patch => { record(ledger, key, { url: job.url, company: job.company, title: job.title, ...patch }); saveLedger(dir, ledger); };

  const info = await openJob(page, job.url);
  if (!info.open) { save({ status: 'closed', detail: `no application form at ${info.finalUrl}` }); return 'closed'; }
  job.title ||= info.title;
  if (info.company && (!job.company || job.company === job.board)) job.company = info.company;

  // 1. Fit gate (cached per job so re-runs don't spend another model call).
  let fit = ledger.jobs[key]?.fit;
  if (!fit && !opts.skipFit) {
    fit = parseFit(extractJson(claude(fitPrompt(ctx, job, info.jd))));
    save({ fit });
  }
  if (fit) log(`  fit ${fit.score}: ${fit.reason}`);
  if (fit && fit.score < opts.minScore) { save({ status: 'skipped_fit', detail: `score ${fit.score} < ${opts.minScore}` }); return 'skipped_fit'; }

  // 2. Plan answers: profile first, then one Claude call for the rest.
  const filledLog = [], problems = [], warnings = [], seen = new Set();
  let coverLetterFile = null;
  for (let pass = 0; pass < 3; pass++) {
    // Later passes only look at fields that appeared after earlier answers.
    const fields = await addOptions(page, (await scanFields(page)).filter(f => !seen.has(f.id)));
    fields.forEach(f => seen.add(f.id));
    const plan = buildPlan(fields, profile, job);
    let { actions } = plan;
    const askable = plan.unresolved.filter(f => f.kind !== 'file' && !f.async);
    for (const f of plan.unresolved) {
      if (f.kind === 'file' && /cover/i.test(f.id + f.label) && profile.generate_cover_letter_when_required) continue;
      if (f.kind === 'file' || f.async) problems.push(`${f.label}: needs a ${f.kind === 'file' ? 'file' : 'search value'} in your profile`);
    }
    const needCover = !coverLetterFile && plan.unresolved.some(f => f.kind === 'file' && /cover/i.test(f.id + f.label)) && profile.generate_cover_letter_when_required;
    if (askable.length || needCover) {
      const v = validateAnswers(extractJson(claude(answersPrompt(ctx, job, info.jd, askable, { coverLetter: needCover }))), askable);
      problems.push(...v.problems);
      for (const f of askable) if (f.id in v.answers) actions.push(resolve(f, { value: v.answers[f.id], source: 'claude' }));
      if (needCover && v.coverLetter) {
        coverLetterFile = path.join(out, 'cover_letter.txt');
        writePrivate(coverLetterFile, v.coverLetter + '\n');
        const f = plan.unresolved.find(x => x.kind === 'file' && /cover/i.test(x.id + x.label));
        actions.push({ id: f.id, kind: 'file', value: coverLetterFile, source: 'claude' });
      } else if (needCover) problems.push('Cover letter: required but none generated');
    }
    actions = actions.filter(Boolean);
    if (!actions.length) break;
    const byId = new Map(fields.map(f => [f.id, f]));
    for (const a of actions) {
      try {
        if (!(await fill(page, a, byId.get(a.id)))) continue; // field went away; the final check catches it if it mattered
        filledLog.push({ id: a.id, label: byId.get(a.id)?.label, value: a.kind === 'file' ? path.basename(a.value) : (a.picked ?? a.value), source: a.source });
      } catch (err) {
        // Optional fields are best effort; a required one that failed shows up as "still empty" below.
        const msg = err instanceof FillError ? err.message : `${a.id}: ${err.message.split('\n')[0]}`;
        (byId.get(a.id)?.required ? problems : warnings).push(msg);
      }
    }
    // Answers can reveal follow-up questions (e.g. "Please specify"), so rescan.
  }

  // 3. Every required field must hold a value before Submit is allowed.
  const uploaded = new Set(filledLog.filter(x => /\.(pdf|docx?|txt|rtf)$/i.test(String(x.value))).map(x => x.id));
  const missing = (await scanFields(page)).filter(f => f.required && !f.filled && !uploaded.has(f.id));
  for (const f of missing) problems.push(`${f.label}: still empty`);
  const uniqueProblems = [...new Set(problems)];
  writePrivate(path.join(out, 'answers.json'), JSON.stringify({ url: job.url, at: new Date().toISOString(), fit, filled: filledLog, problems: uniqueProblems, warnings }, null, 2) + '\n');
  await shot(page, path.join(out, 'filled.png'));

  if (warnings.length) log(`  skipped optional: ${warnings.join(' | ')}`);
  if (uniqueProblems.length) {
    log(`  needs review: ${uniqueProblems.join(' | ')}`);
    save({ status: 'needs_review', detail: uniqueProblems.join(' | ').slice(0, 500) });
    return 'needs_review';
  }
  if (!opts.submit) { save({ status: 'dry_run', detail: `filled ${filledLog.length} fields` }); return 'dry_run'; }

  // 4. Submit.
  const res = await submit(page);
  await shot(page, path.join(out, 'after_submit.png'));
  if (res.outcome === 'submitted') { save({ status: 'submitted', detail: res.url }); return 'submitted'; }
  if ((res.outcome === 'needs_code' || res.outcome === 'captcha') && opts.headed && opts.waitForHuman) {
    log(`  ${res.outcome === 'needs_code' ? 'Greenhouse emailed you a security code' : 'CAPTCHA shown'}: finish it in the browser window (waiting up to 10 min)`);
    if (await waitForConfirmation(page)) { await shot(page, path.join(out, 'after_submit.png')); save({ status: 'submitted', detail: 'completed by you in the browser' }); return 'submitted'; }
  }
  const status = res.outcome === 'invalid' || res.outcome === 'unknown' ? 'failed' : 'needs_human';
  save({ status, detail: `${res.outcome}${res.detail ? ': ' + res.detail : ''}` });
  return status;
}

function printStatus(ledger) {
  const rows = Object.entries(ledger.jobs).sort((a, b) => String(b[1].updated_at).localeCompare(String(a[1].updated_at)));
  const counts = {};
  for (const [, j] of rows) counts[j.status || 'judged'] = (counts[j.status || 'judged'] || 0) + 1;
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ') || 'No jobs yet.');
  for (const [key, j] of rows.slice(0, 25)) {
    console.log(`${String(j.updated_at).slice(0, 16)}  ${(j.status || '-').padEnd(12)} ${(j.fit ? String(j.fit.score) : '--').padStart(3)}  ${j.company} | ${j.title}  (${key})${j.detail ? `\n${' '.repeat(36)}${j.detail}` : ''}`);
  }
}

async function main(argv) {
  const { values: a, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      submit: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      'wait-for-human': { type: 'boolean', default: false },
      retry: { type: 'boolean', default: false },
      'skip-fit': { type: 'boolean', default: false },
      max: { type: 'string' }, days: { type: 'string' }, 'min-score': { type: 'string' },
      profile: { type: 'string' }, jobs: { type: 'string', default: path.join(REPO, 'all_jobs.json') },
    },
  });
  const [cmd = 'run', urlArg] = positionals;
  const dir = ensureDir(stateDir());
  const ledger = loadLedger(dir);
  if (cmd === 'status') { printStatus(ledger); return 0; }
  if (cmd !== 'run' && cmd !== 'apply') { console.error(`Unknown command ${cmd}`); return 2; }
  if (fs.existsSync(path.join(dir, 'STOP'))) { log(`STOP file present in ${dir}; doing nothing.`); return 0; }

  const profile = loadProfile(a.profile || path.join(dir, 'profile.json'));
  const ctx = modelContext(profile);
  const limits = { max_per_run: 3, max_per_day: 10, max_judge_per_run: 15, ...(profile.limits || {}) };
  const search = { days: 7, min_score: 80, ...(profile.search || {}) };
  const opts = {
    submit: a.submit, headed: a.headed, waitForHuman: a['wait-for-human'], skipFit: a['skip-fit'],
    minScore: Number(a['min-score'] ?? search.min_score),
  };
  const maxRun = Number(a.max ?? limits.max_per_run);

  let jobs;
  if (cmd === 'apply') {
    const t = greenhouseTarget(urlArg);
    if (!t) { console.error('apply needs a job-boards.greenhouse.io/<board>/jobs/<id> URL'); return 2; }
    jobs = [{ ...t, title: '', company: t.board }];
  } else {
    const feed = JSON.parse(fs.readFileSync(a.jobs, 'utf8'));
    jobs = selectCandidates(feed.jobs || feed, ledger, {
      days: Number(a.days ?? search.days), retry: a.retry,
      includeTitles: search.include_titles, excludeTitles: search.exclude_titles, excludeCompanies: search.exclude_companies,
    });
  }
  log(`${jobs.length} candidate Greenhouse job(s); ${a.submit ? 'SUBMIT mode' : 'dry run (no submit)'}; state in ${dir}`);

  const release = acquireLock(dir);
  if (!release) { log('Another run holds the lock; exiting.'); return 0; }
  const { browser, context } = await launch({ headed: a.headed });
  const tally = {};
  let judged = 0, applied = 0;
  try {
    for (const job of jobs) {
      if (applied >= maxRun) break;
      if (a.submit && submittedOnDay(ledger) >= limits.max_per_day) { log(`Daily cap of ${limits.max_per_day} reached.`); break; }
      if (!ledger.jobs[job.key]?.fit && !opts.skipFit && judged >= limits.max_judge_per_run) { log('Judge budget for this run used up.'); break; }
      if (!ledger.jobs[job.key]?.fit && !opts.skipFit) judged++;
      log(`${job.company} | ${job.title || job.url}`);
      const page = await context.newPage();
      let status;
      try {
        status = await processJob({ page, job, profile, ctx, ledger, dir, opts });
      } catch (err) {
        status = 'failed';
        log(`  error: ${err.message.split('\n')[0]}`);
        record(ledger, job.key, { url: job.url, company: job.company, title: job.title, status, detail: err.message.split('\n')[0].slice(0, 300) });
        saveLedger(dir, ledger);
      } finally {
        if (!(opts.headed && status === 'needs_human')) await page.close().catch(() => {});
      }
      log(`  -> ${status}`);
      tally[status] = (tally[status] || 0) + 1;
      if (['dry_run', 'submitted', 'needs_review', 'needs_human', 'failed'].includes(status)) applied++;
    }
  } finally {
    await browser.close().catch(() => {});
    release();
  }
  log('Done:', JSON.stringify(tally));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
