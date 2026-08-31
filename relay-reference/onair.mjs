/* i had to vibecode this im sorry
i spent like 6hrs trying to get this to work as intended
and failed horribly every time

pulls events from the studio a google cal, uses regex to try to
figure out which dj it is

ideally, this would work off of something better like an actual 
dj showlist schedule thing, but i just wanted it to work for testing

this will be removed in 
*/


/*
  onair.mjs — resolves "who's live on Studio A right now" from KURE's real
  booking calendar, so the listen page's on-air board reflects the actual
  schedule instead of a hand-typed table. See
  docs/superpowers/specs/2026-08-27-listen-live-schedule-design.md.

  Studio A is a public Google Calendar; its ICS feed has no CORS header, so
  it can only be read server-side. This module is imported by both
  worker.js (production) and .serve.mjs (local dev) — never by the browser.

  Recurrence is hand-rolled rather than pulled from an RRULE library: every
  event on this calendar is a plain FREQ=WEEKLY rule with an optional UNTIL
  and EXDATEs, which is little enough surface to parse directly and exactly
  what "on now / what's next" needs.
*/

const STUDIO_A_ICS =
  'https://calendar.google.com/calendar/ical/' +
  'kure885.org_gpcpmr99vq1jpqiac2i8cqhno0%40group.calendar.google.com' +
  '/public/basic.ics';

const UA = 'kure-885-worker (+https://kure.salem.rip)';
const DAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ── ICS parsing ── */

// RFC 5545 line folding: a continuation line starts with a space or tab.
function unfold(ics) {
  return ics.replace(/\r\n/g, '\n').split('\n').reduce((lines, line) => {
    if ((line[0] === ' ' || line[0] === '\t') && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length) {
      lines.push(line);
    }
    return lines;
  }, []);
}

function unescapeText(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/*
  "20181114T180000" (local wall clock — Studio A events are normally given
  in America/Chicago via a TZID=America/Chicago parameter, the same clock
  this module reasons in throughout) → { dateKey: '20181114', minutes: 1080 }

  Google's feed can also emit a UTC-form value with a trailing "Z"
  ("20250110T200000Z") — most often for non-recurring one-off bookings. In
  that case the digits are a UTC instant, not already-Chicago wall clock, so
  they're converted through a real Date and chicagoNow's same
  Intl.DateTimeFormat machinery to get the correct Chicago date/minutes
  (DST-aware).
*/
function parseDt(value) {
  const m = value.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    const instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
    return chicagoNow(instant);
  }
  return { dateKey: y + mo + d, minutes: (+h) * 60 + (+mi) };
}

function parseRRule(rrule) {
  const parts = {};
  rrule.split(';').forEach((kv) => {
    const [k, v] = kv.split('=');
    parts[k] = v;
  });
  return {
    freq: parts.FREQ || null,
    byday: parts.BYDAY ? parts.BYDAY.split(',') : null,
    until: parts.UNTIL || null,
  };
}

function parseIcs(text) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const key = raw.slice(0, i).split(';')[0];
    const value = raw.slice(i + 1);
    if (key === 'DTSTART') cur.dtstart = parseDt(value);
    else if (key === 'DTEND') cur.dtend = parseDt(value);
    else if (key === 'RRULE') cur.rrule = value;
    else if (key === 'EXDATE') {
      value.split(',').forEach((v) => {
        const p = parseDt(v);
        if (p) cur.exdates.push(p.dateKey);
      });
    }
    else if (key === 'SUMMARY') cur.summary = unescapeText(value);
    else if (key === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (key === 'STATUS') cur.status = value;
    else if (key === 'RECURRENCE-ID') cur.recurrenceId = parseDt(value);
  }

  // Drop cancelled bookings outright — they should never be "on" or "next".
  const live = events.filter((e) => e.dtstart && e.dtend && e.status !== 'CANCELLED');

  /*
    A RECURRENCE-ID override reschedules one occurrence of a recurring
    series: Google still emits the base series' VEVENT generating that
    original occurrence (it isn't an EXDATE), plus this separate VEVENT for
    the moved slot. Matched by SUMMARY (simplest reliable signal this parser
    has — UID matching would be more correct per spec but needs no extra
    precision here since Studio A's series titles are unique). Treat the
    override's date as an implicit EXDATE on the base series so the old slot
    stops matching; the override itself stands as a normal one-off event.
  */
  const overridesBySummary = new Map();
  live.forEach((e) => {
    if (e.recurrenceId) overridesBySummary.set(e.summary, e.recurrenceId.dateKey);
  });
  live.forEach((e) => {
    if (e.rrule && overridesBySummary.has(e.summary)) {
      const exDateKey = overridesBySummary.get(e.summary);
      if (e.exdates.indexOf(exDateKey) === -1) e.exdates.push(exDateKey);
    }
  });

  return live;
}

