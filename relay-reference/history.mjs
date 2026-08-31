/*
  recently-played tracks from OnlineRadioBox.

  ORB's playlist page sends no CORS header, so it can only be fetched
  server-side. Imported by worker.js and .serve.mjs, never by the browser.
*/

const PLAYLIST_URL = 'https://onlineradiobox.com/us/kure/playlist/';
const UA = 'kure-885-worker (+https://kure.salem.rip)';
const HISTORY_LIMIT = 7;

function unescapeHtml(v) {
  return v
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/*
  the playlist page is one <table class="tablelist-schedule"> of <tr> rows.
  a real track carries <a class="ajax">Artist - Title</a>; station-ident
  filler ("Light Pull", "Top of the Hour") is linkless text
  that link is the signal used to keep only tracks. regex over a known, narrow,
  server-rendered table rather than a full parser: no dependency, same
  trade-off onair.mjs makes hand-rolling ICS instead of pulling in RRULE.
*/
export function parsePlaylist(html) {
  const tableStart = html.indexOf('tablelist-schedule');
  if (tableStart < 0) return [];
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = tableEnd < 0 ? html.slice(tableStart) : html.slice(tableStart, tableEnd);

  const tracks = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(table)) && tracks.length < HISTORY_LIMIT) {
    const row = m[1];
    const timeMatch = row.match(/class="time--schedule"[^>]*>([^<]*)</);
    const trackMatch = row.match(/class="track_history_item"[^>]*>\s*<a[^>]*class="ajax"[^>]*>([^<]*)<\/a>/);
    if (!timeMatch || !trackMatch) continue;
    const time = unescapeHtml(timeMatch[1].trim());
    const raw = unescapeHtml(trackMatch[1].trim());
    const sep = raw.indexOf(' - ');
    if (sep < 0) continue;
    tracks.push({
      time,
      artist: raw.slice(0, sep).trim(),
      title: raw.slice(sep + 3).trim(),
    });
  }
  return tracks;
}


let cache = null; // { html, at }
const TTL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

let failCache = null; // { at } — short negative cache so a dead upstream
const FAIL_TTL_MS = 30 * 1000; // doesn't cost every poll a fresh slow attempt

// same cache/timeout/negative-cache shape as onair.mjs's getIcsText, and
// same reasons — see that module for why a plain in-module cache.
async function getPlaylistHtml() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.html;
  if (failCache && now - failCache.at < FAIL_TTL_MS) {
    if (cache) return cache.html; // stale-but-known-good beats failing
    throw new Error('playlist fetch failed recently, still cooling down');
  }
  try {
    const r = await fetch(PLAYLIST_URL, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error('playlist fetch failed: ' + r.status);
    const html = await r.text();
    cache = { html, at: now };
    failCache = null;
    return html;
  } catch (e) {
    failCache = { at: now };
    if (cache) return cache.html;
    throw e;
  }
}

export async function fetchTrackHistory() {
  try {
    const html = await getPlaylistHtml();
    return { tracks: parsePlaylist(html) };
  } catch (e) {
    console.error(e);
    return { tracks: [] };
  }
}
