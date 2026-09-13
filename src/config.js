export const DEFAULT_CHECK_INTERVAL_MINUTES = 2;
export const DEFAULT_LOCATION = '518000';

export const DEFAULT_PRODUCTS = [
  { part_number: 'MJY84CH/A', model: 'iPhone 18 Pro Max', color: '勃艮第酒红色', capacity: '256GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy84ch/a' },
  { part_number: 'MJY94CH/A', model: 'iPhone 18 Pro Max', color: '冰川蓝色', capacity: '256GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy94ch/a' },
  { part_number: 'MJY74CH/A', model: 'iPhone 18 Pro Max', color: '银色', capacity: '256GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjy74ch/a' },
  { part_number: 'MJYD4CH/A', model: 'iPhone 18 Pro Max', color: '勃艮第酒红色', capacity: '512GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyd4ch/a' },
  { part_number: 'MJYE4CH/A', model: 'iPhone 18 Pro Max', color: '冰川蓝色', capacity: '512GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjye4ch/a' },
  { part_number: 'MJYC4CH/A', model: 'iPhone 18 Pro Max', color: '银色', capacity: '512GB', purchase_url: 'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyc4ch/a' },
];

export const DEFAULT_STORES = [
  { store_number: 'R761', store_name: '深圳万象城', city: '深圳', state: '广东', address: '深圳市罗湖区宝安南路 1881 号 深圳万象城（一期）B1 层' },
  { store_number: 'R484', store_name: '深圳益田假日广场', city: '深圳', state: '广东', address: '深圳市南山区深南大道 9028 号益田假日广场' },
  { store_number: 'R793', store_name: '前海壹方城', city: '深圳', state: '广东', address: '深圳市宝安区新湖路 99 号 前海壹方城 L1 层' },
];

export function getMonitorConfig(env = {}) {
  const intervalMinutes = parseInterval(env.CHECK_INTERVAL_MINUTES);
  const products = parseProducts(env.MONITOR_PRODUCTS_JSON);
  const stores = parseStores(env.MONITOR_STORES_JSON);
  const location = String(env.MONITOR_LOCATION || DEFAULT_LOCATION).trim();
  if (!location) throw new Error('MONITOR_LOCATION cannot be empty');

  return {
    intervalMinutes,
    pollSeconds: intervalMinutes * 60,
    location,
    products,
    stores,
    parts: products.map((product) => product.part_number),
    storeNumbers: stores.map((store) => store.store_number),
    sourceUrl: products.find((product) => product.purchase_url)?.purchase_url ||
      'https://www.apple.com.cn/shop/iphone',
  };
}

export function isScheduledCheckDue(scheduledTime, intervalMinutes) {
  const time = Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : Date.now();
  return Math.floor(time / 60_000) % intervalMinutes === 0;
}

function parseInterval(raw) {
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_CHECK_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error('CHECK_INTERVAL_MINUTES must be an integer from 1 to 1440');
  }
  return value;
}

function parseProducts(raw) {
  const input = parseJsonArray(raw, 'MONITOR_PRODUCTS_JSON', DEFAULT_PRODUCTS);
  const products = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`MONITOR_PRODUCTS_JSON item ${index + 1} must be an object`);
    }
    const partNumber = requiredString(item.part_number, `MONITOR_PRODUCTS_JSON item ${index + 1}.part_number`);
    return {
      part_number: partNumber,
      model: requiredString(item.model, `MONITOR_PRODUCTS_JSON item ${index + 1}.model`),
      capacity: requiredString(item.capacity, `MONITOR_PRODUCTS_JSON item ${index + 1}.capacity`),
      color: optionalString(item.color),
      purchase_url: optionalString(item.purchase_url),
    };
  });
  assertUnique(products.map((item) => item.part_number), 'MONITOR_PRODUCTS_JSON part_number');
  return products;
}

function parseStores(raw) {
  const input = parseJsonArray(raw, 'MONITOR_STORES_JSON', DEFAULT_STORES);
  const stores = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`MONITOR_STORES_JSON item ${index + 1} must be an object`);
    }
    return {
      store_number: requiredString(item.store_number, `MONITOR_STORES_JSON item ${index + 1}.store_number`),
      store_name: optionalString(item.store_name),
      city: optionalString(item.city),
      state: optionalString(item.state),
      address: optionalString(item.address),
    };
  });
  assertUnique(stores.map((item) => item.store_number), 'MONITOR_STORES_JSON store_number');
  return stores;
}

function parseJsonArray(raw, variableName, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback.map((item) => ({ ...item }));
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error(`${variableName} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${variableName} must be a non-empty JSON array`);
  }
  return parsed;
}

function requiredString(value, fieldName) {
  const text = optionalString(value);
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

function optionalString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function assertUnique(values, fieldName) {
  if (new Set(values).size !== values.length) throw new Error(`${fieldName} values must be unique`);
}