/* ── calendar math, done as plain date keys so it never has to touch a
   timezone conversion twice — see parseDt above */

function dateKeyWeekday(dateKey) {
  const y = +dateKey.slice(0, 4), mo = +dateKey.slice(4, 6), d = +dateKey.slice(6, 8);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function addDays(dateKey, n) {
  const y = +dateKey.slice(0, 4), mo = +dateKey.slice(4, 6), d = +dateKey.slice(6, 8);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return '' + dt.getUTCFullYear() + p(dt.getUTCMonth() + 1) + p(dt.getUTCDate());
}

/*
  Does this event have an occurrence on this calendar date? UNTIL is an
  absolute instant (e.g. "20230514T045959Z"); comparing its date portion
  against the candidate date is off by at most a few hours around the
  America/Chicago offset, which only matters within the same day a weekly
  series ends — an acceptable approximation for "still running this week."
*/
function occursOn(ev, dateKey) {
  if (dateKey < ev.dtstart.dateKey) return false;
  if (ev.exdates.indexOf(dateKey) !== -1) return false;
  if (!ev.rrule) return dateKey === ev.dtstart.dateKey;
  const r = parseRRule(ev.rrule);
  if (r.freq !== 'WEEKLY') return dateKey === ev.dtstart.dateKey;
  if (r.until && dateKey > r.until.slice(0, 8)) return false;
  const wd = dateKeyWeekday(dateKey);
  const byday = r.byday || [DAY_CODE[dateKeyWeekday(ev.dtstart.dateKey)]];
  return byday.indexOf(DAY_CODE[wd]) !== -1;
}

/*
  An event whose dtend clock time is not after its dtstart clock time (e.g.
  23:00–01:00) crosses midnight. It's "on" either the first evening (today's
  occurrence has started and hasn't hit 24:00 yet) or the following morning
  (yesterday's occurrence hasn't reached its end time yet).
*/
function isOvernight(ev) {
  return ev.dtend.minutes <= ev.dtstart.minutes;
}

function isOnAt(ev, now) {
  if (isOvernight(ev)) {
    if (occursOn(ev, now.dateKey) && now.minutes >= ev.dtstart.minutes) return true;
    const yesterday = addDays(now.dateKey, -1);
    if (occursOn(ev, yesterday) && now.minutes < ev.dtend.minutes) return true;
    return false;
  }
  return occursOn(ev, now.dateKey) && now.minutes >= ev.dtstart.minutes && now.minutes < ev.dtend.minutes;
}

function resolve(events, now) {
  let on = null;
  for (const ev of events) {
    if (isOnAt(ev, now)) {
      on = ev;
      break;
    }
  }

  /*
    Scan day by day, nearest first. Within a given day offset, any valid
    event's start is closer than any event on a later offset (a day is 1440
    minutes, always more than the largest possible minutes-of-day gap), so
    the first offset with a candidate holds the true nearest one.
  */
  let next = null;
  for (let offset = 0; offset <= 8 && !next; offset++) {
    const dateKey = addDays(now.dateKey, offset);
    let best = null;
    for (const ev of events) {
      if (!occursOn(ev, dateKey)) continue;
      if (offset === 0 && ev.dtstart.minutes <= now.minutes) continue;
      if (!best || ev.dtstart.minutes < best.dtstart.minutes) best = ev;
    }
    if (best) next = { ev: best, dateKey };
  }

  return { on, next };
}

/* ── output shaping ── */

function clock(mins) {
  const hh = Math.floor(mins / 60) % 24, mm = String(mins % 60).padStart(2, '0');
  return { h: ((hh % 12) || 12) + ':' + mm, mer: hh < 12 ? 'AM' : 'PM' };
}

/*
  Station descriptions name the DJ inline ("...curated by DJ JFitz.",
  "...with DJ PretzelBoi") rather than in a structured field. Best effort:
  prefer a "DJ <name>" phrase (kept whole, so the on-air card still reads
  "On air with DJ Salem"); fall back to "with <Name>" for the few hosts
  named without the "DJ" handle. No match → omit the field, don't guess.
*/
function djFrom(description) {
  if (!description) return null;
  const dj = description.match(/\bDJ\s+[A-Za-z0-9''.\- ]{2,30}?(?=[.,!\n]|$)/);
  if (dj) return dj[0].trim();
  const withName = description.match(/\bwith\s+([A-Z][A-Za-z0-9''.\- ]{1,29}?)(?=[.,!\n]|$)/);
  return withName ? withName[1].trim() : null;
}

export function chicagoNow(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach((x) => { p[x.type] = x.value; });
  const hour = p.hour === '24' ? 0 : +p.hour; // Intl emits "24" for midnight with hour12:false
  return { dateKey: p.year + p.month + p.day, minutes: hour * 60 + (+p.minute) };
}

export function statusFromIcs(icsText, now) {
  const events = parseIcs(icsText);
  const { on, next } = resolve(events, now);
  const out = { on: null, next: null };
  if (on) {
    const a = clock(on.dtstart.minutes), b = clock(on.dtend.minutes);
    out.on = {
      title: on.summary || 'Untitled show',
      day: DAY_LONG[dateKeyWeekday(now.dateKey)],
      startLabel: a.h + ' ' + a.mer,
      endLabel: b.h + ' ' + b.mer,
    };
    const dj = djFrom(on.description);
    if (dj) out.on.dj = dj;
  }
  if (next) {
    const a = clock(next.ev.dtstart.minutes);
    out.next = {
      title: next.ev.summary || 'Untitled show',
      day: DAY_LONG[dateKeyWeekday(next.dateKey)],
      startLabel: a.h + ' ' + a.mer,
    };
  }
  return out;
}

/* ── the one thing the Worker and dev server actually call ── */

let cache = null; // { text, at }
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

let failCache = null; // { at } — a short negative cache so a dead upstream
const FAIL_TTL_MS = 30 * 1000; // doesn't cost every poll a fresh slow attempt.

/*
  A plain in-module cache rather than the Cloudflare Cache API: it works
  identically in the Worker and in plain Node (.serve.mjs), and an isolate
  that's actively serving requests keeps this warm for exactly as long as
  it's worth having at all. A cold isolate just fetches again.
*/
async function getIcsText() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.text;
  if (failCache && now - failCache.at < FAIL_TTL_MS) {
    /*
      Upstream failed recently — don't hammer it again this soon. Prefer
      serving stale-but-known-good text over failing outright, if we have any.
    */
    if (cache) return cache.text;
    throw new Error('ics fetch failed recently, still cooling down');
  }
  try {
    const r = await fetch(STUDIO_A_ICS, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error('ics fetch failed: ' + r.status);
    const text = await r.text();
    cache = { text, at: now };
    failCache = null;
    return text;
  } catch (e) {
    failCache = { at: now };
    if (cache) return cache.text; // stale-but-known-good beats failing outright
    throw e;
  }
}

export async function fetchOnAirStatus(now) {
  try {
    const text = await getIcsText();
    return statusFromIcs(text, now || chicagoNow(new Date()));
  } catch (e) {
    console.error(e);
    return { on: null, next: null };
  }
}
