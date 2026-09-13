/**
 * Apple CN pickup inventory monitor — Cloudflare Worker entrypoint.
 *
 * The singleton Room Durable Object owns the recurring second-level alarm,
 * inventory state, log buffer, and browser SSE subscribers. Cloudflare Cron
 * runs once per minute only as a watchdog that restores a missing alarm.
 */

import { Room } from './room.js';
export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = getRoom(env);

    if (url.pathname === '/api/state') {
      // Opening the dashboard bootstraps monitoring immediately after deploy.
      await ensureAlarm(room);
      return room.fetch(new Request('https://room/state', { method: 'GET' }));
    }
    if (url.pathname === '/api/log') {
      return room.fetch(new Request('https://room/log', { method: 'GET' }));
    }
    if (url.pathname === '/api/similar') {
      return room.fetch(new Request('https://room/similar', { method: 'GET' }));
    }
    if (url.pathname === '/api/catalog') {
      return room.fetch(new Request('https://room/catalog', {
        method: request.method,
        body: request.method === 'POST' ? await request.text() : undefined,
        headers: request.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      }));
    }
    if (url.pathname === '/api/search/products' && request.method === 'GET') {
      return room.fetch(new Request('https://room/search/products' + (url.search || ''), { method: 'GET' }));
    }
    if (url.pathname === '/api/search/stores' && request.method === 'GET') {
      return room.fetch(new Request('https://room/search/stores' + (url.search || ''), { method: 'GET' }));
    }
    if (url.pathname === '/api/regions') {
      return Response.json({ regions: [
        { id: 'cn', label: '中国大陆', default_location: '518000', part_suffix: 'CH/A', purchase_base: 'https://www.apple.com.cn/shop/buy-iphone' },
        { id: 'hk', label: '香港', default_location: '中環', part_suffix: 'ZA/A', purchase_base: 'https://www.apple.com/hk-zh/shop/buy-iphone' },
      ] });
    }
    if (url.pathname === '/api/settings') {
      if (request.method === 'GET') {
        return room.fetch(new Request('https://room/settings', { method: 'GET' }));
      }
      if (request.method === 'POST') {
        const adminKey = request.headers.get('X-Admin-Key');
        if (env.ADMIN_KEY && adminKey !== env.ADMIN_KEY) {
          return Response.json({ error: '设置密码不正确' }, { status: 403 });
        }
        return room.fetch(new Request('https://room/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: await request.text(),
        }));
      }
      return new Response('method not allowed', { status: 405 });
    }
    if (url.pathname === '/api/stream') {
      await ensureAlarm(room);
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
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    // Cron cannot run more often than once per minute. It only makes sure the
    // Durable Object's second-level alarm remains scheduled.
    ctx.waitUntil(ensureAlarm(getRoom(env)));
  },
};

function getRoom(env) {
  return env.ROOM.get(env.ROOM.idFromName('singleton'));
}

async function ensureAlarm(room) {
  const response = await room.fetch(new Request('https://room/ensure-alarm', {
    method: 'POST',
  }));
  if (!response.ok) {
    throw new Error(`Unable to ensure monitor alarm: ${await response.text()}`);
  }
}
