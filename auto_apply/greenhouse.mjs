// Browser side: reads and fills hosted Greenhouse application forms
// (job-boards.greenhouse.io). Field ids on the page match Greenhouse's schema
// names (first_name, question_123, resume, gender, ...); dropdowns are
// react-select comboboxes whose options live in `.select__menu`.
import { createRequire } from 'node:module';
import { chooseOption, norm } from './answers.mjs';

export async function loadChromium() {
  for (const name of ['@playwright/test', 'playwright']) {
    try { return (await import(name)).chromium; } catch { /* try next */ }
  }
  try { return createRequire(import.meta.url)('playwright').chromium; } catch { /* fallthrough */ }
  throw new Error('Playwright not found. From the repo root run: npm ci && npx playwright install chromium');
}

export async function launch({ headed = false, executablePath = process.env.AUTOAPPLY_CHROMIUM_PATH } = {}) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: !headed, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  context.setDefaultTimeout(10_000);
  return { browser, context };
}

export const byId = id => `[id="${String(id).replace(/["\\]/g, '\\$&')}"]`;

export async function openJob(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const form = await page.waitForSelector('#application-form', { timeout: 20_000 }).catch(() => null);
  if (!form) return { open: false, finalUrl: page.url() };
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const info = await page.evaluate(() => ({
    title: (document.querySelector('.job__title h1, h1')?.innerText || '').trim(),
    // <title> reads "Job Application for <role> at <company>"
    company: (/ at (.+)$/.exec(document.title.trim())?.[1] || '').trim(),
    jd: (document.querySelector('.job__description')?.innerText || '').trim(),
    recaptcha: !!document.querySelector('script[src*="recaptcha"], iframe[src*="recaptcha"]'),
  }));
  return { open: true, finalUrl: page.url(), ...info };
}

