import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../src/room.js';
import { defaultMonitorSettings } from '../src/config.js';

class FakeStorage {
  constructor() {
    this.values = new Map();
    this.alarmTime = null;
  }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarmTime; }
  async setAlarm(value) { this.alarmTime = value; }
}

function createRoom() {
  const storage = new FakeStorage();
  const state = {
    storage,
    ready: Promise.resolve(),
    blockConcurrencyWhile(callback) {
      this.ready = Promise.resolve().then(callback);
      return this.ready;
    },
  };
  return { room: new Room(state, {}), state, storage };
}

function seedCatalog(room) {
  room.catalogue.byRegion.cn = {
    products: [
      { part_number: 'MJYD4CH/A', region: 'cn', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '勃艮第酒红色' },
    ],
    stores: [{ store_number: 'R793', store_name: '前海壹方城', city: '深圳', region: 'cn' }],
    productsAt: Date.now(),
    storesAt: Date.now(),
  };
  room.catalogue.byRegion.hk = {
    products: [
      { part_number: 'MJXW4ZA/A', region: 'hk', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '冰川色' },
    ],
    stores: [{ store_number: 'R428', store_name: 'ifc mall', city: '香港', region: 'hk' }],
    productsAt: Date.now(),
    storesAt: Date.now(),
  };
}

test('web settings persist and reschedule the alarm immediately', async () => {
  const { room, state, storage } = createRoom();
  await state.ready;
  const before = await (await room.fetch(new Request('https://room/settings'))).json();
  assert.equal(before.settings.interval_seconds, 120);

  seedCatalog(room);
  const startedAt = Date.now();
  const response = await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      regions: {
        cn: { enabled: true, location: '518000', store_numbers: ['R793'], part_numbers: ['MJYD4CH/A'] },
        hk: { enabled: false, location: '中環', store_numbers: [], part_numbers: [] },
      },
    }),
  }));
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.settings.interval_seconds, 10);
  assert.deepEqual(updated.settings.regions.cn.store_numbers, ['R793']);
  assert.deepEqual(updated.settings.regions.cn.part_numbers, ['MJYD4CH/A']);
  assert.equal(updated.settings.regions.hk.enabled, false);

  const saved = await storage.get('monitor-state-v1');
  assert.equal(saved.settings.interval_seconds, 10);
  assert.ok(storage.alarmTime >= startedAt + 900);
  assert.ok(storage.alarmTime <= Date.now() + 2_000);

  const stateBody = await (await room.fetch(new Request('https://room/state'))).json();
  assert.equal(stateBody.poll_seconds, 10);
  const cnRegion = stateBody.regions.find((r) => r.id === 'cn');
  assert.equal(cnRegion.storeNumbers[0], 'R793');
  assert.equal(stateBody.variants[0].capacity, '512GB');
});

