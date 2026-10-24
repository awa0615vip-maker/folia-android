import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderErrorCode } from '../../../types/onlineMusic';
import type { QishuiOperation, QishuiParams, QishuiBridgeResult } from 'qishui-music-api';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import {
    clearQishuiSession,
    importQishuiCookie,
    getProfile,
    searchAll,
    resultGroup,
    fetchTrackPlayInfo,
} from './qishuiAndroidTransport';
import { normalizeQishuiSong } from './qishuiNormalize';

// Typed renderer boundary for the car bridge; credentials and player models stay in the main process.
export type { QishuiOperation, QishuiParams, QishuiBridgeResult } from 'qishui-music-api';
// What a request fails with where this page has no desktop bridge (the web build), and where the bridge
// itself failed (the main process threw). qishuiFailure.ts tells both apart by them.
export const QISHUI_NEEDS_DESKTOP = 'Qishui requires the desktop app';
export const QISHUI_BRIDGE_FAILED = 'Qishui desktop request failed';
const STAGES = ['access-code', 'ticket', 'account'] as const;
export type QishuiLoginStage = typeof STAGES[number];
// The last failure of a sign-in operation (login_*), for the sign-in diagnostics. Other requests made
// while signing in (lyrics, radio, covers) are not the sign-in's, and are not kept here.
let lastFailure: { stage: QishuiLoginStage | null; code: ProviderErrorCode; upstreamCode?: string } | null = null;
export const getQishuiLastFailure = () => lastFailure;
const isLoginOperation = (operation: QishuiOperation) => operation.startsWith('login_');
export class QishuiRequestError extends OnlineProviderError {
    constructor(code: ProviderErrorCode, message: string, public readonly stage: QishuiLoginStage | null, public readonly upstreamCode?: string) {
        super(code, message, 'qishui');
    }
}

// ─── Android native web login promise ─────────────────────────────────────
let nativeLoginPromise: Promise<{ ok: boolean; cookie?: string; message?: string }> | null = null;
const NATIVE_LOGIN_KEY = 'native-web-login';

function getNativePlugin(): any | null {
    const capacitor = (window as any).Capacitor;
    return capacitor?.Plugins?.FoliaNative ?? null;
}

function startNativeWebLogin(): Promise<{ ok: boolean; cookie?: string; message?: string }> {
    if (nativeLoginPromise) return nativeLoginPromise;
    const plugin = getNativePlugin();
    if (!plugin || typeof plugin.openQishuiWebLogin !== 'function') {
        return Promise.resolve({ ok: false, message: '原生登录插件不可用' });
    }
    nativeLoginPromise = plugin.openQishuiWebLogin({})
        .then((res: any) => {
            const cookie = res?.cookie ?? '';
            if (cookie) return { ok: true, cookie };
            return { ok: false, message: res?.message ?? '登录已取消' };
        })
        .catch((err: any) => ({ ok: false, message: String(err?.message ?? err) }))
        .finally(() => {
            // 保留结果一小段时间供 checkLogin 轮询拿到，然后清空
            setTimeout(() => { nativeLoginPromise = null; }, 5000);
        });
    // .finally 返回的 Promise 可能是 null 值联合，这里显式声明返回类型
    return nativeLoginPromise as Promise<{ ok: boolean; cookie?: string; message?: string }>;
}

export const getQishuiAvailability = () => {
    if (IS_ANDROID_WEBVIEW) return { configured: true } as const;
    return typeof window !== 'undefined' && typeof (window as any).electron?.qishuiRequest === 'function'
        ? { configured: true } as const : { configured: false, reason: 'runtime-unavailable' } as const;
};

