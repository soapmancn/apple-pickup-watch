/**
 * Durable Object: "Room" — singleton holding:
 *   - latest observations and previous-available state in durable storage
 *   - a bounded log buffer of recent tick events
 *   - active SSE subscribers for live browser notifications
 */

import { getMonitorConfig } from './config.js';

const LOG_MAX = 100;
const STORAGE_KEY = 'monitor-state-v1';

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const config = safeMonitorConfig(env);
    this.log = [];
    this.previousAvailable = [];
    this.lastCheckedAt = null;
    this.lastAttemptAt = null;
    this.pollSeconds = config.pollSeconds;
    this.pollState = 'healthy';
    this.status = 'starting';
    this.observations = [];
    this.failCount = 0;
    this.lastError = null;
    this.stores = config.stores;
    this.variants = config.products;
    this.sourceUrl = config.sourceUrl;
    this.subscribers = new Set();

    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(STORAGE_KEY);
      if (!saved) return;
      this.log = saved.log || [];
      this.previousAvailable = saved.previousAvailable || [];
      this.lastCheckedAt = saved.lastCheckedAt || null;
      this.lastAttemptAt = saved.lastAttemptAt || null;
      this.status = saved.status || 'starting';
      this.observations = saved.observations || [];
      this.failCount = saved.failCount || 0;
      this.lastError = saved.lastError || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') return this.handleState();
    if (url.pathname === '/log')   return this.handleLog();
    if (url.pathname === '/stream') return this.handleStream(request);
    if (url.pathname === '/tick' && request.method === 'POST') {
      return this.handleTick(await request.json());
    }
    if (url.pathname === '/test-stock' && request.method === 'POST') {
      return this.handleTestStock(await request.json());
    }
    return new Response('not found', { status: 404 });
  }

  handleState() {
    const body = JSON.stringify({
      status: this.status,
      checked_at: this.lastCheckedAt,
      last_attempt_at: this.lastAttemptAt,
      available: this.currentAvailable(),
      new_available: [],
      observations: this.observations,
      stores: this.stores,
      variants: this.variants,
      source_url: this.sourceUrl,
      error: this.status === 'query_failed' ? this.lastError : null,
      poll_seconds: this.pollSeconds,
      poll_state: this.pollState,
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  handleLog() {
    const body = JSON.stringify({ entries: this.log.slice().reverse() });
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  /**
   * SSE: client opens EventSource('/api/stream'). We hold the controller
   * in `this.subscribers` and push `event: new-available\ndata: ...\n\n`
   * frames whenever the cron tick detects newly in-stock SKUs.
   */
  handleStream(request) {
    const stream = new ReadableStream({
      start: (controller) => {
        this.subscribers.add(controller);
        // Initial hello so the client knows the stream is live.
        this.safeEnqueue(controller, 'hello', { ts: this.lastCheckedAt });
        // Auto-close if client disconnects.
        request.signal.addEventListener('abort', () => {
          this.subscribers.delete(controller);
          try { controller.close(); } catch {}
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  safeEnqueue(controller, event, data) {
    try {
      controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.subscribers.delete(controller);
    }
  }

  async handleTick(payload) {
    this.lastAttemptAt = nowCst();
    this.failCount = payload.fail_count || 0;
    this.lastCheckedAt = payload.checked_at || this.lastAttemptAt;
    if (Number.isFinite(payload.poll_seconds) && payload.poll_seconds >= 60) {
      this.pollSeconds = payload.poll_seconds;
    }
    if (Array.isArray(payload.stores) && payload.stores.length) this.stores = payload.stores;
    if (Array.isArray(payload.products) && payload.products.length) this.variants = payload.products;
    if (payload.source_url) this.sourceUrl = payload.source_url;

    if (payload.error || this.failCount > 0) {
      this.status = 'query_failed';
      this.lastError = payload.error || `${this.failCount} query operations failed`;
      this.appendLog('fail', `tick 失败 · ${this.lastError}`);
      await this.persist();
      for (const c of this.subscribers) {
        this.safeEnqueue(c, 'state', { checked_at: this.lastCheckedAt });
      }
      return new Response('query failed', { status: 502 });
    }

    this.status = 'ok';
    this.lastError = null;
    this.observations = payload.observations || [];

    const currentSet = new Set(this.currentAvailable());
    const previousSet = new Set(this.previousAvailable);
    const newlyAvailable = [...currentSet].filter((k) => !previousSet.has(k));
    this.previousAvailable = [...currentSet];

    const newDetail = formatKeys(newlyAvailable, this.observations, this.variants);
    const availDetail = formatKeys([...currentSet], this.observations, this.variants);
    const msg =
      `tick 成功 · 在售 ${currentSet.size} 个组合` +
      (availDetail ? `（${availDetail}）` : '') +
      ` · 新增 ${newlyAvailable.length} 个` +
      (newDetail ? `（${newDetail}）` : '') +
      ` · 监控 ${this.observations.length} 个观察点`;
    this.appendLog('ok', msg);
    await this.persist();

    // Broadcast to all open browsers.
    if (newlyAvailable.length > 0) {
      const broadcast = {
        type: 'new-available',
        keys: newlyAvailable,
        details: newlyAvailable.map((k) => {
          const [part, store] = k.split('|');
          const obs = this.observations.find((o) => o.part_number === part && o.store_number === store);
          const v = this.variants.find((vv) => vv.part_number === part) || {};
          return {
            key: k,
            part_number: part,
            capacity: v.capacity || '',
            color: v.color || '',
            store_name: obs?.store_name || store,
            store_number: store,
          };
        }),
        ts: this.lastCheckedAt,
      };
      for (const c of this.subscribers) this.safeEnqueue(c, 'new-available', broadcast);
    }
    // Also broadcast an updated-state heartbeat so any tab can refresh
    // its in-page view without polling /api/state.
    for (const c of this.subscribers) {
      this.safeEnqueue(c, 'state', { checked_at: this.lastCheckedAt });
    }

    return new Response('ok');
  }

  async handleTestStock(body) {
    // Forge: pretend some part+store just became available.
    const part = (body && body.part_number) || this.variants[0]?.part_number || '';
    const store = (body && body.store_number) || this.stores[0]?.store_number || '';
    const fake = {
      checked_at: nowCst(),
      observations: this.observations.map((o) => {
        if (o.part_number === part && o.store_number === store) {
          return { ...o, pickup_display: 'available', pickup_quote: '今日可取货（测试）', pickup_quote_value: 99 };
        }
        return o;
      }),
      fail_count: 0,
    };
    // Force a diff: clear previous_available first.
    this.previousAvailable = this.previousAvailable.filter((k) => k !== `${part}|${store}`);
    return this.handleTick(fake);
  }

  currentAvailable() {
    return this.observations
      .filter((o) => o.pickup_display === 'available')
      .map((o) => `${o.part_number}|${o.store_number}`);
  }

  async persist() {
    await this.state.storage.put(STORAGE_KEY, {
      log: this.log,
      previousAvailable: this.previousAvailable,
      lastCheckedAt: this.lastCheckedAt,
      lastAttemptAt: this.lastAttemptAt,
      status: this.status,
      observations: this.observations,
      failCount: this.failCount,
      lastError: this.lastError,
      pollSeconds: this.pollSeconds,
    });
  }

  appendLog(level, msg) {
    this.log.push({ ts: nowCst(), level, msg });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }
}

function formatKeys(keys, observations, variants) {
  if (!keys.length) return '';
  const oBy = new Map(observations.map((o) => [`${o.part_number}|${o.store_number}`, o]));
  const vBy = new Map(variants.map((v) => [v.part_number, v]));
  return keys.map((k) => {
    const [part, store] = k.split('|');
    const v = vBy.get(part) || {};
    const o = oBy.get(k) || {};
    return `${part}（${v.color || ''}${v.capacity || ''}）@ ${o.store_name || store}（${store}）`;
  }).join(' · ');
}

function safeMonitorConfig(env) {
  try {
    return getMonitorConfig(env);
  } catch {
    return getMonitorConfig({});
  }
}

function nowCst() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60_000;
  const cstMs = utc + 8 * 3600_000;
  const cst = new Date(cstMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ` +
    `${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())} CST`
  );
}