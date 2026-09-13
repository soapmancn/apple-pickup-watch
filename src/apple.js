/**
 * Apple CN + HK catalog and pickup client.
 *
 * Both regions share the same JSON shape; the base URL and part suffix differ:
 *   CN: https://www.apple.com.cn/shop/{buy-iphone|retail/pickup-message|pickup-message-recommendations}
 *   HK: https://www.apple.com/hk-zh/shop/...
 *
 * Exposed helpers:
 *   listRegions()                       — [{id, label, ...}]
 *   getRegion(id)                       — full region object
 *   fetchFamilyProducts(region, slug)
 *   fetchAllFamilyProducts(region)
 *   searchProducts(region, query)
 *   fetchAppleStores(region, location)
 *   fetchPickupObservations(region, config)
 *   fetchSimilarAvailability(region, config)
 *
 * No authentication required; responses are gzip JSON (or HTML for the
 * buy-iphone family pages).
 */

const REGIONS = [
  {
    id: 'cn',
    label: '中国大陆',
    default_location: '518000',
    pickup_url: 'https://www.apple.com.cn/shop/retail/pickup-message',
    recommendations_url: 'https://www.apple.com.cn/shop/pickup-message-recommendations',
    family_base: 'https://www.apple.com.cn/shop/buy-iphone',
    search_url: 'https://www.apple.com.cn/shop/searchresults/internalmvc',
    part_suffix: 'CH/A',
    locale: 'zh-CN,zh;q=0.9',
    purchase_base: 'https://www.apple.com.cn/shop/buy-iphone',
    family_slugs: [
      'iphone-18-pro',
      'iphone-air',
      'iphone-17',
      'iphone-17e',
      'iphone-16',
    ],
    family_labels: {
      'iphone-18-pro': 'iPhone 18 Pro / Pro Max',
      'iphone-air': 'iPhone Air',
      'iphone-17': 'iPhone 17',
      'iphone-17e': 'iPhone 17e',
      'iphone-16': 'iPhone 16',
    },
  },
  {
    id: 'hk',
    label: '香港',
    default_location: '中環',
    pickup_url: 'https://www.apple.com/hk-zh/shop/retail/pickup-message',
    recommendations_url: 'https://www.apple.com/hk-zh/shop/pickup-message-recommendations',
    family_base: 'https://www.apple.com/hk-zh/shop/buy-iphone',
    search_url: 'https://www.apple.com/hk-zh/shop/searchresults/internalmvc',
    part_suffix: 'ZA/A',
    locale: 'zh-HK,zh;q=0.9',
    purchase_base: 'https://www.apple.com/hk-zh/shop/buy-iphone',
    family_slugs: [
      'iphone-18-pro',
      'iphone-air',
      'iphone-17',
      'iphone-17e',
      'iphone-16',
    ],
    family_labels: {
      'iphone-18-pro': 'iPhone 18 Pro / Pro Max',
      'iphone-air': 'iPhone Air',
      'iphone-17': 'iPhone 17',
      'iphone-17e': 'iPhone 17e',
      'iphone-16': 'iPhone 16',
    },
  },
];

const FAMILY_TTL_MS = 1000 * 60 * 60 * 12;
const STORE_TTL_MS = 1000 * 60 * 60 * 6;

const familyCache = new Map();   // `${region}|${slug}` -> { products, expiresAt }
const storeCache = new Map();    // `${region}|${location}` -> { stores, expiresAt }
const storesByNumber = new Map(); // `${region}|${store_number}` -> store

const DISCOVERY_PART = {
  cn: 'MJY84CH/A',
  hk: 'MJXW4ZA/A',
};

export function listRegions() {
  return REGIONS.map((region) => ({ ...region }));
}

export function getRegion(id) {
  return REGIONS.find((region) => region.id === id) || null;
}

export function familyLabel(regionId, slug) {
  const region = getRegion(regionId);
  if (!region) return slug;
  return region.family_labels[slug] || slug;
}

