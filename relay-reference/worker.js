/*
  kure broadcasts from an icecast server that only speaks http:
    http://kure-network.stuorg.iastate.edu:8000
  https cant reach that, so this worker relays it: /stream/<mount> and
  /stream/status.json get fetched from icecast serverside and handed back on
  our cert. the page asks for them as same-origin relative urls, so theres no
  mixed content, no cors, and the audio isnt cross-origin tainted, which is
  what lets the listen page's level meter read the stream. see DESIGN.md.

  everything else falls through to the assets binding untouched.

  also answers salem.rip/kure/* via a
  second route in wrangler.jsonc. the /kure prefix is stripped before any
  branch runs, and the site's links are all relative, so either host works.

*/

import { fetchOnAirStatus } from './onair.mjs';
import { fetchTrackHistory } from './history.mjs';

const KURE_PREFIX = '/kure';

const UPSTREAM = 'http://kure-network.stuorg.iastate.edu:8000';

/*
  only the three mounts that server publishes, to prevent an open proxy
*/
const MOUNTS = new Set(['KUREBroadcast', 'KUREBroadcastMQ', 'KUREBroadcastLQ']);

const UA = 'kure-885-worker (+https://kure.salem.rip)';
const JSON_TYPE = 'application/json; charset=UTF-8';

// metadata and audio are both GET only; returns a 405 response, or null to go on.
function requireGet(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
}

function relay(body, type, status, noStore) {
  const headers = {
    'content-type': type,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  };
  if (noStore) headers['cache-control'] = 'no-store';
  return new Response(body, { status: status || 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
      bundle salem.rip/kure/ and kure.salem.rip/
    */
    if (url.pathname === KURE_PREFIX) {
      return Response.redirect(new URL(KURE_PREFIX + '/', request.url).toString(), 302);
    }
    const prefixed = url.pathname.startsWith(KURE_PREFIX + '/');
    const path = prefixed ? url.pathname.slice(KURE_PREFIX.length) : url.pathname;

    // on-air status and track history, computed here from the same feeds
    if (path === '/onair/status.json' || path === '/onair/history.json') {
      const notAllowed = requireGet(request);
      if (notAllowed) return notAllowed;
      const data =
        path === '/onair/status.json' ? await fetchOnAirStatus() : await fetchTrackHistory();
      return relay(JSON.stringify(data), JSON_TYPE, 200, true);
    }

    if (!path.startsWith('/stream/')) {
      if (!prefixed) return env.ASSETS.fetch(request);
      const assetUrl = new URL(request.url);
      assetUrl.pathname = path;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    const notAllowed = requireGet(request);
    if (notAllowed) return notAllowed;

    const name = path.slice('/stream/'.length);

    // current track and listener counts frm icecast
    if (name === 'status.json') {
      try {
        const r = await fetch(UPSTREAM + '/status-json.xsl', {
          headers: { 'user-agent': UA },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (!r.ok) return relay('{}', JSON_TYPE, 502, true);
        return relay(await r.text(), JSON_TYPE, 200, true);
      } catch {
        return relay('{}', JSON_TYPE, 502, true);
      }
    }

    if (!MOUNTS.has(name)) return new Response('No such mount', { status: 404 });

    try {
      const r = await fetch(UPSTREAM + '/' + name, {
        headers: {
          'user-agent': UA,
          /*
            no icy tags spliced into the audio: no browser parses them, and
            the page gets the track name from status.json instead
          */
          'icy-metadata': '0',
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!r.ok || !r.body) return new Response('Stream unavailable', { status: 502 });
      /*
        streamed straight through (never buffered)
      */
      return relay(r.body, r.headers.get('content-type') || 'audio/mpeg');
    } catch {
      return new Response('Stream unreachable', { status: 502 });
    }
  },
};
