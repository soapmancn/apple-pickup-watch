/**
 * Durable Object: "Room" — singleton holding:
 *   - the latest observation snapshot (kept in memory, never written to
 *     storage so a cold start after Workers eviction shows "starting"
 *     until the next cron tick fires within 2 min)
 *   - the previous-available set (for edge-trigger diff)
 *   - a bounded log buffer of recent tick events
 *   - a set of active SSE subscribers (controllers) so we can broadcast
 *     newly-available hits to every connected browser tab in real time.
 *
 * Endpoints handled via internal Request:
 *   GET  /state      → full JSON snapshot
 *   GET  /log        → bounded log (newest first)
 *   GET  /stream     → SSE subscription (long-lived)
 *   POST /tick       → cron-fetch result ingestion; computes diff +
 *                       broadcasts SSE "new-available" event
 *   POST /test-stock → admin: forge a synthetic available hit (for demos)
 */

const LOG_MAX = 100;

export class Room {
  constructor(state, env) {
    this.state = state;          // DurableObjectState
    this.env = env;
    /** @type {Array<{ts:string,level:string,msg:string}>} */
    this.log = [];
    /** @type {string[]} */
    this.previousAvailable = [];
    this.lastCheckedAt = null;
    this.lastAttemptAt = null;
    this.pollSeconds = 120;
    this.pollState = 'healthy';
    this.status = 'starting';
    this.observations = [];
    this.failCount = 0;
    /** @type {Set<ReadableStreamDefaultController>} */
    this.subscribers = new Set();
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
      stores: Object.values(STORE_INFO),
      variants: VARIANTS,
      source_url: SOURCE_URL,
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
    this.observations = payload.observations || [];
    this.failCount = payload.fail_count || 0;
    this.status = this.failCount > 0 && this.failCount >= STORES.length ? 'query_failed' : 'ok';
    this.lastError = this.status === 'query_failed' ? `${this.failCount}/${STORES.length} stores failed` : null;
    this.lastCheckedAt = payload.checked_at || this.lastAttemptAt;

    const currentSet = new Set(this.currentAvailable());
    const previousSet = new Set(this.previousAvailable);
    const newlyAvailable = [...currentSet].filter((k) => !previousSet.has(k));
    this.previousAvailable = [...currentSet];

    const newDetail = formatKeys(newlyAvailable, this.observations);
    const availDetail = formatKeys([...currentSet], this.observations);
    const msg =
      `tick 成功 · 在售 ${currentSet.size} 个组合` +
      (availDetail ? `（${availDetail}）` : '') +
      ` · 新增 ${newlyAvailable.length} 个` +
      (newDetail ? `（${newDetail}）` : '') +
      ` · 监控 ${this.observations.length} 个观察点` +
      (this.failCount ? ` · 失败 ${this.failCount}/${STORES.length} 家门店` : '');
    this.appendLog('ok', msg);

    // Broadcast to all open browsers.
    if (newlyAvailable.length > 0) {
      const broadcast = {
        type: 'new-available',
        keys: newlyAvailable,
        details: newlyAvailable.map((k) => {
          const [part, store] = k.split('|');
          const obs = this.observations.find((o) => o.part_number === part && o.store_number === store);
          const v = VARIANTS.find((vv) => vv.part_number === part) || {};
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
    const part = (body && body.part_number) || 'MJYD4CH/A';
    const store = (body && body.store_number) || 'R793';
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

  appendLog(level, msg) {
    this.log.push({ ts: nowCst(), level, msg });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }
}

const SOURCE_URL = 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy74ch/a';
const STORES = ['R761', 'R484', 'R793'];
const VARIANTS = [
  { part_number: 'MJY84CH/A', color: '勃艮第酒红色', capacity: '256GB' },
  { part_number: 'MJY94CH/A', color: '冰川蓝色',   capacity: '256GB' },
  { part_number: 'MJY74CH/A', color: '银色',       capacity: '256GB' },
  { part_number: 'MJYD4CH/A', color: '勃艮第酒红色', capacity: '512GB' },
  { part_number: 'MJYE4CH/A', color: '冰川蓝色',   capacity: '512GB' },
  { part_number: 'MJYC4CH/A', color: '银色',       capacity: '512GB' },
];
const STORE_INFO = {
  R761: { store_number: 'R761', store_name: '深圳万象城' },
  R484: { store_number: 'R484', store_name: '深圳益田假日广场' },
  R793: { store_number: 'R793', store_name: '前海壹方城' },
};

function formatKeys(keys, observations) {
  if (!keys.length) return '';
  const oBy = new Map(observations.map((o) => [`${o.part_number}|${o.store_number}`, o]));
  const vBy = new Map(VARIANTS.map((v) => [v.part_number, v]));
  return keys.map((k) => {
    const [part, store] = k.split('|');
    const v = vBy.get(part) || {};
    const o = oBy.get(k) || {};
    return `${part}（${v.color || ''}${v.capacity || ''}）@ ${o.store_name || store}（${store}）`;
  }).join(' · ');
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