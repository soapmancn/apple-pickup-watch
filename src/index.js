/**
 * Apple CN pickup inventory monitor — Cloudflare Worker entrypoint.
 *
 * Routes:
 *   GET  /              → static dashboard HTML (assets binding)
 *   GET  /api/state     → latest observation snapshot
 *   GET  /api/log       → last 100 tick events (newest first)
 *   GET  /api/stream    → SSE subscription for live change notifications
 *   POST /api/test-stock → admin hook: forge a fake "available" hit so you
 *                          can verify browser-side notifications without
 *                          waiting for a real Apple restock. Requires
 *                          header `X-Admin-Key: <ADMIN_KEY>` env var.
 *   Cron every 2 min  → fetches apple.com.cn pickup-message, diffs
 *                          against previous state, broadcasts to all SSE
 *                          subscribers via the Room DO.
 *
 * The cron schedule ALSO wakes the DO so newly-opened browser tabs get
 * fresh data immediately (avoids waiting up to 2 min on first load).
 */

import { Room } from './room.js';

const PICKUP_URL = 'https://www.apple.com.cn/shop/retail/pickup-message';
const SOURCE_URL = 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy74ch/a';
const LOCATION = '518000';
const PARTS = [
  'MJY84CH/A', 'MJY94CH/A', 'MJY74CH/A',
  'MJYD4CH/A', 'MJYE4CH/A', 'MJYC4CH/A',
];
const STORES = ['R761', 'R484', 'R793'];

