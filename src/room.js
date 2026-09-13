/**
 * Durable Object: "Room" — singleton holding:
 *   - latest observations and previous-available state in durable storage
 *   - a bounded log buffer of recent tick events
 *   - active SSE subscribers for live browser notifications
 */

import {
  fetchPickupObservations,
  fetchAllFamilyProducts,
  fetchAppleStores,
  fetchSimilarAvailability,
  listRegions,
  getRegion,
} from './apple.js';
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
    this.catalogue = { byRegion: {}, products: [], stores: [], productsAt: 0, storesAt: 0 };

    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(STORAGE_KEY);
      if (!saved) return;
      this.log = saved.log || [];
      this.previousAvailable = saved.previousAvailable || [];
      this.previousSimilarKeys = saved.previousSimilarKeys || [];
      this.lastCheckedAt = saved.lastCheckedAt || null;
      this.lastAttemptAt = saved.lastAttemptAt || null;
      this.status = saved.status || 'starting';
      this.observations = saved.observations || [];
      this.failCount = saved.failCount || 0;
      this.lastError = saved.lastError || null;
      this.pollState = saved.pollState || 'healthy';
      this.lastSimilarAvailability = saved.lastSimilarAvailability || null;
      this.previousSimilarKeys = saved.previousSimilarKeys || [];
      this.regionConfigs = saved.regionConfigs || this.monitorConfig.regions || [];
      if (saved.settings) {
        try {
          this.applyConfig(buildMonitorConfig(saved.settings));
        } catch {
          this.applyConfig(buildMonitorConfig(defaultMonitorSettings()));
        }
      }
      const catalog = await state.storage.get(CATALOG_KEY);
      if (catalog && typeof catalog === 'object') {
        if (catalog.byRegion) {
          this.catalogue = catalog;
        } else {
          // Migrate from the single-region v1 cache.
          this.catalogue = {
            byRegion: {
              cn: {
                products: catalog.products || [],
                stores: catalog.stores || [],
                productsAt: catalog.productsAt || 0,
                storesAt: catalog.storesAt || 0,
              },
              hk: { products: [], stores: [], productsAt: 0, storesAt: 0 },
            },
            products: catalog.products || [],
            stores: catalog.stores || [],
            productsAt: catalog.productsAt || 0,
            storesAt: catalog.storesAt || 0,
          };
        }
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') return this.handleState();
    if (url.pathname === '/log')   return this.handleLog();
    if (url.pathname === '/similar') return this.handleSimilar();
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
    let result = { observations: [], similar: [] };
    try {
      result = await this.runInventoryCheck(config);
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
        regions: config.regions,
        error: `${String((err && err.message) || err).slice(0, 240)}；${nextDelaySeconds} 秒后重试`,
      });
    } finally {
      // If every enabled region failed, treat the alarm as a backoff too.
      const enabledRegions = (config.regions || []).filter((r) => r.enabled);
      const anySuccess = (result.observations || []).length > 0;
      if (enabledRegions.length && !anySuccess) {
        const failCount = Math.max(1, this.failCount || 1);
        nextDelaySeconds = Math.min(
          900,
          Math.max(config.intervalSeconds, 30 * (2 ** Math.min(failCount - 1, 5))),
        );
        if (this.pollState !== 'backoff') this.pollState = 'backoff';
        this.appendLog('skip', `所有 ${enabledRegions.length} 个 region 本轮均失败或无数据，${nextDelaySeconds} 秒后重试`);
      }
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
      regions: listRegions().map((region) => {
        const r = this.catalogue.byRegion[region.id] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
        return {
          id: region.id,
          label: region.label,
          part_suffix: region.part_suffix,
          purchase_base: region.purchase_base,
          products: r.products,
          stores: r.stores,
          products_at: r.productsAt,
          stores_at: r.storesAt,
        };
      }),
      catalog: this.publicCatalog(),
    });
  }

  handleCatalogGet() {
    const now = Date.now();
    const byRegion = {};
    for (const region of listRegions()) {
      const r = this.catalogue.byRegion[region.id] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
      byRegion[region.id] = {
        products: r.products,
        stores: r.stores,
        products_at: r.productsAt,
        stores_at: r.storesAt,
        products_stale: !r.productsAt || now - r.productsAt > CATALOG_TTL_MS,
        stores_stale: !r.storesAt || now - r.storesAt > CATALOG_TTL_MS,
      };
    }
    return Response.json({ catalog: { byRegion } });
  }

  async handleCatalogRefresh(body) {
    const tasks = [];
    const regions = body && body.region ? [body.region] : listRegions().map((r) => r.id);
    for (const regionId of regions) {
      if (!getRegion(regionId)) continue;
      const location = (body && body.locations && body.locations[regionId]) || this.regionLocation(regionId);
      if (!body || body.products !== false) {
        tasks.push(this.refreshProductCatalogue(regionId)
          .then((n) => ({ region: regionId, kind: 'products', count: n }))
          .catch((err) => ({ region: regionId, kind: 'products', error: String(err.message || err) })));
      }
      if (!body || body.stores !== false) {
        tasks.push(this.refreshStoreCatalogue(regionId, location)
          .then((n) => ({ region: regionId, kind: 'stores', count: n, location }))
          .catch((err) => ({ region: regionId, kind: 'stores', error: String(err.message || err) })));
      }
    }
    const results = await Promise.all(tasks);
    return Response.json({ ok: true, results, catalog: this.publicCatalog() });
  }

  async handleProductSearch(url) {
    const region = url.searchParams.get('region') || 'cn';
    if (!getRegion(region)) {
      return Response.json({ ok: false, error: `unknown region ${region}` }, { status: 400 });
    }
    const query = url.searchParams.get('q') || '';
    try {
      if (!query) {
        const products = await this.ensureProductCatalogue(region);
        return Response.json({ ok: true, region, query, products });
      }
      const { searchProducts } = await import('./apple.js');
      const products = await searchProducts(region, query);
      return Response.json({ ok: true, region, query, products });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 502 });
    }
  }

  async handleStoreSearch(url) {
    const region = url.searchParams.get('region') || 'cn';
    if (!getRegion(region)) {
      return Response.json({ ok: false, error: `unknown region ${region}` }, { status: 400 });
    }
    const query = url.searchParams.get('q') || this.regionLocation(region);
    try {
      const stores = await fetchAppleStores(region, query);
      const bucket = this.catalogue.byRegion[region] = this.catalogue.byRegion[region] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
      bucket.stores = stores;
      bucket.storesAt = Date.now();
      await this.state.storage.put(CATALOG_KEY, this.catalogue);
      return Response.json({ ok: true, region, query, stores });
    } catch (err) {
      return Response.json({ ok: false, error: String(err.message || err) }, { status: 502 });
    }
  }

  regionLocation(regionId) {
    const r = this.settings?.regions?.[regionId];
    return (r && r.location) || getRegion(regionId)?.default_location || '';
  }

  async ensureProductCatalogue(regionId) {
    const bucket = this.catalogue.byRegion[regionId] = this.catalogue.byRegion[regionId] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
    const fresh = Date.now() - bucket.productsAt < CATALOG_TTL_MS;
    if (fresh && bucket.products.length) return bucket.products;
    return this.refreshProductCatalogue(regionId);
  }

  async refreshProductCatalogue(regionId) {
    const products = await fetchAllFamilyProducts(regionId);
    const bucket = this.catalogue.byRegion[regionId] = this.catalogue.byRegion[regionId] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
    bucket.products = products;
    bucket.productsAt = Date.now();
    this.catalogue.products = listRegions().flatMap((r) => this.catalogue.byRegion[r.id]?.products || []);
    this.catalogue.productsAt = Date.now();
    await this.state.storage.put(CATALOG_KEY, this.catalogue);
    return products.length;
  }

  async refreshStoreCatalogue(regionId, location) {
    const stores = await fetchAppleStores(regionId, location || this.regionLocation(regionId));
    const bucket = this.catalogue.byRegion[regionId] = this.catalogue.byRegion[regionId] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
    bucket.stores = stores;
    bucket.storesAt = Date.now();
    this.catalogue.stores = listRegions().flatMap((r) => this.catalogue.byRegion[r.id]?.stores || []);
    this.catalogue.storesAt = Date.now();
    await this.state.storage.put(CATALOG_KEY, this.catalogue);
    return stores.length;
  }

  publicCatalog() {
    const byRegion = {};
    for (const region of listRegions()) {
      const r = this.catalogue.byRegion[region.id] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
      byRegion[region.id] = {
        products: r.products,
        stores: r.stores,
        products_at: r.productsAt,
        stores_at: r.storesAt,
      };
    }
    return { byRegion };
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
      for (const region of listRegions()) {
        if (!settings.regions[region.id]?.enabled) continue;
        const bucket = this.catalogue.byRegion[region.id] = this.catalogue.byRegion[region.id] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
        if (!bucket.products.length) {
          try { await this.refreshProductCatalogue(region.id); } catch (err) { console.warn(`refresh products ${region.id}`, err.message || err); }
        }
        if (!bucket.stores.length) {
          try { await this.refreshStoreCatalogue(region.id, settings.regions[region.id].location); } catch (err) { console.warn(`refresh stores ${region.id}`, err.message || err); }
        }
      }
    } catch (err) {
      console.warn('catalogue refresh during save failed', err);
    }

    const config = buildMonitorConfig(settings);
    for (const regionConfig of config.regions) {
      const bucket = this.catalogue.byRegion[regionConfig.id] || { products: [], stores: [] };
      const productMap = new Map(bucket.products.map((p) => [p.part_number, p]));
      const storeMap = new Map(bucket.stores.map((s) => [s.store_number, s]));
      regionConfig.products = regionConfig.parts.map((pn) => productMap.get(pn)).filter(Boolean);
      regionConfig.stores = regionConfig.storeNumbers.map((sn) => storeMap.get(sn) || { region: regionConfig.id, store_number: sn, store_name: sn });
    }
    this.applyConfig(config);
    this.status = 'starting';
    this.pollState = 'healthy';
    this.lastError = null;
    this.failCount = 0;
    this.observations = [];
    this.previousAvailable = [];
    this.appendLog(
      'ok',
      `监控设置已更新 · 每 ${config.intervalSeconds} 秒 · ` +
      config.regions
        .filter((r) => r.enabled)
        .map((r) => `${r.label} ${r.parts.length}型号×${r.storeNumbers.length}店`)
        .join(' / '),
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
      catalog: this.publicCatalog(),
      regions: listRegions().map((region) => {
        const r = this.catalogue.byRegion[region.id] || { products: [], stores: [], productsAt: 0, storesAt: 0 };
        return {
          id: region.id, label: region.label,
          products: r.products, stores: r.stores,
          products_at: r.productsAt, stores_at: r.storesAt,
        };
      }),
    });
  }

  async runInventoryCheck(config) {
    const allObservations = [];
    const failures = [];
    const regions = (config.regions || []).filter((region) => region.enabled);
    for (const regionConfig of regions) {
      if (!regionConfig.parts.length || !regionConfig.storeNumbers.length) continue;
      try {
        const observations = await fetchPickupObservations(regionConfig.id, regionConfig);
        allObservations.push(...observations);
      } catch (err) {
        const message = String((err && err.message) || err).slice(0, 240);
        failures.push(`${regionConfig.label}: ${message}`);
        this.appendLog('fail', `${regionConfig.label} 库存查询失败 · ${message}`);
      }
    }
    await this.handleTick({
      checked_at: nowCst(),
      observations: allObservations,
      fail_count: failures.length,
      ok_count: allObservations.length,
      poll_seconds: config.intervalSeconds,
      regions: config.regions,
      source_url: config.regions?.[0]?.sourceUrl || '',
    });

    // Probe the recommendations endpoint for every saved part × store per
    // region and log every similar in-stock variant plus surface keyword
    // alerts.
    let allSimilar = [];
    let keywordHits = [];
    for (const regionConfig of regions) {
      if (!regionConfig.parts.length || !regionConfig.storeNumbers.length) continue;
      try {
        const similar = await fetchSimilarAvailability(regionConfig.id, regionConfig);
        allSimilar.push(...similar);
      } catch (err) {
        this.appendLog('fail', `${regionConfig.label} 相似机型查询失败 · ${String(err.message || err).slice(0, 200)}`);
      }
    }
    if (allSimilar.length) {
      keywordHits = this.recordSimilarAvailability(allSimilar);
    }
    return { observations: allObservations, similar: allSimilar, keywordHits };
  }

  recordSimilarAvailability(similar) {
    const regionKeywords = {};
    for (const region of this.regionConfigs || []) {
      const tokens = Array.isArray(region.keywordTokens) && region.keywordTokens.length
        ? region.keywordTokens
        : String(region.keywordAlert || '').split('|').map((s) => s.trim()).filter(Boolean);
      regionKeywords[region.id] = tokens;
    }

    let totalAvailable = 0;
    let totalProbed = 0;
    let errored = 0;
    const keywordHits = [];
    // De-duplicate: when the same source_part yields the same Apple
    // recommendations everywhere (typical — the recommendations endpoint
    // returns the same "nearby available models" regardless of the asked
    // part), collapse them into a single row keyed by (similar_part, store,
    // region).  Track which (source_part, store) pairs we've already shown
    // so the dashboard isn't flooded with 18 identical cards.
    const seenSourceKeys = new Set();
    const seenItemKeys = new Set();
    const dedupedItems = [];
    const probeSummaries = [];

    const previousKeys = new Set(this.previousSimilarKeys || []);
    const currentKeys = new Set();
    const newHitKeys = new Set();

    for (const probe of similar) {
      totalProbed += 1;
      if (probe.error) { errored += 1; probeSummaries.push({ ...probe, deduplicated: true }); continue; }
      if (!probe.similar || !probe.similar.length) {
        probeSummaries.push({ ...probe, deduplicated: true });
        continue;
      }
      const sourceKey = `${probe.region}|${probe.part_number}|${probe.store_number}`;
      const firstForSource = !seenSourceKeys.has(sourceKey);
      seenSourceKeys.add(sourceKey);
      const region = this.regionConfigs?.find((r) => r.id === probe.region);
      const regionLabel = region?.label || probe.region;
      const storeByNumber = new Map((region?.stores || []).map((s) => [s.store_number, s]));
      const sourceStore = storeByNumber.get(probe.store_number);
      const storeName = sourceStore?.store_name || probe.store_number;
      const tokens = regionKeywords[probe.region] || [];

      const keptForThisProbe = [];
      for (const item of probe.similar) {
        totalAvailable += 1;
        const itemKey = `${probe.region}|${item.part_number}|${probe.store_number}`;
        const isDuplicate = seenItemKeys.has(itemKey);
        if (isDuplicate) continue;
        seenItemKeys.add(itemKey);
        currentKeys.add(itemKey);
        const title = item.title || `${item.model || ''} ${item.capacity || ''} ${item.color || ''}`.trim() || item.part_number;
        const summary = `[${regionLabel}] ${title} @ ${storeName}`;
        this.appendLog('ok', `相似机型有货 · ${summary} · ${item.pickup_quote || ''}`.slice(0, 240));
        const matched = pickKeyword(tokens, title);
        const enqueued = {
          region: probe.region,
          source_part: probe.part_number,
          store_name: storeName,
          store_number: probe.store_number,
          part_number: item.part_number,
          title,
          pickup_quote: item.pickup_quote,
          pickup_display: item.pickup_display,
          model: item.model,
          capacity: item.capacity,
          color: item.color,
        };
        dedupedItems.push(enqueued);
        keptForThisProbe.push(enqueued);
        if (matched) {
          keywordHits.push({ ...enqueued, keyword: matched });
          if (!previousKeys.has(itemKey)) newHitKeys.add(itemKey);
        }
      }
      probeSummaries.push({ ...probe, deduplicated: !firstForSource, kept: keptForThisProbe.length });
    }

    this.previousSimilarKeys = [...currentKeys];

    this.appendLog(
      'skip',
      `相似机型扫描 · 探测 ${totalProbed} 个组合 · 去重后 ${dedupedItems.length} 条 · 失败 ${errored} · 关键字匹配 ${keywordHits.length}`,
    );

    this.lastSimilarAvailability = {
      ts: nowCst(),
      total_probed: totalProbed,
      total_available: totalAvailable,
      errored,
      deduplicated: dedupedItems.length,
      items: dedupedItems,
      probes: probeSummaries,
      keyword_hits: keywordHits,
    };

    if (newHitKeys.size > 0) {
      const broadcast = {
        type: 'keyword-available',
        hits: keywordHits.filter((h) => newHitKeys.has(`${h.region}|${h.part_number}|${h.store_number}`)),
        ts: nowCst(),
      };
      for (const c of this.subscribers) this.safeEnqueue(c, 'keyword-available', broadcast);
    }
    return keywordHits;
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
    this.sourceUrl = config.regions?.[0]?.sourceUrl || '';
    this.regionConfigs = config.regions || [];
  }

  handleState() {
    const body = JSON.stringify({
      status: this.status,
      checked_at: this.lastCheckedAt,
      last_attempt_at: this.lastAttemptAt,
      available: this.currentAvailable(),
      new_available: [],
      observations: this.observations,
      stores: this.flattenStores(),
      variants: this.flattenVariants(),
      regions: this.regionConfigs || [],
      source_url: this.sourceUrl,
      settings: this.settings,
      last_similar: this.lastSimilarAvailability || null,
      catalog: this.publicCatalog(),
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

  handleSimilar() {
    return Response.json(this.lastSimilarAvailability || { similar: [], keyword_hits: [] });
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
    if (payload.source_url) this.sourceUrl = payload.source_url;
    if (Array.isArray(payload.regions) && payload.regions.length) {
      this.regionConfigs = payload.regions;
    }

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

    const newDetail = formatKeys(newlyAvailable, this.observations, this.flattenVariants());
    const availDetail = formatKeys([...currentSet], this.observations, this.flattenVariants());
    const msg =
      `tick 成功 · 在售 ${currentSet.size} 个组合` +
      (availDetail ? `（${availDetail}）` : '') +
      ` · 新增 ${newlyAvailable.length} 个` +
      (newDetail ? `（${newDetail}）` : '') +
      ` · 监控 ${this.observations.length} 个观察点`;
    this.appendLog('ok', msg);
    await this.persist();

    if (newlyAvailable.length > 0) {
      const broadcast = {
        type: 'new-available',
        keys: newlyAvailable,
        details: newlyAvailable.map((k) => {
          const [part, store] = k.split('|');
          const obs = this.observations.find((o) => o.part_number === part && o.store_number === store);
          const variants = this.flattenVariants();
          const v = variants.find((vv) => vv.part_number === part) || {};
          return {
            key: k,
            part_number: part,
            region: obs?.region || '',
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
    for (const c of this.subscribers) {
      this.safeEnqueue(c, 'state', { checked_at: this.lastCheckedAt });
    }

    return new Response('ok');
  }

  async handleTestStock(body) {
    // Forge: pretend some part+store just became available.
    const region = body && body.region || 'cn';
    const part = (body && body.part_number) || this.regionConfigs?.find((r) => r.id === region)?.parts?.[0] || '';
    const store = (body && body.store_number) || this.regionConfigs?.find((r) => r.id === region)?.storeNumbers?.[0] || '';
    if (!part || !store) {
      return new Response('no part/store available for testing', { status: 400 });
    }
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
    this.previousAvailable = this.previousAvailable.filter((k) => k !== `${part}|${store}`);
    return this.handleTick(fake);
  }

  currentAvailable() {
    return this.observations
      .filter((o) => o.pickup_display === 'available')
      .map((o) => `${o.part_number}|${o.store_number}`);
  }

  flattenStores() {
    const out = [];
    for (const region of this.regionConfigs || []) {
      for (const store of region.stores || []) out.push(store);
    }
    return out;
  }

  flattenVariants() {
    const out = [];
    for (const region of this.regionConfigs || []) {
      for (const product of region.products || []) out.push(product);
    }
    return out;
  }

  async persist() {
    await this.state.storage.put(STORAGE_KEY, {
      log: this.log,
      previousAvailable: this.previousAvailable,
      previousSimilarKeys: this.previousSimilarKeys || [],
      lastCheckedAt: this.lastCheckedAt,
      lastAttemptAt: this.lastAttemptAt,
      status: this.status,
      observations: this.observations,
      failCount: this.failCount,
      lastError: this.lastError,
      pollSeconds: this.pollSeconds,
      pollState: this.pollState,
      settings: this.settings,
      lastSimilarAvailability: this.lastSimilarAvailability || null,
      regionConfigs: this.regionConfigs || [],
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

function pickKeyword(tokens, title) {
  if (!Array.isArray(tokens) || !tokens.length) return '';
  let best = '';
  for (const token of tokens) {
    if (!token) continue;
    if (title.includes(token) && token.length > best.length) best = token;
  }
  return best;
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