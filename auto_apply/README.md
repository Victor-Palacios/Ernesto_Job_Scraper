# Greenhouse auto-applier

Applies to the Greenhouse jobs this repo already scrapes, on a schedule, from
your own computer.

- **Model:** the local `claude` CLI (`claude -p --tools ""`) on your Claude
  Code login. No API key: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are
  removed from its environment so it can't fall back to API billing.
- **Network:** only the Greenhouse job page being applied to. No Gmail,
  Pushover, LLM APIs or other services.
- **Data:** your profile, ledger, answer logs and screenshots stay in
  `~/.job-autoapply/` (mode 700). Nothing is committed; this repo is public.

## How a run works

1. Reads `all_jobs.json`, keeps hosted Greenhouse jobs
   (`job-boards.greenhouse.io/<board>/jobs/<id>`) posted in the last
   `search.days`, minus your title/company exclusions and anything already
   handled.
2. Opens the job page and asks Claude for a 0–100 fit score from the job
   description and your `resume.md`/`candidate_profile.md`. Below
   `search.min_score` → `skipped_fit`. The score is cached per job.
3. Reads every form field. Standard fields (name, email, phone, country,
   location, resume, education, employment, EEO) and common questions (work
   authorization, sponsorship, 18+, LinkedIn, salary, city/state/zip, "have
   you worked here before") come from `profile.json`, no model involved.
4. The remaining **required** questions go to Claude in one call. Rules:
   answer only from your facts, return `null` instead of guessing, and dropdown
   answers must be one of the real options (checked in code). Low-confidence or
   missing answers stop that application as `needs_review`.
5. Fills the form, rescans for follow-up questions that appear, then checks
   that every required field holds a value. Writes `answers.json` (exactly what
   was entered and where each answer came from) and `filled.png`.
6. Without `--submit`, it stops there (`dry_run`). With `--submit`, it clicks
   Submit once and records `submitted`, `needs_human` (CAPTCHA or emailed
   security code) or `failed`.

## Setup

```bash
cd Ernesto_Job_Scraper
npm ci
npx playwright install chromium
claude            # log in once (subscription), then exit
mkdir -p ~/.job-autoapply && chmod 700 ~/.job-autoapply
cp auto_apply/profile.example.json ~/.job-autoapply/profile.json
```

Edit `~/.job-autoapply/profile.json`:

- `resume_path`: the PDF to upload.
- `answers`: your own `{ "match": "<regex on question label>", "answer": ... }`
  rules. They win over the built-ins. An answer may be a list of acceptable
  options in order of preference.
- `eeo`: `"decline"` picks the decline/don't-wish-to-answer option.
- `accept_acknowledgements`: whether Claude may tick "I have read the privacy
  notice"-style attestations for you.
- `generate_cover_letter_when_required`: when a board *requires* a cover
  letter and you gave no `cover_letter_path`, Claude writes a short one from
  your facts. It is uploaded as `.txt` and kept in the run folder.

Put `resume.md` (and ideally `candidate_profile.md`) in the repo root. Both
are gitignored. These are what Claude reads for fit scores and free-text
answers. `context_files` can point elsewhere.

## Use

```bash
node auto_apply/cli.mjs run                 # dry run: judge + fill + screenshot, never submits
node auto_apply/cli.mjs status              # what happened to each job
node auto_apply/cli.mjs apply <greenhouse job url>             # one job, dry run
node auto_apply/cli.mjs apply <url> --submit --headed --wait-for-human
node auto_apply/cli.mjs run --submit        # submit the ones that pass every check
```

Options: `--max N` (applications per run), `--days N`, `--min-score N`,
`--retry` (re-try `needs_review`/`needs_human`/`failed` jobs after you fix the
profile), `--skip-fit`, `--headed` (visible browser), `--wait-for-human` (with
`--headed`: if a CAPTCHA or security code appears, finish it in the window;
the run waits up to 10 minutes for the confirmation page).

Start with dry runs. Read `~/.job-autoapply/runs/<board>_<id>/answers.json`
and `filled.png` for a few jobs, add `answers` rules for anything it got
wrong or sent to review, and only then schedule `--submit`. Jobs left in
`dry_run` are picked up by the next `--submit` run without being judged again.

Limits (in `profile.json`): `max_per_run` (3), `max_per_day` (10 submissions,
local calendar day), `max_judge_per_run` (15 fit calls).

Kill switch: `touch ~/.job-autoapply/STOP` makes every run exit immediately.
Delete the file to resume.

## Schedule it

`auto_apply/run.sh` runs `git pull --ff-only` for fresh `all_jobs.json`, then
`cli.mjs run`, and appends everything to `~/.job-autoapply/run.log`. Arguments
pass through.

**macOS (launchd).** Use launchd rather than cron: it runs in your login
session, so `claude` can reach its keychain login and `--headed` works.
Save as `~/Library/LaunchAgents/com.jobscraper.autoapply.plist`, fix the
path, then run `launchctl load ~/Library/LaunchAgents/com.jobscraper.autoapply.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jobscraper.autoapply</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/Users/YOU/Ernesto_Job_Scraper/auto_apply/run.sh</string>
    <string>--submit</string><string>--headed</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>40</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>40</integer></dict>
  </array>
</dict></plist>
```

**Linux (cron)**, headless:

```cron
40 9,17 * * * /home/YOU/Ernesto_Job_Scraper/auto_apply/run.sh --submit
```

Leave out `--submit` while you are still checking dry runs.

## Not handled, on purpose

- **CAPTCHAs** are never bypassed. Greenhouse runs invisible reCAPTCHA; a
  visible browser from a home connection (`--headed`) is far less likely to be
  challenged than headless. A challenge marks the job `needs_human`.
- **Emailed security codes.** Reading your inbox would need a mail API, so a
  code prompt marks the job `needs_human`. With `--headed --wait-for-human`
  you can type it into the open window.
- **Company-site embeds** (`?gh_jid=` links) carry no board token and are
  skipped. So are Workday, Lever and Ashby.
- **Required uploads other than resume/cover letter** (transcripts, work
  samples) and search-as-you-type fields your profile doesn't cover go to
  `needs_review`.

## Your responsibility

Everything submitted is in your name. The tool only states what your profile
and resume say, and it stops rather than guesses. Still, review the dry runs,
keep the daily cap modest, and remember that some employers frown on
automated applications.

## Tests

`node --test test_auto_apply.mjs` (also part of `npm test`) covers job
selection, answer matching, the model-reply checks, the ledger and the
dry-run guard, offline. Browser behaviour was checked by dry-running real
Greenhouse forms. Those runs never click Submit.
