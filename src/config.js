/**
 * Web-only monitor settings.
 *
 * The Worker no longer reads Cloudflare Variables for monitor configuration.
 * All store and product selections are entered in the dashboard and persisted
 * inside the Durable Object.  Each Apple region (currently `cn` and `hk`) has
 * its own set of part numbers, store numbers and keyword alert; the
 * Dashboard keeps everything in one `regions` object.
 *
 * This module owns validation, the seed values used the first time the
 * dashboard is opened, and the catalogue helpers exposed to the UI.
 */

export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 86400;
export const DEFAULT_INTERVAL_SECONDS = 120;
export const MAX_PART_NUMBERS = 250;
export const MAX_STORE_NUMBERS = 250;
export const MAX_KEYWORD_TERMS = 20;

export const REGIONS = [
  {
    id: 'cn',
    label: '中国大陆',
    default_location: '518000',
    pickup_url: 'https://www.apple.com.cn/shop/retail/pickup-message',
    recommendations_url: 'https://www.apple.com.cn/shop/pickup-message-recommendations',
    family_path: 'https://www.apple.com.cn/shop/buy-iphone',
    part_suffix: 'CH/A',
    locale: 'zh-CN,zh;q=0.9',
    purchase_base: 'https://www.apple.com.cn/shop/buy-iphone',
  },
  {
    id: 'hk',
    label: '香港',
    default_location: '中環',
    pickup_url: 'https://www.apple.com/hk-zh/shop/retail/pickup-message',
    recommendations_url: 'https://www.apple.com/hk-zh/shop/pickup-message-recommendations',
    family_path: 'https://www.apple.com/hk-zh/shop/buy-iphone',
    part_suffix: 'ZA/A',
    locale: 'zh-HK,zh;q=0.9',
    purchase_base: 'https://www.apple.com/hk-zh/shop/buy-iphone',
  },
];

export const SEED_REGION_PART_NUMBERS = {
  cn: [
    'MJY84CH/A', 'MJY94CH/A', 'MJY74CH/A',
    'MJYD4CH/A', 'MJYE4CH/A', 'MJYC4CH/A',
  ],
  hk: [],
};
export const SEED_REGION_STORE_NUMBERS = {
  cn: ['R761', 'R484', 'R793'],
  hk: [],
};
export const SEED_REGION_KEYWORD_ALERT = {
  cn: '',
  hk: '',
};
export const SEED_REGION_LOCATION = Object.fromEntries(
  REGIONS.map((region) => [region.id, region.default_location]),
);

export function getRegion(id) {
  return REGIONS.find((region) => region.id === id) || null;
}

export function defaultMonitorSettings() {
  const regions = {};
  for (const region of REGIONS) {
    regions[region.id] = {
      enabled: region.id === 'cn',
      location: region.default_location,
      store_numbers: [...(SEED_REGION_STORE_NUMBERS[region.id] || [])],
      part_numbers: [...(SEED_REGION_PART_NUMBERS[region.id] || [])],
      keyword_alert: SEED_REGION_KEYWORD_ALERT[region.id] || '',
    };
  }
  return {
    interval_seconds: DEFAULT_INTERVAL_SECONDS,
    regions,
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

  const incoming = (input.regions && typeof input.regions === 'object' && !Array.isArray(input.regions))
    ? input.regions
    : null;
  const regions = {};
  for (const region of REGIONS) {
    const seed = {
      enabled: region.id === 'cn',
      location: region.default_location,
      store_numbers: [...(SEED_REGION_STORE_NUMBERS[region.id] || [])],
      part_numbers: [...(SEED_REGION_PART_NUMBERS[region.id] || [])],
      keyword_alert: SEED_REGION_KEYWORD_ALERT[region.id] || '',
    };
    const raw = incoming && Object.prototype.hasOwnProperty.call(incoming, region.id)
      ? incoming[region.id]
      : null;
    if (!raw || typeof raw !== 'object') {
      regions[region.id] = seed;
      continue;
    }
    const location = String(raw.location ?? seed.location).trim();
    if (!location) throw new Error(`${region.id}.location cannot be empty`);
    const enabled = raw.enabled === undefined ? !!seed.enabled : Boolean(raw.enabled);
    const storeNumbers = normalizeSelection(raw.store_numbers, `${region.id}.store_numbers`, MAX_STORE_NUMBERS);
    const partNumbers = normalizeSelection(raw.part_numbers, `${region.id}.part_numbers`, MAX_PART_NUMBERS);
    if (enabled && storeNumbers.length === 0) {
      throw new Error(`${region.id}.store_numbers must contain at least one store when enabled`);
    }
    if (enabled && partNumbers.length === 0) {
      throw new Error(`${region.id}.part_numbers must contain at least one part when enabled`);
    }
    regions[region.id] = {
      enabled,
      location,
      store_numbers: storeNumbers,
      part_numbers: partNumbers,
      keyword_alert: normalizeKeywordAlert(raw.keyword_alert, `${region.id}.keyword_alert`),
    };
  }
  return { interval_seconds: intervalSeconds, regions };
}

export function buildMonitorConfig(settings = defaultMonitorSettings()) {
  const normalized = normalizeMonitorSettings(settings);
  const regions = REGIONS.map((region) => {
    const r = normalized.regions[region.id];
    const tokens = String(r.keyword_alert || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      id: region.id,
      label: region.label,
      enabled: r.enabled,
      location: r.location,
      storeNumbers: r.store_numbers,
      parts: r.part_numbers,
      keywordAlert: r.keyword_alert,
      keywordTokens: tokens,
      products: [],
      stores: [],
      sourceUrl: region.pickup_url,
      recommendationsUrl: region.recommendations_url,
      purchaseBase: region.purchase_base,
      partSuffix: region.part_suffix,
      locale: region.locale,
    };
  });
  return {
    settings: normalized,
    intervalSeconds: normalized.interval_seconds,
    pollSeconds: normalized.interval_seconds,
    regions,
  };
}

function normalizeSelection(value, fieldName, maxCount) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  if (value.length > maxCount) throw new Error(`${fieldName} cannot contain more than ${maxCount} values`);
  const values = value.map((item) => String(item || '').trim());
  if (values.some((item) => !item)) throw new Error(`${fieldName} cannot contain empty values`);
  if (new Set(values).size !== values.length) throw new Error(`${fieldName} values must be unique`);
  return values;
}

function normalizeKeywordAlert(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '') return '';
  // Multi-word keywords (e.g. "Pro Max") are allowed.  Split only on user
  // chosen separators: comma, semicolon and their full-width siblings.
  // Spaces are preserved inside each keyword.
  const tokens = String(raw)
    .split(/[,,;；，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length > MAX_KEYWORD_TERMS) {
    throw new Error(`${fieldName} cannot contain more than ${MAX_KEYWORD_TERMS} terms`);
  }
  const seen = new Set();
  const unique = [];
  for (const token of tokens) {
    if (!seen.has(token)) { seen.add(token); unique.push(token); }
  }
  return unique.join(' | ');
}
