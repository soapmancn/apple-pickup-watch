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
 *   Cron every minute → reads CHECK_INTERVAL_MINUTES, fetches Apple only
 *                         when the configured interval is due, then diffs
 *                         against previous state and broadcasts via Room.
 *
 * Cloudflare Cron has one-minute granularity. The environment variable can
 * select any whole-minute interval from 1 to 1440.
 */

import { Room } from './room.js';
import {
  DEFAULT_CHECK_INTERVAL_MINUTES,
  getMonitorConfig,
  isScheduledCheckDue,
} from './config.js';

const PICKUP_URL = 'https://www.apple.com.cn/shop/retail/pickup-message';

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
   * Cloudflare wakes this Worker every minute; the environment variable
   * controls which minute buckets perform a real Apple inventory request.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
};

async function runScheduled(event, env) {
  let config;
  try {
    config = getMonitorConfig(env);
  } catch (err) {
    await reportTickError(
      env,
      `Configuration error: ${String((err && err.message) || err)}`,
      DEFAULT_CHECK_INTERVAL_MINUTES * 60,
    );
    return;
  }

  if (!isScheduledCheckDue(event?.scheduledTime, config.intervalMinutes)) return;
  await runTick(env, config);
}

/**
 * Query every selected product in one Apple pickup-message request, then hand
 * the normalized observations and active variable values to the Room.
 */
async function runTick(env, config) {
  const id = env.ROOM.idFromName('singleton');
  const room = env.ROOM.get(id);
  const checkedAt = formatCst(new Date());

  try {
    const observations = await fetchPickupObservations(config);
    await room.fetch(new Request('https://room/tick', {
      method: 'POST',
      body: JSON.stringify({
        checked_at: checkedAt,
        observations,
        fail_count: 0,
        ok_count: observations.length,
        poll_seconds: config.pollSeconds,
        stores: config.stores,
        products: config.products,
        source_url: config.sourceUrl,
      }),
    }));
  } catch (err) {
    await room.fetch(new Request('https://room/tick', {
      method: 'POST',
      body: JSON.stringify({
        checked_at: checkedAt,
        observations: [],
        fail_count: config.stores.length,
        ok_count: 0,
        poll_seconds: config.pollSeconds,
        stores: config.stores,
        products: config.products,
        source_url: config.sourceUrl,
        error: String((err && err.message) || err).slice(0, 300),
      }),
    }));
  }
}

async function reportTickError(env, error, pollSeconds) {
  const id = env.ROOM.idFromName('singleton');
  const room = env.ROOM.get(id);
  await room.fetch(new Request('https://room/tick', {
    method: 'POST',
    body: JSON.stringify({
      checked_at: formatCst(new Date()),
      observations: [],
      fail_count: 1,
      ok_count: 0,
      poll_seconds: pollSeconds,
      error: String(error).slice(0, 300),
    }),
  }));
}

/**
 * Apple expects `pl=true`, `location`, and indexed `mts.N` / `parts.N`
 * query parameters. Its response contains nearby stores; select only the
 * stores configured in MONITOR_STORES_JSON and normalize availability.
 */
export async function fetchPickupObservations(config) {
  const params = new URLSearchParams({ pl: 'true', location: config.location });
  config.parts.forEach((part, index) => {
    params.set(`mts.${index}`, 'regular');
    params.set(`parts.${index}`, part);
  });

  const r = await fetch(`${PICKUP_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 AppleCNInventoryMonitor/Workers',
      'Accept': 'application/json,text/plain,*/*',
      'Referer': config.sourceUrl,
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
  const missingStores = config.storeNumbers.filter((store) => !byNumber.has(store));
  if (missingStores.length) {
    throw new Error(`Selected stores missing from Apple response: ${missingStores.join(', ')}`);
  }

  const configuredStores = new Map(
    config.stores.map((store) => [store.store_number, store]),
  );
  const observations = [];
  const missingPairs = [];
  for (const storeNumber of config.storeNumbers) {
    const store = byNumber.get(storeNumber);
    const configuredStore = configuredStores.get(storeNumber) || {};
    const availability = store.partsAvailability || {};
    for (const part of config.parts) {
      const item = availability[part];
      const display = item && item.pickupDisplay;
      if (!item || !['available', 'unavailable', 'ineligible'].includes(display)) {
        missingPairs.push(`${part}@${storeNumber}`);
        continue;
      }
      observations.push({
        part_number: part,
        store_number: storeNumber,
        store_name: String(store.storeName || configuredStore.store_name || storeNumber).trim(),
        city: store.city || configuredStore.city || '',
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