export async function fetchFamilyProducts(regionId, slug, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const cacheKey = `${regionId}|${slug}`;
  const cached = familyCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.products;

  const url = `${region.family_base}/${slug}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': region.locale,
      'Accept-Encoding': 'gzip, br',
    },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${regionId}/${slug}: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const html = await decodeHtml(buffer);
  const products = parseFamilyProducts(html, region, slug);
  familyCache.set(cacheKey, { products, expiresAt: now + FAMILY_TTL_MS });
  return products;
}

export async function fetchAllFamilyProducts(regionId, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const all = [];
  for (const slug of region.family_slugs) {
    try {
      const items = await fetchFamilyProducts(regionId, slug, fetchImpl);
      for (const item of items) all.push(item);
    } catch (err) {
      console.warn(`skip ${regionId}/${slug}`, err.message || err);
    }
  }
  return all;
}

export async function fetchAppleStores(regionId, location, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const key = String(location || '').trim() || region.default_location;
  const cacheKey = `${regionId}|${key}`;
  const cached = storeCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.stores;

  const url = `${region.pickup_url}?location=${encodeURIComponent(key)}&parts.0=${encodeURIComponent(DISCOVERY_PART[regionId])}`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': region.locale,
      'Referer': region.family_base,
    },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${regionId} stores: HTTP ${response.status}`);
  }
  const data = await response.json();
  const stores = parseStores(data, regionId);
  for (const store of stores) storesByNumber.set(`${regionId}|${store.store_number}`, store);
  storeCache.set(cacheKey, { stores, expiresAt: now + STORE_TTL_MS });
  return stores;
}

export function getKnownStore(regionId, storeNumber) {
  return storesByNumber.get(`${regionId}|${storeNumber}`) || null;
}

export async function fetchPickupObservations(regionId, config, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  if (!config || !config.parts || !config.parts.length) return [];
  if (!config.storeNumbers || !config.storeNumbers.length) return [];

  const location = String(config.location || '').trim() || region.default_location;
  const params = new URLSearchParams();
  params.set('location', location);
  config.parts.forEach((part, index) => params.set(`parts.${index}`, part));

  const response = await fetchImpl(`${region.pickup_url}?${params.toString()}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': region.locale,
      'Referer': region.family_base,
    },
  });
  if (!response.ok) {
    throw new Error(`pickup-message ${regionId} HTTP ${response.status}`);
  }
  const data = await response.json();
  return parseObservations(data, config, regionId);
}

export async function fetchSimilarAvailability(regionId, config, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  if (!config || !config.parts || !config.parts.length) return [];
  if (!config.storeNumbers || !config.storeNumbers.length) return [];
  const productMap = new Map((config.products || []).map((p) => [p.part_number, p]));

  const results = [];
  for (const part of config.parts) {
    for (const storeNumber of config.storeNumbers) {
      const url = new URL(region.recommendations_url);
      url.searchParams.set('fae', 'true');
      url.searchParams.set('searchNearby', 'true');
      url.searchParams.set('mts.0', 'regular');
      url.searchParams.set('mts.1', 'compact');
      url.searchParams.set('store', storeNumber);
      url.searchParams.set('product', part);
      try {
        const response = await fetchImpl(url.toString(), {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json,text/plain,*/*',
            'Accept-Language': region.locale,
            'Referer': region.family_base,
          },
        });
        if (!response.ok) {
          results.push({
            region: regionId,
            part_number: part,
            store_number: storeNumber,
            error: `HTTP ${response.status}`,
            similar: [],
          });
          continue;
        }
        const data = await response.json();
        results.push(parseSimilarAvailability(data, part, storeNumber, productMap, regionId));
      } catch (err) {
        results.push({
          region: regionId,
          part_number: part,
          store_number: storeNumber,
          error: String(err.message || err),
          similar: [],
        });
      }
    }
  }
  return results;
}

export async function searchProducts(regionId, query, fetchImpl = fetch) {
  const region = getRegion(regionId);
  if (!region) throw new Error(`unknown region ${regionId}`);
  const term = String(query || '').trim();
  if (!term) return await fetchAllFamilyProducts(regionId, fetchImpl);

  const url = `${region.search_url}?find=${encodeURIComponent(term)}&sel=explore&src=aos&tab=explore`;
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': region.locale,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${region.family_base}/search`,
    },
  });
  if (!response.ok) throw new Error(`search ${regionId} HTTP ${response.status}`);
  const data = await response.json();
  const slugs = extractFamilySlugs(data, region);
  const products = [];
  for (const slug of slugs) {
    try {
      const items = await fetchFamilyProducts(regionId, slug, fetchImpl);
      for (const item of items) products.push(item);
    } catch (err) {
      console.warn(`skip search ${regionId}/${slug}`, err.message || err);
    }
  }
  return products;
}

// --- Parsing helpers ---------------------------------------------------

