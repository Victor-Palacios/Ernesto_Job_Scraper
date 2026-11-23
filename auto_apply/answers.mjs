// Maps Greenhouse form fields to answers from your profile. Pure functions:
// no browser, no model. Anything this can't answer deterministically is handed
// to Claude (claude.mjs) or, failing that, stops the application for review.

export const DECLINE = Symbol('decline');
const SKIP = Symbol('skip');
const DECLINE_RE = /decline|don.?t wish|do not wish|prefer not|choose not|not to (say|disclose|answer|self)|rather not|not wish to/i;

export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s*\+\d[\d\s-]*$/, '')      // "United States +1" -> "united states"
    .replace(/[^a-z0-9'+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Best option for a desired answer (or ordered list of acceptable answers).
// Word-boundary matching so "No" never picks "None of the above".
export function chooseOption(options, desired) {
  if (!Array.isArray(options) || !options.length || desired == null) return null;
  const opts = options.map(o => ({ raw: o, n: norm(o) }));
  const shortest = list => list.sort((a, b) => a.n.length - b.n.length)[0]?.raw ?? null;
  for (const want of [].concat(desired)) {
    if (want === DECLINE || (typeof want === 'string' && norm(want) === 'decline')) {
      const hit = opts.find(o => DECLINE_RE.test(o.raw));
      if (hit) return hit.raw;
      continue;
    }
    const d = norm(want);
    if (!d) continue;
    const exact = opts.find(o => o.n === d);
    if (exact) return exact.raw;
    const prefix = shortest(opts.filter(o => o.n.startsWith(d + ' ')));
    if (prefix) return prefix;
    if (d.length >= 3) {
      const inside = shortest(opts.filter(o => (' ' + o.n + ' ').includes(' ' + d + ' ')));
      if (inside) return inside;
    }
  }
  return null;
}

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
// Full name for text boxes; [name, code] for dropdowns that list "CA" instead of "California".
const stateAnswer = (state, kind) => {
  if (!state) return undefined;
  const code = STATES[norm(state)];
  return kind === 'text' || kind === 'textarea' || !code ? state : [state, code];
};

const yesNo = b => (b === true ? 'Yes' : b === false ? 'No' : undefined);
const eeo = v => (v == null || norm(v) === 'decline' ? DECLINE : v);
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const month = v => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return months[n - 1].replace(/^./, c => c.toUpperCase());
  return String(v);
};

// Greenhouse's fixed field ids (same on every hosted board).
export function standardAnswer(field, p) {
  const id = field.id, edu = p.education || {}, emp = p.employment || {}, loc = p.location || {};
  const fixed = {
    first_name: p.first_name, last_name: p.last_name, preferred_name: p.preferred_name,
    email: p.email, phone: p.phone, country: p.country || 'United States',
    'candidate-location': loc.search || loc.city,
    resume: p.resume_path, cover_letter: p.cover_letter_path,
    'school--0': edu.school, 'degree--0': edu.degree, 'discipline--0': edu.discipline,
    'start-month--0': month(edu.start_month), 'start-year--0': edu.start_year,
    'end-month--0': month(edu.end_month), 'end-year--0': edu.end_year,
    'company-name-0': emp.company, 'title-0': emp.title,
    'start-date-month-0': month(emp.start_month), 'start-date-year-0': emp.start_year,
    // A current role has no end date; the board disables these once "Current role" is ticked.
    'end-date-month-0': emp.current ? SKIP : month(emp.end_month),
    'end-date-year-0': emp.current ? SKIP : emp.end_year,
    'current-role-0_1': emp.current ? true : undefined,
    gender: eeo(p.eeo?.gender), hispanic_ethnicity: eeo(p.eeo?.hispanic), race: eeo(p.eeo?.race),
    veteran_status: eeo(p.eeo?.veteran), disability_status: eeo(p.eeo?.disability),
  };
  if (!(id in fixed)) return undefined;
  const value = fixed[id];
  if (value === SKIP) return { skip: true };
  if (value === undefined || value === null || value === '') return null; // known field, no data
  if (id === 'candidate-location') {
    // Most specific first: a bare "San Francisco" also matches "San Francisco, Cebu, Philippines".
    const country = p.country || 'United States';
    const prefs = [loc.display, loc.city && loc.state && `${loc.city}, ${loc.state}, ${country}`,
      loc.city && loc.state && `${loc.city}, ${loc.state}`, loc.city && `${loc.city}, ${country}`].filter(Boolean);
    return { value: prefs.length ? prefs : [value], search: value };
  }
  if (id === 'school--0' || id === 'discipline--0') return { value, search: value };
  return { value };
}

const firstWord = s => norm(s).split(' ').find(w => w.length >= 3) || '';

// Common custom questions, matched on label text.
export function labelAnswer(field, p, job = {}) {
  const l = norm(field.label);
  const wa = p.work_authorization || {}, loc = p.location || {}, emp = p.employment || {};
  const select = field.kind === 'select' || field.kind === 'multiselect' || field.kind === 'checkboxes';
  for (const rule of p.answers || []) {
    try {
      if (new RegExp(rule.match, 'i').test(field.label || '')) return { value: rule.answer, source: 'profile.answers' };
    } catch { /* bad user regex: ignore */ }
  }
  const rules = [
    [/linkedin/, () => p.links?.linkedin],
    [/github/, () => p.links?.github],
    [/portfolio|personal (web ?)?site|^website|website url/, () => p.links?.website],
    [/(authori[sz]ed|eligible|legally able) to work.*without.*sponsor/, () => yesNo(wa.authorized_us === true && wa.needs_sponsorship === false ? true : wa.authorized_us === false || wa.needs_sponsorship === true ? false : undefined)],
    [/(require|need).{0,60}sponsor|sponsor.{0,40}(require|need)/, () => yesNo(wa.needs_sponsorship)],
    [/(authori[sz]ed|eligible|legally able) to work/, () => yesNo(wa.authorized_us)],
    [/18 years|18 or older|at least 18|over 18|age of 18/, () => yesNo(p.over_18)],
    [/how did you (hear|find|learn)|where did you (hear|find|learn)|referral source/, () => p.how_did_you_hear],
    [/salary|compensation expect|pay expect|desired (pay|compensation)/, () => p.salary_expectation],
    [/(current|most recent|present).{0,20}(employer|company)/, () => emp.company],
    [/(current|most recent|present).{0,20}(job )?title/, () => emp.title],
    [/pronoun/, () => p.pronouns],
    [/postal|zip code|^zip/, () => loc.postal_code],
    [/street address|home address|residen(ce|tial) address|mailing address|permanent address/, () => loc.address],
    [/what city|city do you|current city|^city/, () => loc.city],
    [/what state|state do you|state of residence|^state/, () => stateAnswer(loc.state, field.kind)],
  ];
  if (select) rules.push(
    [/veteran/, () => eeo(p.eeo?.veteran)],
    [/disabilit/, () => eeo(p.eeo?.disability)],
    [/hispanic|latin[oax]/, () => eeo(p.eeo?.hispanic)],
    [/sexual orientation/, () => eeo(p.eeo?.sexual_orientation)],
    [/transgender/, () => eeo(p.eeo?.transgender)],
    [/\brace\b|ethnicity/, () => eeo(p.eeo?.race)],
    [/\bgender\b|\bsex\b/, () => eeo(p.eeo?.gender)],
  );
  for (const [re, get] of rules) {
    if (!re.test(l)) continue;
    const value = get();
    return value === undefined || value === null || value === '' ? null : { value, source: 'builtin' };
  }
  // "Have you previously worked at <this company>?"
  const co = firstWord(job.company);
  if (/(previously|ever|formerly|before|prior)/.test(l) && /(work|employ)/.test(l) &&
      ((co && l.includes(co)) || /this company|for us|with us/.test(l))) {
    const former = (p.former_employers || []).some(f => firstWord(f) === co);
    return { value: former ? 'Yes' : 'No', source: 'former_employers' };
  }
  return undefined;
}

// Turns scanned fields into fill actions plus the list Claude must answer.
export function buildPlan(fields, profile, job = {}) {
  const actions = [], unresolved = [], skipped = [];
  for (const f of fields) {
    if (f.filled) continue;
    const ans = standardAnswer(f, profile) ?? labelAnswer(f, profile, job);
    if (ans?.skip) { skipped.push(f.id); continue; }
    const action = ans ? resolve(f, ans) : null;
    if (action) actions.push(action);
    else if (f.required) unresolved.push(f);
    else skipped.push(f.id);
  }
  return { actions, unresolved, skipped };
}

export function resolve(f, { value, search, source = 'profile' }) {
  switch (f.kind) {
    case 'text': case 'textarea':
      return typeof value === 'string' || typeof value === 'number'
        ? { id: f.id, kind: f.kind, value: String(value), source } : null;
    case 'file':
      return typeof value === 'string' && value ? { id: f.id, kind: 'file', value, source } : null;
    case 'checkbox':
      return value === true ? { id: f.id, kind: 'checkbox', value: true, source } : null;
    case 'select':
      // Search-as-you-type dropdowns (school, location) only list matches after typing.
      if (f.async || (search != null && f.widget === 'react')) return { id: f.id, kind: 'select', value: [].concat(value), search: String(search ?? [].concat(value)[0]), source };
      {
        const opt = chooseOption(f.options, value);
        return opt ? { id: f.id, kind: 'select', value: [opt], source } : null;
      }
    case 'multiselect': case 'checkboxes': {
      const picked = [...new Set([].concat(value).map(v => chooseOption(f.options, v)).filter(Boolean))];
      return picked.length ? { id: f.id, kind: f.kind, value: picked, source } : null;
    }
    default:
      return null;
  }
}
