import { getCacheEntriesByPrefix, removeFromCache } from './db';
import { getSongResourceCacheKey, type SongResourceKind } from './onlineMusic/resourceKeys';
import { readEffectiveTier } from '../stores/usePerformanceTierStore';
import type { SongResult } from '../types';

// src/services/audioCachePrune.ts
//
// 安卓 / WebView 端音频缓存（IndexedDB `media_cache` 里的 `audio_` 条目）原本没有容量上限：
// 桌面端（Electron）走文件缓存，写入时由主进程按设置上限裁剪，而安卓分支只是 `saveToCache`，
// 会一直堆积直到 WebView 配额耗尽。这里给安卓端补上与设备内存档位挂钩的容量上限 + LRU 淘汰：
// 超过上限时删掉“最久没再写入”的音频，直到回落到上限的 90%。
//
// 播放过的歌在 fade out / 播完时会被重新写回（见 playedTrackCache.ts），它的 timestamp 因此刷新；
// 提前下载但还没听的歌 timestamp 最新。于是 timestamp 升序天然就是“最久没听”的顺序，无需额外维护
// 一份最近播放列表。

const MB = 1024 * 1024;
const AUDIO_KEY_PREFIX: SongResourceKind = 'audio';

/** 各性能档位的音频缓存上限（字节）。低端档收窄，避免低端机 ROM / 配额被缓存挤爆。 */
const TIER_LIMIT_BYTES: Record<'low' | 'balanced' | 'high', number> = {
    low: 250 * MB,
    balanced: 600 * MB,
    high: 1200 * MB,
};

/** 即使档位给得很宽，也不占用浏览器存储配额的比例超过这个值（给封面 / 歌词 / 其他数据留空间）。 */
const QUOTA_SHARE = 0.35;

/** 回落到上限的 90%，避免每次写入都卡在临界点反复删除。 */
const TARGET_RATIO = 0.9;

/** 两次裁剪之间的最小间隔（毫秒），防止连写几首歌就全表扫描一次。 */
const PRUNE_THROTTLE_MS = 20_000;

const isElectronAudioCache = (): boolean =>
    Boolean(
        typeof window !== 'undefined'
        && window.electron
        && typeof window.electron.getAudioCache === 'function'
        && typeof window.electron.saveAudioCache === 'function'
    );

/** 读取浏览器给当前源的存储配额（字节）；拿不到返回 null。 */
const readStorageQuota = async (): Promise<number | null> => {
    try {
        if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
        const estimate = await navigator.storage.estimate();
        if (typeof estimate.quota === 'number' && estimate.quota > 0) return estimate.quota;
        return null;
    } catch {
        return null;
    }
};

/**
 * 音频缓存上限：档位值与“配额 × 占比”取较小者。
 *
 * 低端机的真实瓶颈往往是 ROM 总容量而非运行内存，浏览器 quota 已经折算过剩余可用空间，
 * 所以用 quota 兜底比单纯看 navigator.deviceMemory 更贴近“还能存多少”。
 */
export const getAudioCacheLimitBytes = async (): Promise<number> => {
    const tierLimit = TIER_LIMIT_BYTES[readEffectiveTier()] ?? TIER_LIMIT_BYTES.balanced;
    const quota = await readStorageQuota();
    if (quota == null) return tierLimit;
    return Math.min(tierLimit, Math.floor(quota * QUOTA_SHARE));
};

/** 计算某个音频缓存 key 的大小：IndexedDB 里直接存的是 Blob，读它的 size 即可。 */
const entryByteSize = (data: unknown): number => {
    if (data instanceof Blob) return data.size;
    return 0;
};

let lastPruneAt = 0;
let pruneInFlight = false;

/**
 * 立刻执行一次裁剪（无视节流）。返回删掉的字节数。供测试或需要确定性收敛时调用。
 *
 * @param protectKeys 这些 key 即使最旧也不删（例如当前播放 / 即将播放的歌）。
 */
export const pruneAudioCacheNow = async (protectKeys: Set<string> = new Set()): Promise<number> => {
    // 桌面端文件缓存由主进程裁剪，这里只在安卓 / WebView 端运行。
    if (isElectronAudioCache()) return 0;

    const entries = await getCacheEntriesByPrefix<Blob>(`${AUDIO_KEY_PREFIX}_`);
    if (entries.length === 0) return 0;

    let totalBytes = 0;
    for (const entry of entries) totalBytes += entryByteSize(entry.data);

    const limit = await getAudioCacheLimitBytes();
    if (totalBytes <= limit) return 0;

    const targetBytes = Math.floor(limit * TARGET_RATIO);

    // timestamp 升序 = 最久没写入的在前，优先删除；受保护的 key 跳过。
    const oldestFirst = entries
        .filter(entry => !protectKeys.has(entry.key))
        .sort((a, b) => a.timestamp - b.timestamp);

    let reclaimed = 0;
    for (const entry of oldestFirst) {
        if (totalBytes - reclaimed <= targetBytes) break;
        try {
            await removeFromCache(entry.key);
            reclaimed += entryByteSize(entry.data);
        } catch (error) {
            console.warn('[AudioCachePrune] Failed to remove an old audio entry', entry.key, error);
        }
    }

    if (reclaimed > 0) {
        console.log(`[AudioCachePrune] Reclaimed ${Math.round(reclaimed / MB)}MB (limit ${Math.round(limit / MB)}MB)`);
    }
    return reclaimed;
};

/**
 * 非阻塞、带节流地触发一次裁剪。写入音频后调用：永远不 await，失败也不影响保存。
 *
 * 用一个 in-flight 标志避免连写期间堆积多个并发扫描。
 */
export const touchAudioCachePrune = (): void => {
    if (isElectronAudioCache()) return;
    const now = Date.now();
    if (pruneInFlight || now - lastPruneAt < PRUNE_THROTTLE_MS) return;

    pruneInFlight = true;
    lastPruneAt = now;
    void pruneAudioCacheNow()
        .catch(error => console.warn('[AudioCachePrune] Prune pass failed', error))
        .finally(() => {
            pruneInFlight = false;
        });
};

/**
 * 生成“当前播放 + 即将播放”的受保护 key 集合，裁剪时不删这些歌。
 * 可选使用；预下载窗口内的歌一般 timestamp 已足够新，常规裁剪删不到它们。
 */
export const buildProtectedAudioKeys = (songs: Array<SongResult | null | undefined>): Set<string> => {
    const keys = new Set<string>();
    for (const song of songs) {
        if (song) keys.add(getSongResourceCacheKey('audio', song));
    }
    return keys;
};
