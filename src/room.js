/**
 * Durable Object: "Room" — singleton holding:
 *   - latest observations and previous-available state in durable storage
 *   - a bounded log buffer of recent tick events
 *   - active SSE subscribers for live browser notifications
 */

import { fetchPickupObservations, fetchAllFamilyProducts, fetchAppleStores } from './apple.js';
import {
  buildMonitorConfig,
  defaultMonitorSettings,
  normalizeMonitorSettings,
} from './config.js';

const LOG_MAX = 100;
const STORAGE_KEY = 'monitor-state-v1';
const CATALOG_KEY = 'monitor-catalog-v1';
const ALARM_CONFIG_KEY = 'monitor-alarm-config-v1';
const CATALOG_TTL_MS = 1000 * 60 * 60 * 12;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const config = buildMonitorConfig(defaultMonitorSettings());
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
    this.settings = config.settings;
    this.monitorConfig = config;
    this.subscribers = new Set();
    this.catalogue = { products: [], stores: [], productsAt: 0, storesAt: 0 };

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
      this.pollState = saved.pollState || 'healthy';
      if (saved.settings) {
        try {
          this.applyConfig(buildMonitorConfig(saved.settings));
        } catch {
          this.applyConfig(buildMonitorConfig(defaultMonitorSettings()));
        }
      }
      const catalog = await state.storage.get(CATALOG_KEY);
      if (catalog) {
        this.catalogue = {
          products: catalog.products || [],
          stores: catalog.stores || [],
          productsAt: catalog.productsAt || 0,
          storesAt: catalog.storesAt || 0,
        };
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') return this.handleState();
    if (url.pathname === '/log')   return this.handleLog();
    if (url.pathname === '/catalog') {
      if (request.method === 'POST') return this.handleCatalogRefresh(await request.json().catch(() => ({})));
      return this.handleCatalogGet();
    }
    if (url.pathname === '/search/products' && request.method === 'GET') {
      return this.handleProductSearch(url);
    }
    if (url.pathname === '/search/stores' && request.method === 'GET') {
      return this.handleStoreSearch(url);
    }
    if (url.pathname === '/settings' && request.method === 'GET') {
      return this.handleSettingsGet();
    }
    if (url.pathname === '/settings' && request.method === 'POST') {
      return this.handleSettingsUpdate(await request.json().catch(() => null));
    }
    if (url.pathname === '/stream') return this.handleStream(request);
    if (url.pathname === '/ensure-alarm' && request.method === 'POST') {
      return this.handleEnsureAlarm();
    }
    if (url.pathname === '/test-stock' && request.method === 'POST') {
      return this.handleTestStock(await request.json());
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const config = this.monitorConfig;
    let nextDelaySeconds = config.intervalSeconds;
    try {
      await this.runInventoryCheck(config);
    } catch (err) {
      const failCount = this.failCount + 1;
      nextDelaySeconds = Math.min(
        900,
        Math.max(config.intervalSeconds, 30 * (2 ** Math.min(failCount - 1, 5))),
      );
      await this.handleTick({
        checked_at: nowCst(),
        observations: [],
        fail_count: failCount,
        ok_count: 0,
        poll_seconds: config.intervalSeconds,
        error: `${String((err && err.message) || err).slice(0, 240)}；${nextDelaySeconds} 秒后重试`,
      });
    } finally {
      await this.scheduleNextAlarm(nextDelaySeconds, this.monitorConfig.intervalSeconds);
    }
  }

  async handleEnsureAlarm() {
    const config = this.monitorConfig;
    const [currentAlarm, alarmConfig] = await Promise.all([
      this.state.storage.getAlarm(),
      this.state.storage.get(ALARM_CONFIG_KEY),
    ]);
    if (currentAlarm === null || alarmConfig?.intervalSeconds !== config.intervalSeconds) {
      await this.state.storage.setAlarm(Date.now() + 1_000);
      await this.state.storage.put(ALARM_CONFIG_KEY, {
        intervalSeconds: config.intervalSeconds,
      });
    }
    return Response.json({
      ok: true,
      interval_seconds: config.intervalSeconds,
      alarm_at: await this.state.storage.getAlarm(),
    });
  }

  handleSettingsGet() {
    return Response.json({
      settings: this.settings,
      catalog: {
        products: this.catalogue.products,
        stores: this.catalogue.stores,
        products_at: this.catalogue.productsAt,
        stores_at: this.catalogue.storesAt,
      },
    });
  }

  handleCatalogGet() {
    const now = Date.now();
    const productsStale = now - this.catalogue.productsAt > CATALOG_TTL_MS;
    const storesStale = now - this.catalogue.storesAt > CATALOG_TTL_MS;
    return Response.json({
      catalog: {
        products: this.catalogue.products,
        stores: this.catalogue.stores,
        products_at: this.catalogue.productsAt,
        stores_at: this.catalogue.storesAt,
        products_stale: productsStale,
        stores_stale: storesStale,
      },
    });
  }

  async handleCatalogRefresh(body) {
    const tasks = [];
    if (!body || body.products !== false) {
      tasks.push(this.refreshProductCatalogue().then((n) => ({ kind: 'products', count: n })).catch((err) => ({ kind: 'products', error: String(err.message || err) })));
    }
    const location = String((body && body.location) || this.settings?.location || '').trim();
    if (!body || body.stores !== false) {
      tasks.push(this.refreshStoreCatalogue(location).then((n) => ({ kind: 'stores', count: n, location })).catch((err) => ({ kind: 'stores', error: String(err.message || err) })));
    }
    const results = await Promise.all(tasks);
    return Response.json({ ok: true, results, catalog: {
      products: this.catalogue.products,
      stores: this.catalogue.stores,
      products_at: this.catalogue.productsAt,
      stores_at: this.catalogue.storesAt,
    } });
  }

  async handleProductSearch(url) {
    const query = url.searchParams.get('q') || '';
    try {
      if (!query) {
        const products = await this.ensureProductCatalogue();
        return Response.json({ ok: true, query, products });
      }
      const { searchProducts } = await import('./apple.js');
      const products = await searchProducts(query);
      return Response.json({ ok: true, query, products });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 502 });
    }
  }

  async handleStoreSearch(url) {
    const query = url.searchParams.get('q') || this.settings?.location || '';
    try {
      const stores = await fetchAppleStores(query);
      this.catalogue.stores = stores;
      this.catalogue.storesAt = Date.now();
      await this.state.storage.put(CATALOG_KEY, this.catalogue);
      return Response.json({ ok: true, query, stores });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 502 });
    }
  }

  async ensureProductCatalogue() {
    const fresh = Date.now() - this.catalogue.productsAt < CATALOG_TTL_MS;
    if (fresh && this.catalogue.products.length) return this.catalogue.products;
    return this.refreshProductCatalogue();
  }

  async refreshProductCatalogue() {
    const products = await fetchAllFamilyProducts();
    this.catalogue.products = products;
    this.catalogue.productsAt = Date.now();
    await this.state.storage.put(CATALOG_KEY, this.catalogue);
    return products.length;
  }

  async refreshStoreCatalogue(location) {
    const stores = await fetchAppleStores(location || this.settings?.location);
    this.catalogue.stores = stores;
    this.catalogue.storesAt = Date.now();
    await this.state.storage.put(CATALOG_KEY, this.catalogue);
    return stores.length;
  }

  async handleSettingsUpdate(input) {
    let settings;
    try {
      settings = normalizeMonitorSettings(input);
    } catch (err) {
      return Response.json({ error: String((err && err.message) || err) }, { status: 400 });
    }
    // Make sure catalogue info is current so the saved config carries product
    // + store labels for the dashboard summary.
    try {
      if (!this.catalogue.products.length) await this.refreshProductCatalogue();
      if (!this.catalogue.stores.length) await this.refreshStoreCatalogue(settings.location);
    } catch (err) {
      console.warn('catalogue refresh during save failed', err);
    }

    const config = buildMonitorConfig(settings);
    const productMap = new Map(this.catalogue.products.map((p) => [p.part_number, p]));
    const storeMap = new Map(this.catalogue.stores.map((s) => [s.store_number, s]));
    const products = settings.part_numbers.map((pn) => productMap.get(pn)).filter(Boolean);
    const stores = settings.store_numbers.map((sn) => storeMap.get(sn) || { store_number: sn, store_name: sn, city: '' });
    config.products = products;
    config.stores = stores;
    this.applyConfig(config);
    this.status = 'starting';
    this.pollState = 'healthy';
    this.lastError = null;
    this.failCount = 0;
    this.observations = [];
    this.previousAvailable = [];
    this.appendLog(
      'ok',
      `监控设置已更新 · 每 ${config.intervalSeconds} 秒 · ${stores.length} 家店 · ${products.length} 个型号容量`,
    );
    await this.persist();
    await this.state.storage.setAlarm(Date.now() + 1_000);
    await this.state.storage.put(ALARM_CONFIG_KEY, {
      intervalSeconds: config.intervalSeconds,
      delaySeconds: 1,
    });
    for (const controller of this.subscribers) {
      this.safeEnqueue(controller, 'state', { settings_updated: true });
    }
    return Response.json({
      ok: true,
      settings: this.settings,
      catalog: {
        products: this.catalogue.products,
        stores: this.catalogue.stores,
        products_at: this.catalogue.productsAt,
        stores_at: this.catalogue.storesAt,
      },
    });
  }

  async runInventoryCheck(config) {
    const observations = await fetchPickupObservations(config);
    await this.handleTick({
      checked_at: nowCst(),
      observations,
      fail_count: 0,
      ok_count: observations.length,
      poll_seconds: config.intervalSeconds,
      stores: config.stores,
      products: config.products,
      source_url: config.sourceUrl,
    });
  }

  async scheduleNextAlarm(delaySeconds, configuredIntervalSeconds = delaySeconds) {
    await this.state.storage.setAlarm(Date.now() + delaySeconds * 1_000);
    await this.state.storage.put(ALARM_CONFIG_KEY, {
      intervalSeconds: configuredIntervalSeconds,
      delaySeconds,
    });
  }

  applyConfig(config) {
    this.monitorConfig = config;
    this.settings = config.settings;
    this.pollSeconds = config.intervalSeconds;
    this.stores = config.stores;
    this.variants = config.products;
    this.sourceUrl = config.sourceUrl;
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
      settings: this.settings,
      catalog: {
        products: this.catalogue.products,
        stores: this.catalogue.stores,
        products_at: this.catalogue.productsAt,
        stores_at: this.catalogue.storesAt,
      },
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
   * frames whenever the alarm detects newly in-stock SKUs.
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
    if (Number.isFinite(payload.poll_seconds) && payload.poll_seconds >= 10) {
      this.pollSeconds = payload.poll_seconds;
    }
    if (Array.isArray(payload.stores) && payload.stores.length) this.stores = payload.stores;
    if (Array.isArray(payload.products) && payload.products.length) this.variants = payload.products;
    if (payload.source_url) this.sourceUrl = payload.source_url;

    if (payload.error || this.failCount > 0) {
      this.status = 'query_failed';
      this.pollState = 'backoff';
      this.lastError = payload.error || `${this.failCount} query operations failed`;
      this.appendLog('fail', `tick 失败 · ${this.lastError}`);
      await this.persist();
      for (const c of this.subscribers) {
        this.safeEnqueue(c, 'state', { checked_at: this.lastCheckedAt });
      }
      return new Response('query failed', { status: 502 });
    }

    this.status = 'ok';
    this.pollState = 'healthy';
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
      pollState: this.pollState,
      settings: this.settings,
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