/**
 * Apple CN catalog and pickup-message client.
 *
 * - `fetchFamilyProducts(familySlug)` scrapes an Apple buy-iphone family page
 *   (e.g. `iphone-18-pro`) to enumerate every current SKU (part_number +
 *   capacity + colour + price + purchase_url).  The page itself is a gzipped
 *   HTML document returned by www.apple.com.cn and contains `<a href="...
 *   /shop/buy-iphone/<family>/<part>/a">` blocks with `dimensionCapacity`,
 *   `dimensionColor` and `current_price` spans.  No authentication required.
 * - `fetchAppleStores(location)` calls the existing public pickup-message
 *   endpoint with a single known part number and any location/邮编; Apple
 *   responds with the nearby store list regardless of the parts passed, so we
 *   can use it to discover stores in any city.
 * - `fetchPickupObservations(config)` returns the filtered observations for the
 *   user-selected parts × stores at the user-selected location.
 */

const FAMILY_SLUGS = [
  'iphone-18-pro',
  'iphone-air',
  'iphone-17',
  'iphone-17e',
  'iphone-16',
];

const FAMILY_LABELS = {
  'iphone-18-pro': 'iPhone 18 Pro / Pro Max',
  'iphone-air': 'iPhone Air',
  'iphone-17': 'iPhone 17',
  'iphone-17e': 'iPhone 17e',
  'iphone-16': 'iPhone 16',
};

const PICKUP_URL = 'https://www.apple.com.cn/shop/retail/pickup-message';
const FAMILY_URL = (slug) => `https://www.apple.com.cn/shop/buy-iphone/${slug}`;
const SEARCH_URL = 'https://www.apple.com.cn/shop/searchresults/internalmvc';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Safari/605.1.15';

const FAMILY_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const STORE_TTL_MS = 1000 * 60 * 60 * 6;   // 6h

const familyCache = new Map();   // slug -> { products, expiresAt }
const storeCache = new Map();    // location -> { stores, expiresAt }
const storesByNumber = new Map(); // store_number -> store object

const DISCOVERY_PART = 'MJY84CH/A'; // any valid iPhone 18 Pro part; helps Apple return nearby stores

export function listFamilySlugs() {
  return [...FAMILY_SLUGS];
}

export function familyLabel(slug) {
  return FAMILY_LABELS[slug] || slug;
}

export async function fetchFamilyProducts(slug, fetchImpl = fetch) {
  const cached = familyCache.get(slug);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.products;

  const response = await fetchImpl(FAMILY_URL(slug), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, br',
    },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${slug}: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const html = await decodeHtml(buffer);
  const products = parseFamilyProducts(html, slug);
  familyCache.set(slug, { products, expiresAt: now + FAMILY_TTL_MS });
  return products;
}

export async function fetchAllFamilyProducts(fetchImpl = fetch) {
  const all = [];
  for (const slug of FAMILY_SLUGS) {
    try {
      const items = await fetchFamilyProducts(slug, fetchImpl);
      for (const item of items) all.push(item);
    } catch (err) {
      console.warn('skip family', slug, err.message || err);
    }
  }
  return all;
}

export async function fetchAppleStores(location, fetchImpl = fetch) {
  const key = String(location || '').trim() || '518000';
  const cached = storeCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.stores;

  const url = `${PICKUP_URL}?location=${encodeURIComponent(key)}&parts.0=${encodeURIComponent(DISCOVERY_PART)}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.apple.com.cn/shop/buy-iphone',
    },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch stores: HTTP ${response.status}`);
  }
  const data = await response.json();
  const stores = parseStores(data);
  for (const store of stores) storesByNumber.set(store.store_number, store);
  storeCache.set(key, { stores, expiresAt: now + STORE_TTL_MS });
  return stores;
}

export function getKnownStore(storeNumber) {
  return storesByNumber.get(storeNumber) || null;
}

export async function fetchPickupObservations(config, fetchImpl = fetch) {
  if (!config || !config.parts || !config.parts.length) return [];
  if (!config.storeNumbers || !config.storeNumbers.length) return [];

  const location = String(config.location || '').trim() || '518000';
  const params = new URLSearchParams();
  params.set('location', location);
  config.parts.forEach((part, index) => params.set(`parts.${index}`, part));

  const response = await fetchImpl(`${PICKUP_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.apple.com.cn/shop/buy-iphone',
    },
  });
  if (!response.ok) {
    throw new Error(`pickup-message HTTP ${response.status}`);
  }
  const data = await response.json();
  return parseObservations(data, config);
}

export async function searchProducts(query, fetchImpl = fetch) {
  const term = String(query || '').trim();
  if (!term) return await fetchAllFamilyProducts(fetchImpl);

  const url = `${SEARCH_URL}?find=${encodeURIComponent(term)}&sel=explore&src=aos&tab=explore`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.apple.com.cn/shop/search',
    },
  });
  if (!response.ok) throw new Error(`search HTTP ${response.status}`);
  const data = await response.json();
  const slugs = extractFamilySlugs(data);
  const products = [];
  for (const slug of slugs) {
    try {
      const items = await fetchFamilyProducts(slug, fetchImpl);
      for (const item of items) products.push(item);
    } catch (err) {
      console.warn('skip search family', slug, err.message || err);
    }
  }
  return products;
}

export async function searchStores(query, fetchImpl = fetch) {
  const term = String(query || '').trim();
  if (!term) return [];
  // Apple does not expose a public store-directory search; we use pickup-message
  // with the user-typed location to return the nearest stores.  Empty locations
  // simply reuse the cache.
  try {
    return await fetchAppleStores(term, fetchImpl);
  } catch (err) {
    console.warn('store search failed', err.message || err);
    return [];
  }
}

// --- Parsing helpers ---------------------------------------------------

function parseFamilyProducts(html, slug) {
  const regex = /<a\s+href="https:\/\/www\.apple\.com\.cn\/shop\/buy-iphone\/[^"]+\/([A-Z0-9]{6,12}CH\/A)"[^>]*data-slot-name="productSelection"[^>]*>([\s\S]*?)<\/a>/gi;
  const products = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const partNumber = match[1];
    if (seen.has(partNumber)) continue;
    const block = match[2];
    const capacity = cleanCapacity(extractSpan(block, 'dimensionCapacity'));
    const color = cleanText(extractSpan(block, 'dimensionColor'));
    const price = cleanPrice(extractSpan(block, 'current_price'));
    if (!capacity || !color) continue;
    seen.add(partNumber);
    products.push({
      part_number: partNumber,
      family: slug,
      model: FAMILY_LABELS[slug] || slug,
      capacity,
      color,
      price,
      purchase_url: `https://www.apple.com.cn/shop/buy-iphone/${slug}/${partNumber.toLowerCase()}/a`,
    });
  }
  return products;
}

