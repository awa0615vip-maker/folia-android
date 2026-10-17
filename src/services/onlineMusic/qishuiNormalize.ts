// src/services/onlineMusic/qishuiNormalize.ts
// 把汽水音乐（Luna PC）原始响应归一化成 Folia 的统一歌曲 / 用户模型。

import type { Artist, UnifiedSong } from '../../types';
import type { JsonValue, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { QISHUI_PROVIDER_ID } from './qishuiConstants';

type AnyRecord = Record<string, any>;
const asRecord = (value: unknown): AnyRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
);
const text = (value: unknown): string => (value == null ? '' : String(value));

/** 汽水 / 字节封面对象 → 可直接访问的图片 URL。 */
export function coverFromUrlCover(urlCover: unknown): string | undefined {
    if (!urlCover || typeof urlCover !== 'object') return undefined;
    const u = urlCover as AnyRecord;
    const first = Array.isArray(u.urls) ? String(u.urls[0] ?? '') : '';
    const uri = String(u.uri ?? '');
    if (/^https?:\/\//i.test(first) && (!uri || first.includes(uri) || first.includes('?'))) {
        return first || undefined;
    }
    if (!first && !uri) return undefined;
    let cover = first.includes(uri) ? first : `${first}${uri}`;
    if (cover && !cover.includes('~') && !cover.includes('?')) {
        cover += '~tplv-b829550vbb-crop-center:500:500.jpg';
    }
    return cover || undefined;
}

const artistsOf = (track: AnyRecord): Artist[] => {
    const list = Array.isArray(track.artists) ? track.artists : [];
    return list
        .filter((a: any) => a?.name)
        .map((a: any): Artist => ({
            id: a.id != null ? String(a.id) : '',
            name: String(a.name),
            ...(a.id != null ? { catalogRef: { providerId: QISHUI_PROVIDER_ID, kind: 'artist', id: String(a.id) } } : {}),
        }));
};

/** 从搜索聚合分组 item 或裸 track 中解出 track 对象。 */
const unwrapTrack = (raw: unknown): AnyRecord => {
    const entity = asRecord(raw);
    return asRecord(
        entity.track
        ?? entity.track_wrapper?.track
        ?? entity.entity?.track
        ?? entity.entity?.track_wrapper?.track
        ?? raw,
    );
};

export const normalizeQishuiSong = (raw: unknown): UnifiedSong => {
    const item = asRecord(raw);
    // 已归一化过的缓存歌曲直接放行。
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === QISHUI_PROVIDER_ID) {
        return item as UnifiedSong;
    }
    const track = unwrapTrack(raw);
    const id = String(track.id ?? track.track_id ?? '');
    if (!id) throw new OnlineProviderError('invalid-response', '汽水音乐歌曲缺少 id', QISHUI_PROVIDER_ID);

    const label = asRecord(track.label_info ?? track.labelInfo);
    const isVip = Boolean(label.only_vip_playable ?? label.is_vip ?? label.only_vip_download ?? track.is_vip);
    const albumId = track.album?.id != null ? String(track.album.id) : '';

    const data: Record<string, JsonValue> = {};
    if (isVip) data.qishuiVip = true;

    const durationRaw = track.duration ?? track.duration_ms;
    const durationMs = durationRaw == null
        ? 0
        : Number(durationRaw) > 10_000
            ? Number(durationRaw)
            : Math.round(Number(durationRaw) * 1000);

    return {
        id,
        name: text(track.name ?? track.title ?? id),
        artists: artistsOf(track),
        album: {
            id: albumId,
            name: text(track.album?.name),
            coverUrl: coverFromUrlCover(track.album?.url_cover ?? track.url_cover),
            ...(albumId ? { catalogRef: { providerId: QISHUI_PROVIDER_ID, kind: 'album', id: albumId } } : {}),
        },
        durationMs: Math.max(0, durationMs),
        sourceRef: {
            kind: 'online',
            providerId: QISHUI_PROVIDER_ID,
            mediaId: id,
            providerData: data,
        },
    };
};

export const normalizeQishuiUser = (raw: unknown): ProviderUser => {
    const item = asRecord(raw);
    return {
        id: String(item.id ?? item.user_id ?? ''),
        nickname: text(item.nickname ?? item.public_name ?? item.id),
        avatarUrl: coverFromUrlCover(item.larger_avatar_url ?? item.medium_avatar_url ?? item.avatar_url ?? item.avatar),
        ...(item.vip_info?.is_vip ?? item.is_vip ? { vipType: 1 } : {}),
    };
};

/** 统一分页：汽水 search/all 用 cursor 翻页，这里换算成 Folia 的 offset 模型。 */
export const qishuiPage = <T>(
    items: T[],
    offset: number,
    limit: number,
    hasMore: boolean,
): ProviderPage<T> => ({
    items,
    nextOffset: offset + items.length,
    hasMore: hasMore && items.length > 0,
});
