/**
 * Web-only monitor settings.
 *
 * The Worker no longer reads Cloudflare Variables for monitor configuration.
 * All store and product selections are entered in the dashboard and persisted
 * inside the Durable Object.  This module only owns validation, the seed
 * values used the first time the dashboard is opened, and the catalogue
 * helpers exposed to the UI.
 */

export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 86400;
export const DEFAULT_INTERVAL_SECONDS = 120;
export const DEFAULT_LOCATION = '518000';
export const MAX_PART_NUMBERS = 250;
export const MAX_STORE_NUMBERS = 250;

// First-run defaults keep the dashboard functional before the user picks
// anything.  The default Shenzhen stores and iPhone 18 Pro Max SKUs are
// re-used as starter values; once the user saves a new selection the durable
// settings object replaces these defaults entirely.
export const SEED_STORE_NUMBERS = ['R761', 'R484', 'R793'];
export const SEED_PART_NUMBERS = [
  'MJY84CH/A',
  'MJY94CH/A',
  'MJY74CH/A',
  'MJYD4CH/A',
  'MJYE4CH/A',
  'MJYC4CH/A',
];

export function defaultMonitorSettings() {
  return {
    interval_seconds: DEFAULT_INTERVAL_SECONDS,
    location: DEFAULT_LOCATION,
    store_numbers: [...SEED_STORE_NUMBERS],
    part_numbers: [...SEED_PART_NUMBERS],
  };
}

export function normalizeMonitorSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('settings must be a JSON object');
  }

  const intervalSeconds = Number(input.interval_seconds);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new Error(
      `interval_seconds must be an integer from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`,
    );
  }

  const location = String(input.location || '').trim();
  if (!location) throw new Error('location cannot be empty');

  const storeNumbers = normalizeSelection(input.store_numbers, 'store_numbers', MAX_STORE_NUMBERS);
  const partNumbers = normalizeSelection(input.part_numbers, 'part_numbers', MAX_PART_NUMBERS);

  return {
    interval_seconds: intervalSeconds,
    location,
    store_numbers: storeNumbers,
    part_numbers: partNumbers,
  };
}

export function buildMonitorConfig(settings = defaultMonitorSettings()) {
  const normalized = normalizeMonitorSettings(settings);
  return {
    settings: normalized,
    intervalSeconds: normalized.interval_seconds,
    pollSeconds: normalized.interval_seconds,
    location: normalized.location,
    storeNumbers: normalized.store_numbers,
    parts: normalized.part_numbers,
    products: [], // products are filled in by room.js from the live catalogue
    stores: [],   // stores are filled in by room.js from the live store list
    sourceUrl: 'https://www.apple.com.cn/shop/buy-iphone',
  };
}

function normalizeSelection(value, fieldName, maxCount) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  if (value.length > maxCount) {
    throw new Error(`${fieldName} cannot contain more than ${maxCount} values`);
  }
  const values = value.map((item) => String(item || '').trim());
  if (values.some((item) => !item)) {
    throw new Error(`${fieldName} cannot contain empty values`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${fieldName} values must be unique`);
  }
  return values;
}