function extractSpan(block, className) {
  const m = block.match(new RegExp(`<span class="${className}">([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? m[1] : '';
}

function cleanCapacity(raw) {
  const text = String(raw || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
  const m = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : '';
}

function cleanPrice(raw) {
  const text = String(raw || '').replace(/<[^>]+>/g, '').trim();
  return text || '';
}

function cleanText(raw) {
  return String(raw || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
}

function parseStores(data) {
  const list = data?.body?.stores;
  if (!Array.isArray(list)) return [];
  const stores = [];
  for (const store of list) {
    if (!store || !store.storeNumber) continue;
    stores.push({
      store_number: store.storeNumber,
      store_name: store.storeName || store.storeNumber,
      city: store.city || '',
      state: store.state || '',
      address: store.address || '',
    });
  }
  return stores;
}

function parseObservations(data, config) {
  const list = data?.body?.stores;
  if (!Array.isArray(list)) return [];
  const stores = new Map();
  for (const store of list) {
    if (!store || !store.storeNumber) continue;
    stores.set(store.storeNumber, {
      store_number: store.storeNumber,
      store_name: store.storeName || store.storeNumber,
      city: store.city || '',
      state: store.state || '',
      address: store.address || '',
    });
  }
  const configuredStores = new Map(
    config.storeNumbers.map((sn) => [sn, stores.get(sn) || storesByNumber.get(sn) || { store_number: sn, store_name: sn }]),
  );
  const configuredProducts = new Map(
    config.products.map((p) => [p.part_number, p]),
  );
  const observations = [];
  for (const store of list || []) {
    if (!store || !store.storeNumber) continue;
    if (!configuredStores.has(store.storeNumber)) continue;
    const availability = store.partsAvailability || {};
    for (const part of config.parts) {
      const item = availability[part];
      if (!item) continue;
      const product = configuredProducts.get(part) || {};
      observations.push({
        part_number: part,
        store_number: store.storeNumber,
        store_name: store.storeName,
        city: store.city || '',
        model: product.model || '',
        capacity: product.capacity || '',
        color: product.color || '',
        purchase_url: product.purchase_url || '',
        pickup_display: item.pickupDisplay || '',
        pickup_quote: item.pickupSearchQuote || '',
        pickup_quote_value: item.pickupSearchQuoteValue,
      });
    }
  }
  // Also emit "unavailable" observations for configured products that Apple
  // did not return at all, so the dashboard can show a complete grid.
  if (observations.length === 0) {
    for (const part of config.parts) {
      const product = configuredProducts.get(part) || {};
      for (const sn of config.storeNumbers) {
        const store = configuredStores.get(sn);
        observations.push({
          part_number: part,
          store_number: sn,
          store_name: store?.store_name || sn,
          city: store?.city || '',
          model: product.model || '',
          capacity: product.capacity || '',
          color: product.color || '',
          purchase_url: product.purchase_url || '',
          pickup_display: 'unavailable',
          pickup_quote: '暂无库存数据',
          pickup_quote_value: null,
        });
      }
    }
  }
  return observations;
}

function extractFamilySlugs(data) {
  const body = data?.body;
  if (!body) return [];
  const slugs = new Set();
  const regex = /\/shop\/buy-iphone\/([a-z0-9-]+)/gi;
  const haystack = JSON.stringify(body);
  let m;
  while ((m = regex.exec(haystack)) !== null) {
    if (FAMILY_SLUGS.includes(m[1])) slugs.add(m[1]);
  }
  return [...slugs];
}

async function decodeHtml(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (text.includes('<a')) return text;
  } catch (err) {
    /* fall through to gzip */
  }
  try {
    const stream = new DecompressionStream('gzip');
    const decompressed = stream.pipeThrough(new TextDecoderStream('utf-8'));
    const writer = decompressed.writable.getWriter();
    writer.write(new Uint8Array(buffer));
    writer.close();
    let text = '';
    const reader = decompressed.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    return text;
  } catch (err) {
    // DecompressionStream unavailable; return utf-8 attempt as best effort.
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}
