// public/folia-cover-sw.js
// Serves validated content-addressed local cover files directly from OPFS.

const COVER_PATH_PREFIX = '/__folia_cover/';
const ASSET_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;
const THUMBNAIL_SIZES = new Set([512, 1024]);
const thumbnailJobs = new Map();
const thumbnailQueue = [];
let activeThumbnailJobs = 0;
const ALLOWED_MIME_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const parseThumbnailSize = (requestUrl) => {
  const value = Number(requestUrl.searchParams.get('size'));
  return Number.isInteger(value) && THUMBNAIL_SIZES.has(value) ? value : null;
};

// Keeps first-use full-resolution decodes bounded while protocol requests wait asynchronously.
const scheduleThumbnailJob = (task) => new Promise((resolve, reject) => {
  const run = async () => {
    activeThumbnailJobs += 1;
    try {
      resolve(await task());
    } catch (error) {
      reject(error);
    } finally {
      activeThumbnailJobs -= 1;
      thumbnailQueue.shift()?.();
    }
  };
  if (activeThumbnailJobs < 2) void run();
  else thumbnailQueue.push(() => void run());
});

// Generates one content-addressed derivative and closes decoded bitmap memory immediately.
const getOrCreateThumbnail = async (directory, digest, sourceFile, requestedSize) => {
  const thumbnailName = `${digest}.bin.${requestedSize}.webp`;
  try {
    return await directory.getFileHandle(thumbnailName).then(handle => handle.getFile());
  } catch {
    // Continue with lazy generation.
  }

  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const jobKey = `${digest}:${requestedSize}`;
  const existingJob = thumbnailJobs.get(jobKey);
  if (existingJob) return await existingJob;

  const job = scheduleThumbnailJob(async () => {
    const bitmap = await createImageBitmap(sourceFile);
    try {
      const scale = Math.min(1, requestedSize / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1) return null;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const thumbnail = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      if (!thumbnail || thumbnail.size <= 0) return null;
      const handle = await directory.getFileHandle(thumbnailName, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(thumbnail);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      return await handle.getFile();
    } finally {
      bitmap.close();
    }
  }).finally(() => thumbnailJobs.delete(jobKey));
  thumbnailJobs.set(jobKey, job);
  return await job;
};

const getCoverResponse = async (requestUrl) => {
  let assetId;
  try {
    assetId = decodeURIComponent(requestUrl.pathname.slice(COVER_PATH_PREFIX.length));
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const match = ASSET_ID_PATTERN.exec(assetId);
  if (!match) return new Response('Bad request', { status: 400 });

  try {
    const root = await navigator.storage.getDirectory();
    const foliaRoot = await root.getDirectoryHandle('folia-cache');
    const directory = await foliaRoot.getDirectoryHandle('local-cover-assets');
    const [file, rawDescriptor] = await Promise.all([
      directory.getFileHandle(`${match[1]}.bin`).then(handle => handle.getFile()),
      directory.getFileHandle(`${match[1]}.json`).then(handle => handle.getFile()).then(value => value.text()),
    ]);
    const descriptor = JSON.parse(rawDescriptor);
    const mimeType = typeof descriptor?.mimeType === 'string' ? descriptor.mimeType.toLowerCase() : '';
    if (descriptor?.id !== assetId
      || !ALLOWED_MIME_TYPES.has(mimeType)
      || descriptor?.size !== file.size
      || file.size <= 0) {
      return new Response('Not found', { status: 404 });
    }
    const requestedSize = parseThumbnailSize(requestUrl);
    const thumbnail = requestedSize
      ? await getOrCreateThumbnail(directory, match[1], file, requestedSize).catch(() => null)
      : null;
    const responseFile = thumbnail || file;
    const responseMimeType = thumbnail ? 'image/webp' : mimeType;
    return new Response(responseFile.stream(), {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(responseFile.size),
        'Content-Type': responseMimeType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
};

// ===========================================================================
// 在线封面（网易云 / QQ / 酷狗 / 酷我 / Navidrome 等）持久化缓存
//
// 只拦截列表 / 网格 / 搜索 / 播放页实际请求的封面图片，做 Cache-First：
//   命中本地 -> 直接返回，不再请求网络（重启后秒开、弱网不白屏）；
//   未命中   -> 拉网络：
//               · 支持 CORS 的图床（网易云等）可读到真实字节，存入可读缓存，精确做
//                 约 200MB 的 LRU 淘汰；
//               · 不支持 CORS 的图床（QQ / 酷狗）只能拿到 opaque 响应，单独存一个很小
//                 的缓存、按条目数淘汰（opaque 读不到字节，不能按 MB 统计，浏览器还会
//                 按保守配额预留，所以严格限量）。
//
// 铁律：任何一步出错都回退到正常网络，绝不因为缓存让封面显示失败。
// 不改任何 URL、不改任何组件与外观，只在网络层拦截。
// ===========================================================================

const ONLINE_COVER_CACHE = 'folia-online-covers-v1';
const OPAQUE_COVER_CACHE = 'folia-online-covers-opaque-v1';
// 可读在线封面的目标上限（约 200MB）。
const ONLINE_COVER_BYTES_LIMIT = 200 * 1024 * 1024;
// opaque 响应无法读字节、浏览器还会按保守配额预留，只允许缓存少量（真实磁盘很小）。
const OPAQUE_COVER_MAX_ENTRIES = 120;

const IMAGE_EXT_PATTERN = /\.(?:jpe?g|png|webp|gif|bmp|avif|heic)(?:\?|#|$)/i;
const AUDIO_PATH_PATTERN = /\.(?:mp3|flac|m4a|ogg|aac|wma|wav)(?:\?|#|$)/i;
// 仅这些已知封面图床会被缓存，避免误拦 API / 音频。
const ONLINE_COVER_HOST_PATTERNS = [
  /^p\d{1,2}\.music\.126\.net$/i,
  /^y\.gtimg\.cn$/i,
  /^y\.qq\.com$/i,
  /(?:^|\.)(?:kugou\.com|kgimg\.com)$/i,
  /^img\d*\.kuwo\.cn$/i,
];

// 内存 LRU：key = 完整 URL，value = 可读响应真实字节（opaque 记 0）。
// Map 迭代顺序即插入顺序，访问时 delete + set 移到末尾，淘汰从头部开始。
const readableLru = new Map();
const opaqueLru = new Map();
let readableBytes = 0;
let lruRebuilt = false;

const isKnownCoverHost = (hostname) => ONLINE_COVER_HOST_PATTERNS.some(pattern => pattern.test(hostname));

const looksLikeCoverUrl = (url) => {
  const path = url.pathname;
  if (AUDIO_PATH_PATTERN.test(path) || /\/song\/(?:media|url|enchant)/i.test(path)) return false;
  if (IMAGE_EXT_PATTERN.test(path)) return true;
  // 网易云 ?param=512y512、Navidrome getCoverArt?size=、酷狗 /stdmusic/<size>/、QQ T001/T002...M000
  if (url.searchParams.has('param')) return true;
  if (path.includes('getCoverArt')) return true;
  if (/\/stdmusic\/\d+\//.test(path)) return true;
  if (/T00[12](?:R\d+x\d+)?M000/.test(path)) return true;
  return false;
};

const isOnlineCoverRequest = (url, request) => {
  if (request.method !== 'GET') return false;
  if (url.origin === self.location.origin) return false; // 同源交给本地封面逻辑
  return isKnownCoverHost(url.hostname) && looksLikeCoverUrl(url);
};

const isImageResponse = (response) => {
  if (!response) return false;
  const contentType = response.headers.get('content-type');
  return !!contentType && contentType.toLowerCase().startsWith('image/');
};

const touchLru = (lru, key) => {
  if (lru.has(key)) {
    const previous = lru.get(key) || 0;
    lru.delete(key);
    lru.set(key, previous);
  } else {
    lru.set(key, 0);
  }
};

// SW 重启后内存 LRU 为空，首次淘汰前从 Cache 重建一次（可读缓存读真实字节）。
const ensureLruRebuilt = async () => {
  if (lruRebuilt) return;
  lruRebuilt = true;
  try {
    const readable = await caches.open(ONLINE_COVER_CACHE);
    const readableRequests = await readable.keys();
    for (const request of readableRequests) {
      let size = 0;
      try {
        const response = await readable.match(request);
        if (response) size = (await response.blob()).size;
      } catch {
        // 不可读时按 0 计，后续按条目数兜底。
      }
      readableLru.set(request.url, size);
      readableBytes += size;
    }
    const opaque = await caches.open(OPAQUE_COVER_CACHE);
    const opaqueRequests = await opaque.keys();
    for (const request of opaqueRequests) opaqueLru.set(request.url, 0);
  } catch {
    // 缓存不可用时整体降级为普通网络请求。
  }
};

const trimReadableCache = async () => {
  try {
    await ensureLruRebuilt();
    const cache = await caches.open(ONLINE_COVER_CACHE);
    let guard = 0;
    while (readableBytes > ONLINE_COVER_BYTES_LIMIT && readableLru.size > 0 && guard < 10000) {
      guard += 1;
      const oldestKey = readableLru.keys().next().value;
      if (oldestKey === undefined) break;
      const size = readableLru.get(oldestKey) || 0;
      await cache.delete(oldestKey);
      readableLru.delete(oldestKey);
      readableBytes -= size;
    }
  } catch {
    // 淘汰失败不影响返回。
  }
};

const trimOpaqueCache = async () => {
  try {
    const cache = await caches.open(OPAQUE_COVER_CACHE);
    let guard = 0;
    while (opaqueLru.size > OPAQUE_COVER_MAX_ENTRIES && guard < 10000) {
      guard += 1;
      const oldestKey = opaqueLru.keys().next().value;
      if (oldestKey === undefined) break;
      await cache.delete(oldestKey);
      opaqueLru.delete(oldestKey);
    }
  } catch {
    // 同上。
  }
};

// 不支持 CORS 的图床（QQ / 酷狗）：保留页面的 no-cors 请求拿 opaque，命中 / 回源都兜底。
const serveOpaqueCover = async (event) => {
  const opaqueCache = await caches.open(OPAQUE_COVER_CACHE);
  const cached = await opaqueCache.match(event.request);
  if (cached) {
    touchLru(opaqueLru, event.request.url);
    return cached;
  }
  const response = await fetch(event.request);
  if (response && (response.type === 'opaque' || response.ok)) {
    const clone = response.clone();
    touchLru(opaqueLru, event.request.url);
    event.waitUntil((async () => {
      try {
        await opaqueCache.put(event.request, clone);
        await trimOpaqueCache();
      } catch {
        // 配额不足或不可写时静默忽略，封面仍正常返回。
      }
    })());
  }
  return response;
};

const serveOnlineCover = async (event) => {
  const readableCache = await caches.open(ONLINE_COVER_CACHE);
  const cached = await readableCache.match(event.request);
  if (cached) {
    touchLru(readableLru, event.request.url);
    return cached;
  }

  // Service Worker 可脱离页面的 no-cors 模式，主动用 CORS 重发。
  // 网易云等图床返回 Access-Control-Allow-Origin:*，能读到真实字节用于容量统计。
  try {
    const response = await fetch(event.request.url, { mode: 'cors', credentials: 'omit' });
    if (response.ok && response.type === 'cors' && isImageResponse(response)) {
      const blob = await response.blob();
      const responseInit = {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      };
      const size = blob.size;
      event.waitUntil((async () => {
        try {
          await readableCache.put(event.request, new Response(blob, responseInit));
          readableLru.set(event.request.url, size);
          readableBytes += size;
          await trimReadableCache();
        } catch {
          // 写盘失败不影响本次返回。
        }
      })());
      return new Response(blob, responseInit);
    }
  } catch {
    // CORS 被拒绝或网络失败，落入 opaque / 网络兜底。
  }

  return await serveOpaqueCover(event);
};

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // 同源本地封面：从 OPFS 直接提供（原有逻辑，保持不变）。
  if (url.origin === self.location.origin && url.pathname.startsWith(COVER_PATH_PREFIX)) {
    event.respondWith(getCoverResponse(url));
    return;
  }

  // 跨域在线封面：Cache-First 持久缓存；任何失败都回退普通网络。
  if (isOnlineCoverRequest(url, event.request)) {
    event.respondWith(
      serveOnlineCover(event).catch(() => fetch(event.request).catch(() => Response.error())),
    );
  }
});
