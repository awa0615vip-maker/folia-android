import type { OnlineMusicProvider, QrLoginState } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { proxyNativeRemoteAudioUrl } from '../nativeRemoteAudio';
import { QISHUI_PROVIDER_ID } from './qishuiConstants';
import {
    cancelQrLogin,
    createQrLogin,
    clearQishuiSession,
    fetchTrackPlayInfo,
    getProfile,
    getQishuiTransportAvailability,
    getQrCheckDiagnosticLines,
    pollQrLogin,
    resultGroup,
    searchAll,
    sendSmsCode,
    smsLogin,
} from './qishuiTransport';
import { normalizeQishuiSong, normalizeQishuiUser, qishuiPage } from './qishuiNormalize';

// src/services/onlineMusic/qishuiProvider.ts
// 汽水音乐（字节 Luna PC）音源。仅实现「扫码登录自己账号 → 搜索 → 播放账号有权限的明文音源」。
// 第一版不做 CENC 加密音源（spade_a）解密，也不做任何会员绕过；加密歌给出明确提示，后续版本再支持。

// 扫码流程 Folia 分两步（getQrKey / createQr），而汽水 get_qrcode 一次返回 token + 二维码，
// 这里把二维码图片按 token 缓存，供 createQr 取回。
const qrImageByToken = new Map<string, string>();

// 汽水搜索用不透明字符串 cursor 翻页，而 Folia 是数字 offset：按关键词缓存「下一页 cursor」。
const cursorByQuery = new Map<string, { offset: number; nextCursor: string }>();

const mapQrState = (state: Awaited<ReturnType<typeof pollQrLogin>>): QrLoginState => {
    switch (state.state) {
        case 'waiting':
            return { state: 'waiting' };
        case 'scanned':
            return { state: 'scanned' };
        case 'confirmed':
            return { state: 'confirmed' };
        case 'expired':
            return { state: 'expired' };
        default:
            return { state: 'error', message: state.message };
    }
};

export const qishuiProvider: OnlineMusicProvider = {
    id: QISHUI_PROVIDER_ID,
    displayName: '汽水音乐',
    shortName: '汽水',
    getAvailability: getQishuiTransportAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: false,
        auth: true,
        userLibrary: false,
        playlists: false,
        albums: false,
        artists: false,
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
    },
    normalizeSong: normalizeQishuiSong,
    normalizeUser: normalizeQishuiUser,
    songMetadata: { getSongMetadata: createProviderSongMetadata },

    search: {
        async searchSongs(query, limit, offset) {
            const keyword = query.trim();
            if (!keyword) return qishuiPage([], offset, limit, false);
            // 首页 cursor=0；后续页用缓存的不透明 next_cursor。
            let cursor = '0';
            if (offset > 0) {
                const cached = cursorByQuery.get(keyword);
                if (cached && cached.offset === offset && cached.nextCursor) cursor = cached.nextCursor;
            }
            const payload = await searchAll(keyword, cursor);
            const group = resultGroup(payload, 'tracks');
            const rawItems: unknown[] = Array.isArray(group?.data) ? group.data : [];
            const pageSize = limit > 0 ? limit : 20;
            const songs = rawItems
                .map((item: any) => {
                    try {
                        return normalizeQishuiSong(item.entity ?? item);
                    } catch {
                        return null;
                    }
                })
                .filter((song): song is NonNullable<typeof song> => song !== null)
                .slice(0, pageSize);
            const nextCursor = group?.next_cursor ? String(group.next_cursor) : '';
            if (nextCursor) {
                cursorByQuery.set(keyword, { offset: offset + songs.length, nextCursor });
            } else {
                cursorByQuery.delete(keyword);
            }
            return qishuiPage(songs, offset, limit, Boolean(group?.has_more && nextCursor));
        },
    },

    playback: {
        // 搜索结果已带完整元数据，缓存 / 历史里的歌曲也持久化了 UnifiedSong，
        // 第一版没有「仅凭 ID 恢复」的可靠单曲目接口，返回 null 交由上层兜底。
        async getSongDetail() {
            return null;
        },
        async getAudioSource(song, quality) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== QISHUI_PROVIDER_ID) {
                throw new OnlineProviderError('unsupported', '该歌曲不属于汽水音乐', QISHUI_PROVIDER_ID);
            }
            const { playInfo } = await fetchTrackPlayInfo(source.mediaId, quality);
            if (!playInfo?.url) {
                throw new OnlineProviderError(
                    'not-playable',
                    '汽水音乐没有返回可播放的音源（可能需要登录或会员，或该曲暂不支持）',
                    QISHUI_PROVIDER_ID,
                );
            }
            // CENC 加密音源（spade_a）：第一版不做整曲解密，明确提示而不是假装可播。
            if (playInfo.playAuth) {
                throw new OnlineProviderError(
                    'not-playable',
                    '该歌曲为加密无损音源，当前版本暂不支持，将在后续版本中提供',
                    QISHUI_PROVIDER_ID,
                );
            }
            const fetchedAt = Date.now();
            const proxied = await proxyNativeRemoteAudioUrl(playInfo.url);
            return {
                url: proxied,
                fetchedAt,
                // 火山 CDN 签名地址有有效期，保守标记 2 小时，过期重新取链。
                expiresAt: fetchedAt + 2 * 60 * 60 * 1000,
                quality,
            };
        },
        getAvailability() {
            // 汽水没有经过核实的「下架」独立信号，播放限制一律交给运行时判定（unknown）。
            return { state: 'unknown' };
        },
    },

    auth: {
        getLoginStatus: () => getProfile(),
        async logout() {
            clearQishuiSession();
        },
        async getQrKey() {
            const { token, imageUrl } = await createQrLogin();
            qrImageByToken.set(token, imageUrl);
            return token;
        },
        async createQr(key) {
            const imageUrl = qrImageByToken.get(key);
            if (!imageUrl) {
                // 极端情况下会话被清，重新要码。
                const fresh = await createQrLogin();
                qrImageByToken.set(fresh.token, fresh.imageUrl);
                return fresh.imageUrl;
            }
            return imageUrl;
        },
        checkQr: async key => mapQrState(await pollQrLogin(key)),
        async cancelQr(key) {
            qrImageByToken.delete(key);
            cancelQrLogin(key);
        },
        getQrTtlMs: () => 5 * 60 * 1000,
        async getQrLoginDiagnostics() {
            return getQrCheckDiagnosticLines();
        },
        sendSmsCode: (mobile: string) => sendSmsCode(mobile),
        smsLogin: (mobile: string, code: string, mobileTicket?: string) => smsLogin(mobile, code, mobileTicket),
    },
};