const VARIANTS = [
  { part_number: 'MJY84CH/A', model: 'iPhone 18 Pro Max', color: '勃艮第酒红色', capacity: '256GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy84ch/a` },
  { part_number: 'MJY94CH/A', model: 'iPhone 18 Pro Max', color: '冰川蓝色',   capacity: '256GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy94ch/a` },
  { part_number: 'MJY74CH/A', model: 'iPhone 18 Pro Max', color: '银色',       capacity: '256GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy74ch/a` },
  { part_number: 'MJYD4CH/A', model: 'iPhone 18 Pro Max', color: '勃艮第酒红色', capacity: '512GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyd4ch/a` },
  { part_number: 'MJYE4CH/A', model: 'iPhone 18 Pro Max', color: '冰川蓝色',   capacity: '512GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjye4ch/a` },
  { part_number: 'MJYC4CH/A', model: 'iPhone 18 Pro Max', color: '银色',       capacity: '512GB', purchase_url: `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyc4ch/a` },
];

const STORE_INFO = {
  R761: { store_number: 'R761', store_name: '深圳万象城',       city: '深圳', state: '广东', distance: '6.6 km',   address: '深圳市罗湖区宝安南路 1881 号 深圳万象城（一期）B1 层' },
  R484: { store_number: 'R484', store_name: '深圳益田假日广场', city: '深圳', state: '广东', distance: '7.98 km',  address: '深圳市南山区深南大道 9028 号益田假日广场' },
  R793: { store_number: 'R793', store_name: '前海壹方城',       city: '深圳', state: '广东', distance: '17.13 km', address: '深圳市宝安区新湖路 99 号 前海壹方城 L1 层' },
};

export { Room };

export default {
  /**
   * One DO per environment; name "singleton" so all subscribers share state.
   * Multiple browser tabs all hit the same Room instance.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const id = env.ROOM.idFromName('singleton');
    const room = env.ROOM.get(id);

    if (url.pathname === '/api/state') {
      return room.fetch(new Request('https://room/state', { method: 'GET' }));
    }
    if (url.pathname === '/api/log') {
      return room.fetch(new Request('https://room/log', { method: 'GET' }));
    }
    if (url.pathname === '/api/stream') {
      // Pass through as SSE — the DO is the actual SSE endpoint.
      return room.fetch(new Request('https://room/stream', {
        method: 'GET',
        headers: request.headers,
      }));
    }
    if (url.pathname === '/api/test-stock' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      return room.fetch(new Request('https://room/test-stock', {
        method: 'POST',
        body: JSON.stringify(body),
      }));
    }
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }
    // Default: serve the dashboard HTML from assets.
    return env.ASSETS.fetch(request);
  },

  /**
   * Cron trigger — runs every 2 minutes.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};

/**
 * Query every selected part in one Apple pickup-message request, then hand
 * the normalized observations to the Room for state diff and SSE broadcast.
 */
async function runTick(env) {
  const id = env.ROOM.idFromName('singleton');
  const room = env.ROOM.get(id);
  const checkedAt = formatCst(new Date());

  try {
    const observations = await fetchPickupObservations();
    await room.fetch(new Request('https://room/tick', {
      method: 'POST',
      body: JSON.stringify({
        checked_at: checkedAt,
        observations,
        fail_count: 0,
        ok_count: observations.length,
      }),
    }));
  } catch (err) {
    await room.fetch(new Request('https://room/tick', {
      method: 'POST',
      body: JSON.stringify({
        checked_at: checkedAt,
        observations: [],
        fail_count: STORES.length,
        ok_count: 0,
        error: String((err && err.message) || err).slice(0, 300),
      }),
    }));
  }
}

/**
 * Apple expects `pl=true`, `location`, and indexed `mts.N` / `parts.N`
 * query parameters. Its response contains nearby stores; select only the
 * configured Shenzhen stores and normalize `partsAvailability`.
 */
async function fetchPickupObservations() {
  const params = new URLSearchParams({ pl: 'true', location: LOCATION });
  PARTS.forEach((part, index) => {
    params.set(`mts.${index}`, 'regular');
    params.set(`parts.${index}`, part);
  });

  const r = await fetch(`${PICKUP_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 AppleCNInventoryMonitor/Workers',
      'Accept': 'application/json,text/plain,*/*',
      'Referer': SOURCE_URL,
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`Apple pickup API returned HTTP ${r.status}`);

  const data = await r.json();
  const body = data && data.body;
  if (!body || !Array.isArray(body.stores)) {
    throw new Error('Apple pickup API returned an unexpected response shape');
  }
  if (body.errorMessage) throw new Error(stripMarkup(body.errorMessage));

  const byNumber = new Map(
    body.stores
      .filter((store) => store && store.storeNumber)
      .map((store) => [store.storeNumber, store]),
  );
  const missingStores = STORES.filter((store) => !byNumber.has(store));
  if (missingStores.length) {
    throw new Error(`Selected stores missing from Apple response: ${missingStores.join(', ')}`);
  }

  const observations = [];
  const missingPairs = [];
  for (const storeNumber of STORES) {
    const store = byNumber.get(storeNumber);
    const availability = store.partsAvailability || {};
    for (const part of PARTS) {
      const item = availability[part];
      const display = item && item.pickupDisplay;
      if (!item || !['available', 'unavailable', 'ineligible'].includes(display)) {
        missingPairs.push(`${part}@${storeNumber}`);
        continue;
      }
      observations.push({
        part_number: part,
        store_number: storeNumber,
        store_name: String(store.storeName || STORE_INFO[storeNumber].store_name).trim(),
        city: store.city || '深圳',
        pickup_display: display,
        pickup_quote: stripMarkup(item.pickupSearchQuote || ''),
        pickup_quote_value: item.pickupSearchQuoteValue ?? null,
      });
    }
  }
  if (missingPairs.length) {
    throw new Error(`Incomplete Apple availability response: ${missingPairs.slice(0, 8).join(', ')}`);
  }
  return observations;
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCst(d) {
  // Manual Asia/Shanghai formatter (no Intl on Workers free plan runtime).
  // d is a Date; we want 'YYYY-MM-DD HH:MM:SS CST'.
  const utc = d.getTime() + d.getTimezoneOffset() * 60_000;
  const cstMs = utc + 8 * 3600_000;
  const cst = new Date(cstMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ` +
    `${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())} CST`
  );
}