test('alarm uses saved web settings and schedules the next second-level check', async () => {
  const { room, state, storage } = createRoom();
  await state.ready;
  seedCatalog(room);
  await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      regions: {
        cn: { enabled: true, location: '518000', store_numbers: ['R793'], part_numbers: ['MJYD4CH/A'] },
        hk: { enabled: false, location: '中環', store_numbers: [], part_numbers: [] },
      },
    }),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('pickup-message?')) {
      return Response.json({
        body: {
          stores: [{
            storeNumber: 'R793',
            storeName: '前海壹方城',
            city: '深圳',
            partsAvailability: {
              'MJYD4CH/A': {
                pickupDisplay: 'available',
                pickupSearchQuote: '今日可取货',
                pickupSearchQuoteValue: 1,
              },
            },
          }],
        },
      });
    }
    return Response.json({ body: { noSimilarModelsText: '', PickupMessage: { stores: [] } } });
  };

  try {
    const startedAt = Date.now();
    await room.alarm();
    const body = await (await room.fetch(new Request('https://room/state'))).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.observations.length, 1);
    assert.equal(body.observations[0].capacity, '512GB');
    assert.equal(body.available[0], 'MJYD4CH/A|R793');
    assert.ok(storage.alarmTime >= startedAt + 9_900);
    assert.ok(storage.alarmTime <= Date.now() + 10_100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed alarm backs off without watchdog overriding it', async () => {
  const { room, state, storage } = createRoom();
  await state.ready;
  seedCatalog(room);
  await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      regions: {
        cn: { enabled: true, location: '518000', store_numbers: ['R793'], part_numbers: ['MJYD4CH/A'] },
        hk: { enabled: false, location: '中環', store_numbers: [], part_numbers: [] },
      },
    }),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('HTTP 541'); };
  const started = Date.now();
  try {
    await room.alarm();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stateBody = await (await room.fetch(new Request('https://room/state'))).json();
  assert.equal(stateBody.status, 'query_failed');
  assert.equal(stateBody.poll_state, 'backoff');
  // The new per-region fetch path keeps the most informative per-region error
  // in the message log; the state.error may also fall back to a generic
  // counter string when multiple regions fail.
  const errorText = String(stateBody.error || '');
  assert.ok(/HTTP 541|中国大陆/.test(errorText) || /query operations failed/.test(errorText));
  assert.ok(storage.alarmTime >= started + 29_000);
  const backedOffAlarm = storage.alarmTime;

  await room.fetch(new Request('https://room/ensure-alarm', { method: 'POST' }));
  assert.equal(storage.alarmTime, backedOffAlarm);
});

test('web settings reject invalid region payload without changing saved state', async () => {
  const { room, state } = createRoom();
  await state.ready;
  const response = await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      regions: {
        cn: { enabled: true, location: '518000', store_numbers: [], part_numbers: ['MJYD4CH/A'] },
      },
    }),
  }));
  assert.equal(response.status, 400);
  const err = (await response.json()).error;
  assert.match(err, /at least one store when enabled|non-empty array/);
});

test('keyword alert fires for similar in-stock items matching the per-region keyword', async () => {
  const { room, state } = createRoom();
  await state.ready;
  seedCatalog(room);
  await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      regions: {
        cn: { enabled: true, location: '518000', store_numbers: ['R793'], part_numbers: ['MJYD4CH/A'], keyword_alert: 'Pro,Pro Max,1TB' },
        hk: { enabled: false, location: '中環', store_numbers: [], part_numbers: [] },
      },
    }),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('pickup-message?') && !u.includes('recommendations')) {
      return Response.json({ body: { stores: [] } });
    }
    if (u.includes('recommendations')) {
      return Response.json({
        body: {
          noSimilarModelsText: '',
          PickupMessage: {
            stores: [{
              storeNumber: 'R793',
              storeName: '前海壹方城',
              city: '深圳',
              partsAvailability: {
                'MJTJ4CH/A': {
                  pickupDisplay: 'available',
                  pickupSearchQuote: '今日可取货',
                  partNumber: 'MJTJ4CH/A',
                  messageTypes: { regular: { storePickupProductTitle: 'iPhone 18 Pro Max 1TB 银色', storePickupQuote: '今天 · Apple 前海壹方城' } },
                },
              },
            }],
          },
        },
      });
    }
    return Response.json({});
  };

  try {
    await room.alarm();
    const similar = await (await room.fetch(new Request('https://room/similar'))).json();
    assert.equal(similar.total_probed, 1);
    assert.equal(similar.total_available, 1);
    assert.equal(similar.keyword_hits.length, 1);
    assert.equal(similar.keyword_hits[0].region, 'cn');
    assert.match(similar.keyword_hits[0].title, /Pro Max 1TB/);
    assert.equal(similar.keyword_hits[0].keyword, 'Pro Max');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default settings include both regions', () => {
  const settings = defaultMonitorSettings();
  assert.ok(settings.regions.cn);
  assert.ok(settings.regions.hk);
});