// Every answerable control in the form, with label, required flag and whether
// it already holds a value. Dropdown options are read separately (readOptions).
export async function scanFields(page) {
  return page.evaluate(() => {
    const form = document.querySelector('#application-form');
    if (!form) return [];
    const txt = el => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const bad = t => !t || /^attach$/i.test(t);
    const labelOf = el => {
      const byFor = el.id && form.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      let t = byFor && !byFor.classList.contains('visually-hidden') ? txt(byFor) : '';
      if (bad(t) && el.id) t = txt(document.getElementById(`${el.id}-label`));
      if (bad(t)) {
        let a = el.parentElement;
        for (let i = 0; i < 7 && a && a !== form; i++, a = a.parentElement) {
          const l = [...a.querySelectorAll('legend, .label, [id$="-label"], [class*="upload-label"], [class*="label"]')]
            .find(x => !x.classList.contains('visually-hidden') && !bad(txt(x)) && !x.contains(el));
          if (l) { t = txt(l); break; }
        }
      }
      if (bad(t)) t = el.getAttribute('aria-label') || el.id;
      return t;
    };
    const out = [], groups = new Set();
    for (const el of form.querySelectorAll('input, textarea, select')) {
      const id = el.id;
      if (!id || el.type === 'hidden' || el.type === 'submit' || id.startsWith('iti-') || /recaptcha/i.test(id + el.name)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue; // e.g. end date once "Current role" is ticked
      const rawLabel = labelOf(el);
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(rawLabel);
      const label = rawLabel.replace(/\s*\*\s*$/, '').trim();
      if (el.getAttribute('role') === 'combobox' && el.classList.contains('select__input')) {
        const shell = el.closest('.select__container') || el.closest('.select') || el.parentElement;
        const filled = !!shell?.querySelector('.select__single-value, .select__multi-value');
        out.push({ id, kind: id.endsWith('[]') ? 'multiselect' : 'select', widget: 'react', label, required, filled });
      } else if (el.type === 'file') {
        let wrap = el.parentElement;
        for (let i = 0; i < 4 && wrap?.parentElement && wrap.parentElement !== form; i++) wrap = wrap.parentElement;
        const filled = !!wrap?.querySelector('[class*="filename"], [class*="file-name"], button[aria-label*="emove"]');
        out.push({ id, kind: 'file', label, required, filled });
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        const name = el.name || id;
        if (groups.has(name)) continue;
        groups.add(name);
        const members = el.name ? [...form.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
        const optLabel = m => txt(form.querySelector(`label[for="${CSS.escape(m.id)}"]`)) || m.value;
        if (members.length === 1 && el.type === 'checkbox') {
          out.push({ id, kind: 'checkbox', label, required, filled: el.checked });
        } else {
          const legend = txt(el.closest('fieldset')?.querySelector('legend'));
          const gl = (legend || label).replace(/\s*\*\s*$/, '').trim();
          const greq = required || /\*\s*$/.test(legend) || members.some(m => m.required || m.getAttribute('aria-required') === 'true');
          out.push({
            id: name, kind: el.type === 'radio' ? 'select' : 'checkboxes', widget: el.type, label: gl, required: greq,
            filled: members.some(m => m.checked), options: members.map(optLabel), optionIds: members.map(m => m.id),
          });
        }
      } else if (el.tagName === 'SELECT') {
        out.push({ id, kind: el.multiple ? 'multiselect' : 'select', widget: 'native', label, required,
          filled: !!el.value, options: [...el.options].filter(o => o.value).map(o => o.text.trim()) });
      } else {
        out.push({ id, kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', label, required, filled: !!el.value.trim() });
      }
    }
    return out;
  });
}

const menuOptions = page => page.locator('.select__menu [role="option"]');

async function closeMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
}

// Options of a react-select. An empty list means it searches as you type.
export async function readOptions(page, id) {
  const input = page.locator(byId(id));
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await page.waitForTimeout(500);
  const texts = (await menuOptions(page).allInnerTexts()).map(t => t.trim()).filter(Boolean);
  await closeMenu(page);
  return texts.filter(t => !/^no options$/i.test(t));
}

export async function addOptions(page, fields) {
  for (const f of fields) {
    if (f.widget !== 'react' || f.filled || f.options) continue;
    f.options = await readOptions(page, f.id);
    if (!f.options.length) f.async = true;
  }
  return fields;
}

export class FillError extends Error {}

async function pickReact(page, action) {
  const input = page.locator(byId(action.id));
  const wants = action.kind === 'multiselect' ? action.value : [action.value[0]];
  action.picked = [];
  // `searches`: fallback terms, each typed on its own until one has a matching option.
  const terms = action.searches?.length ? action.searches : [action.search];
  for (const want of wants) {
    const opts = menuOptions(page);
    let texts = [], idx = -1;
    for (const term of terms) {
      await input.scrollIntoViewIfNeeded();
      await input.click();
      if (term) await input.pressSequentially(term, { delay: 35 });
      await opts.first().waitFor({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(term ? 1200 : 200);
      texts = (await opts.allInnerTexts()).map(t => t.trim());
      const target = term ? chooseOption(texts, action.searches ? term : action.value) : want;
      idx = target == null ? -1 : texts.findIndex(t => t === target || norm(t) === norm(target));
      if (idx >= 0) break;
      await closeMenu(page);
      await input.fill('').catch(() => {});
    }
    if (idx < 0) {
      throw new FillError(`${action.id}: no option matching ${JSON.stringify(action.search ? action.value : want)}`);
    }
    await opts.nth(idx).click();
    action.picked.push(texts[idx]);
    await page.waitForTimeout(150);
  }
  if (action.kind === 'multiselect') await closeMenu(page);
}

// Returns false when the field disappeared or was disabled by an earlier answer.
export async function fill(page, action, field) {
  const loc = page.locator(byId(field?.optionIds?.[0] ?? action.id));
  if (!(await loc.count()) || await loc.first().isDisabled().catch(() => true)) return false;
  await fillField(page, page.locator(byId(action.id)), action, field);
  return true;
}

async function fillField(page, loc, action, field) {
  switch (action.kind) {
    case 'text': case 'textarea':
      await loc.fill(action.value);
      return;
    case 'file':
      await loc.setInputFiles(action.value);
      await page.waitForTimeout(2000); // the board uploads the file as soon as it's attached
      return;
    case 'checkbox':
      await loc.check();
      return;
    case 'select': case 'multiselect': case 'checkboxes':
      if (field?.widget === 'native') {
        await loc.selectOption(action.value.map(label => ({ label })));
      } else if (field?.widget === 'radio' || field?.widget === 'checkbox') {
        for (const v of action.value) {
          const i = field.options.indexOf(v);
          if (i < 0) throw new FillError(`${action.id}: option ${v} vanished`);
          await page.locator(byId(field.optionIds[i])).check();
        }
      } else {
        await pickReact(page, action);
      }
      return;
    default:
      throw new FillError(`${action.id}: unsupported field kind ${action.kind}`);
  }
}

async function pageState(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const challenge = [...document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"], iframe[title*="challenge" i]')]
      .some(f => { const r = f.getBoundingClientRect(); return r.width > 50 && r.height > 50 && getComputedStyle(f).visibility !== 'hidden'; });
    return {
      url: location.href,
      thanks: /thank you for applying|thanks for applying|application (has been |was )?(submitted|received)|we('|’)ve received your application/i.test(body),
      code: /security code|verification code|enter the code/i.test(body),
      invalid: [...document.querySelectorAll('#application-form [aria-invalid="true"]')].map(e => e.id).slice(0, 10),
      errorText: [...document.querySelectorAll('.helper-text--error, [class*="error-message"], [role="alert"]')]
        .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 5),
      challenge,
    };
  });
}

// Clicks Submit and reports what the board did. Never retries a submit.
export async function submit(page, { timeoutMs = 60_000 } = {}) {
  const before = await pageState(page);
  await page.locator('#application-form button[type="submit"]').click();
  const start = Date.now();
  let last = before;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(1000);
    last = await pageState(page).catch(() => last);
    if (last.thanks || /\/confirmation/i.test(last.url)) return { outcome: 'submitted', url: last.url };
    if (last.code && !before.code) return { outcome: 'needs_code', url: last.url };
    if (last.challenge) return { outcome: 'captcha', url: last.url };
    if (Date.now() - start > 6000 && (last.invalid.length || last.errorText.length)) {
      return { outcome: 'invalid', url: last.url, detail: [...last.invalid, ...last.errorText].join('; ').slice(0, 400) };
    }
  }
  return { outcome: 'unknown', url: last.url, detail: 'No confirmation within timeout' };
}

// Headed runs only: leave the window open for you to type an emailed security
// code or solve a CAPTCHA, and watch for the confirmation page.
export async function waitForConfirmation(page, { minutes = 10 } = {}) {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    const s = await pageState(page).catch(() => null);
    if (!s) return false; // window closed
    if (s.thanks || /\/confirmation/i.test(s.url)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}