function parseFamilyProducts(html, region, slug) {
  const suffix = region.part_suffix.toLowerCase();
  const regex = new RegExp(
    `<a\\s+href="https?:\\/\\/(?:www\\.)?apple\\.com(?:\\.cn)?\\/(?:hk-zh\\/)?shop\\/buy-iphone\\/[^"]+\\/([a-z0-9]{6,12}${suffix.replace('/', '\\/')})"[^>]*data-slot-name="productSelection"[^>]*>([\\s\\S]*?)<\\/a>`,
    'gi',
  );
  const products = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(html)) !== null) {
    const partNumber = match[1].toUpperCase();
    if (seen.has(partNumber)) continue;
    const block = match[2];
    const capacity = cleanCapacity(extractSpan(block, 'dimensionCapacity'));
    const color = cleanText(extractSpan(block, 'dimensionColor'));
    const price = cleanPrice(extractSpan(block, 'current_price'));
    if (!capacity || !color) continue;
    seen.add(partNumber);
    products.push({
      part_number: partNumber,
      region: region.id,
      family: slug,
      model: region.family_labels[slug] || slug,
      capacity,
      color,
      price,
      purchase_url: `${region.purchase_base}/${slug}/${partNumber.toLowerCase()}/a`,
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

function parseStores(data, regionId) {
  const list = data?.body?.stores;
  if (!Array.isArray(list)) return [];
  const stores = [];
  for (const store of list) {
    if (!store || !store.storeNumber) continue;
    stores.push({
      region: regionId,
      store_number: store.storeNumber,
      store_name: store.storeName || store.storeNumber,
      city: store.city || '',
      state: store.state || '',
      address: store.address || '',
    });
  }
  return stores;
}

function parseObservations(data, config, regionId) {
  const list = data?.body?.stores;
  if (!Array.isArray(list)) return [];
  const stores = new Map();
  for (const store of list) {
    if (!store || !store.storeNumber) continue;
    stores.set(store.storeNumber, {
      region: regionId,
      store_number: store.storeNumber,
      store_name: store.storeName || store.storeNumber,
      city: store.city || '',
      state: store.state || '',
      address: store.address || '',
    });
  }
  const configuredStores = new Map(
    config.storeNumbers.map((sn) => [sn, stores.get(sn) || getKnownStore(regionId, sn) || { region: regionId, store_number: sn, store_name: sn }]),
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
        region: regionId,
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
  if (observations.length === 0) {
    for (const part of config.parts) {
      const product = configuredProducts.get(part) || {};
      for (const sn of config.storeNumbers) {
        const store = configuredStores.get(sn);
        observations.push({
          region: regionId,
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

function parseSimilarAvailability(data, part, storeNumber, productMap, regionId) {
  const block = data?.body?.PickupMessage;
  const noSimilar = data?.body?.noSimilarModelsText;
  const stores = Array.isArray(block?.stores) ? block.stores : [];
  const similar = [];
  for (const store of stores) {
    const availability = store.partsAvailability || {};
    for (const [similarPart, item] of Object.entries(availability)) {
      if (!item || item.pickupDisplay !== 'available') continue;
      const regular = item.messageTypes?.regular || {};
      const title = regular.storePickupProductTitle || '';
      const quote = regular.storePickupQuote || item.pickupSearchQuote || '';
      const modelMeta = productMap.get(similarPart) || {};
      similar.push({
        region: regionId,
        part_number: similarPart,
        title,
        pickup_quote: quote,
        pickup_display: item.pickupDisplay,
        model: modelMeta.model || extractModelFromTitle(title),
        capacity: modelMeta.capacity || extractCapacityFromTitle(title),
        color: modelMeta.color || extractColorFromTitle(title),
      });
    }
  }
  return {
    region: regionId,
    part_number: part,
    store_number: storeNumber,
    no_similar_text: noSimilar || '',
    similar,
  };
}

function extractModelFromTitle(title) {
  const m = String(title || '').match(/iPhone[^\d]*?(?=\s*\d+(?:\.\d+)?\s*(?:TB|GB)\b|$)/i);
  return m ? m[0].replace(/\u00a0/g, ' ').trim() : '';
}

function extractCapacityFromTitle(title) {
  const m = String(title || '').match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : '';
}

function extractColorFromTitle(title) {
  const stripped = String(title || '')
    .replace(/^iPhone[^\d]*?(?=\s*\d)/i, '')
    .replace(/\d+(?:\.\d+)?\s*(?:TB|GB)/i, '')
    .replace(/\u00a0/g, ' ')
    .trim();
  return stripped;
}

function extractFamilySlugs(data, region) {
  const body = data?.body;
  if (!body) return [];
  const slugs = new Set();
  const regex = /\/shop\/buy-iphone\/([a-z0-9-]+)/gi;
  const haystack = JSON.stringify(body);
  let m;
  while ((m = regex.exec(haystack)) !== null) {
    if (region.family_slugs.includes(m[1])) slugs.add(m[1]);
  }
  return [...slugs];
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Safari/605.1.15';

async function decodeHtml(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (text.includes('<a')) return text;
  } catch (err) { /* fall through to gzip */ }
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
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}
