import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../src/room.js';

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

function seedCatalog(room, products = [], stores = []) {
  room.catalogue.products = products;
  room.catalogue.productsAt = Date.now();
  room.catalogue.stores = stores;
  room.catalogue.storesAt = Date.now();
}

test('web settings persist and reschedule the alarm immediately', async () => {
  const { room, state, storage } = createRoom();
  await state.ready;
  const before = await (await room.fetch(new Request('https://room/settings'))).json();
  assert.equal(before.settings.interval_seconds, 120);

  seedCatalog(room, [
    { part_number: 'MJYD4CH/A', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '勃艮第酒红色' },
  ], [
    { store_number: 'R793', store_name: '前海壹方城', city: '深圳' },
  ]);

  const startedAt = Date.now();
  const response = await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      location: '518000',
      store_numbers: ['R793'],
      part_numbers: ['MJYD4CH/A'],
    }),
  }));
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.settings.interval_seconds, 10);
  assert.deepEqual(updated.settings.store_numbers, ['R793']);
  assert.deepEqual(updated.settings.part_numbers, ['MJYD4CH/A']);

  const saved = await storage.get('monitor-state-v1');
  assert.equal(saved.settings.interval_seconds, 10);
  assert.ok(storage.alarmTime >= startedAt + 900);
  assert.ok(storage.alarmTime <= Date.now() + 2_000);

  const stateBody = await (await room.fetch(new Request('https://room/state'))).json();
  assert.equal(stateBody.poll_seconds, 10);
  assert.equal(stateBody.stores[0].store_name, '前海壹方城');
  assert.equal(stateBody.variants[0].capacity, '512GB');
});

test('alarm uses saved web settings and schedules the next second-level check', async () => {
  const { room, state, storage } = createRoom();
  await state.ready;
  seedCatalog(room, [
    { part_number: 'MJYD4CH/A', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '勃艮第酒红色' },
  ], [
    { store_number: 'R793', store_name: '前海壹方城', city: '深圳' },
  ]);
  await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      location: '518000',
      store_numbers: ['R793'],
      part_numbers: ['MJYD4CH/A'],
    }),
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
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
  seedCatalog(room, [
    { part_number: 'MJYD4CH/A', model: 'iPhone 18 Pro Max', capacity: '512GB', color: '勃艮第酒红色' },
  ], [
    { store_number: 'R793', store_name: '前海壹方城', city: '深圳' },
  ]);
  await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      location: '518000',
      store_numbers: ['R793'],
      part_numbers: ['MJYD4CH/A'],
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
  assert.match(stateBody.error, /30 秒后重试/);
  assert.ok(storage.alarmTime >= started + 29_000);
  const backedOffAlarm = storage.alarmTime;

  await room.fetch(new Request('https://room/ensure-alarm', { method: 'POST' }));
  assert.equal(storage.alarmTime, backedOffAlarm);
});

test('web settings reject empty selections without changing saved state', async () => {
  const { room, state } = createRoom();
  await state.ready;
  const response = await room.fetch(new Request('https://room/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interval_seconds: 10,
      location: '518000',
      store_numbers: [],
      part_numbers: ['MJYD4CH/A'],
    }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /non-empty array/);
});