async function requestQishuiAndroid<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    switch (operation) {
        case 'login_qr_key': {
            lastFailure = null;
            // 直接拉起原生内置登录WebView，用户扫码后自动获取cookie
            startNativeWebLogin();
            return NATIVE_LOGIN_KEY as unknown as T;
        }
        case 'login_qr_create': {
            // 原生页面已经展示二维码，这里返回一个1x1透明占位图，UI会被原生登录页遮挡
            const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            return { imageUrl: transparentPng } as unknown as T;
        }
        case 'login_qr_check': {
            if (!nativeLoginPromise) {
                // 没有进行中的登录，等待中
                return { state: 'waiting' } as unknown as T;
            }
            const result = await nativeLoginPromise;
            if (result.ok && result.cookie) {
                const importResult = await importQishuiCookie(result.cookie);
                if (importResult.ok) {
                    return { state: 'confirmed' } as unknown as T;
                }
                lastFailure = { stage: 'account', code: 'invalid-response', upstreamCode: undefined };
                return { state: 'error', transient: false, failure: { case: 'account-not-read' } } as unknown as T;
            }
            if (result.message?.includes('取消')) {
                return { state: 'expired' } as unknown as T;
            }
            return { state: 'waiting' } as unknown as T;
        }
        case 'login_qr_cancel': {
            nativeLoginPromise = null;
            return undefined as unknown as T;
        }
        case 'login_status': {
            const user = await getProfile();
            return user as unknown as T;
        }
        case 'logout': {
            clearQishuiSession();
            return undefined as unknown as T;
        }
        case 'search': {
            const query = String(params.query ?? '');
            const offset = Number(params.offset ?? 0);
            const limit = Number(params.limit ?? 20);
            const cursor = offset === 0 ? '0' : String(offset);
            const payload = await searchAll(query, cursor);
            const group = resultGroup(payload, 'tracks');
            const rawItems: unknown[] = Array.isArray(group?.data) ? group.data : [];
            const items = rawItems
                .map((item: any) => {
                    try { return normalizeQishuiSong(item.entity ?? item); }
                    catch { return null; }
                })
                .filter((s): s is NonNullable<typeof s> => s !== null)
                .slice(0, limit);
            const hasMore = Boolean(group?.next_cursor);
            return { items, hasMore, nextOffset: hasMore ? offset + items.length : offset } as unknown as T;
        }
        case 'audio': {
            const trackId = String(params.id ?? params.trackId ?? '');
            const qualityPreference = (params.quality as any) ?? 'standard';
            const info = await fetchTrackPlayInfo(trackId, qualityPreference);
            if (!info.playInfo?.url) {
                throw new OnlineProviderError('not-playable', '该歌曲暂时无法播放（可能为VIP/加密音源）', 'qishui');
            }
            return {
                url: info.playInfo.url,
                quality: 'standard',
                fetchedAt: Date.now(),
                preview: false,
            } as unknown as T;
        }
        case 'lyrics': {
            // 旧版暂未实现歌词，返回空让上层走自动匹配歌词
            return null as unknown as T;
        }
        // 以下高级功能（歌单/收藏/推荐/Feed等）安卓首版暂返回空，不报错不崩溃
        case 'user_playlists':
        case 'playlist_tracks':
        case 'playlist_detail':
        case 'artist_detail':
        case 'artist_songs':
        case 'liked_songs':
        case 'recent_played':
        case 'feed':
        case 'feed_modes':
        case 'search_playlists':
        case 'song_detail':
        case 'check_tracks': {
            return { items: [], hasMore: false, nextOffset: 0 } as unknown as T;
        }
        case 'like_song':
        case 'dislike_song':
        case 'playlist_add_tracks':
        case 'playlist_remove_tracks': {
            return { ok: true } as unknown as T;
        }
        default:
            throw new OnlineProviderError('unsupported', `安卓端暂不支持该操作: ${operation}`, 'qishui');
    }
}

export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (operation === 'login_qr_key') lastFailure = null;
    if (!getQishuiAvailability().configured) throw new OnlineProviderError('unavailable', QISHUI_NEEDS_DESKTOP, 'qishui');

    // Android 原生适配路径
    if (IS_ANDROID_WEBVIEW) {
        try {
            return await requestQishuiAndroid<T>(operation, params);
        } catch (error) {
            if (error instanceof OnlineProviderError) throw error;
            if (isLoginOperation(operation)) {
                lastFailure = { stage: 'account', code: 'network', upstreamCode: undefined };
            }
            throw new OnlineProviderError('network', QISHUI_BRIDGE_FAILED, 'qishui', error);
        }
    }

    // 桌面 Electron 路径（保持上游官方逻辑）
    let result: QishuiBridgeResult;
    try { result = await (window as any).electron!.qishuiRequest(operation, params); }
    catch (error) { throw new OnlineProviderError('network', QISHUI_BRIDGE_FAILED, 'qishui', error); }
    if (!result.ok) {
        const stage = STAGES.find(st => st === result.error.stage) ?? null;
        const upstreamCode = typeof result.error.upstreamCode === 'string' && /^\d{1,12}$/.test(result.error.upstreamCode) ? result.error.upstreamCode : undefined;
        if (isLoginOperation(operation)) lastFailure = { stage, code: result.error.code, upstreamCode };
        throw new QishuiRequestError(result.error.code, result.error.message, stage, upstreamCode);
    }
    return result.data as T;
}

// The image type the bytes themselves say, for the formats a scene icon comes in; null when they say none of them.
function sniffImageType(bytes: Uint8Array): string | null {
    const starts = (...head: number[]) => head.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return null;
}
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

// Scene artwork is public CDN content; it is fetched without any account headers or cookies.
// The data URL carries the image's own type: the CDN's template decides the format, not the address.
export async function readQishuiSceneIcon(raw: string): Promise<string> {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !/(?:^|\.)douyinpic\.com$/.test(url.hostname) || url.username || url.password) {
        throw new Error('Invalid scene artwork URL');
    }
    const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) });
    const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !declared.startsWith('image/')) throw new Error('Scene artwork is unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 512 * 1024) throw new Error('Scene artwork is too large');
    const type = sniffImageType(bytes) ?? (RASTER_TYPES.has(declared) ? declared : null);
    if (!type) throw new Error('Scene artwork is not a raster image');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${type};base64,${btoa(binary)}`;
}
