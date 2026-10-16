// src/services/onlineCoverCache.ts
//
// 页面端访问在线封面 Service Worker 缓存（folia-cover-sw.js）的统计与清理接口。
// 命名与 SW 内的两个 Cache 保持一致：
//   · folia-online-covers-v1        —— 支持 CORS 的图床（网易云等），可读真实字节
//   · folia-online-covers-opaque-v1 —— 不支持 CORS 的图床（QQ/酷狗）的 opaque 响应，只能数条目
//
// 仅用于设置面板显示占用与一键清除；图片请求本身完全由 SW 拦截，页面不感知。

const ONLINE_COVER_CACHE = 'folia-online-covers-v1';
const OPAQUE_COVER_CACHE = 'folia-online-covers-opaque-v1';

export interface OnlineCoverCacheUsage {
  /** 可读在线封面的真实字节数（opaque 部分无法计入）。 */
  bytes: number;
  /** 可读在线封面的图片张数。 */
  readableCount: number;
  /** opaque 在线封面的图片张数（QQ / 酷狗）。 */
  opaqueCount: number;
  /** 总条目数（可读 + opaque）。 */
  totalCount: number;
}

const hasCacheApi = (): boolean => typeof caches !== 'undefined' && typeof caches.open === 'function';

const measureReadableCache = async (): Promise<{ bytes: number; count: number }> => {
  const cache = await caches.open(ONLINE_COVER_CACHE);
  const requests = await cache.keys();
  let bytes = 0;
  for (const request of requests) {
    try {
      const response = await cache.match(request);
      if (response) bytes += (await response.blob()).size;
    } catch {
      // 个别条目读取失败不影响整体统计。
    }
  }
  return { bytes, count: requests.length };
};

const countOpaqueCache = async (): Promise<number> => {
  const cache = await caches.open(OPAQUE_COVER_CACHE);
  const requests = await cache.keys();
  return requests.length;
};

export const getOnlineCoverCacheUsage = async (): Promise<OnlineCoverCacheUsage> => {
  if (!hasCacheApi()) {
    return { bytes: 0, readableCount: 0, opaqueCount: 0, totalCount: 0 };
  }
  try {
    const [readable, opaqueCount] = await Promise.all([
      measureReadableCache(),
      countOpaqueCache(),
    ]);
    return {
      bytes: readable.bytes,
      readableCount: readable.count,
      opaqueCount,
      totalCount: readable.count + opaqueCount,
    };
  } catch {
    return { bytes: 0, readableCount: 0, opaqueCount: 0, totalCount: 0 };
  }
};

export const clearOnlineCoverCache = async (): Promise<void> => {
  if (!hasCacheApi()) return;
  await Promise.all([
    caches.delete(ONLINE_COVER_CACHE).catch(() => undefined),
    caches.delete(OPAQUE_COVER_CACHE).catch(() => undefined),
  ]);
};
