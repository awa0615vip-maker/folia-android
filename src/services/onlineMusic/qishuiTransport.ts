// src/services/onlineMusic/qishuiTransport.ts
// 汽水音乐网络层：运行在 WebView 内，用 window.fetch 发请求；在 Android 上由 FoliaNative
// 原生 HTTP 桥（OkHttp）接管，绕过 CORS 并自动承载特权头。登录 cookie 由本模块自行维护并
// 持久化到 localStorage（不依赖原生 CookieManager 的跨重启行为）。
//
// 仅实现「登录自己账号、播放账号有权限内容」的最小闭环：扫码登录 / 搜索 / 取流 / 个人信息。
// 不实现任何绕过会员或 DRM 的能力。

import { OnlineProviderError } from '../../types/onlineMusic';
import type { AudioQualityPreference, ProviderUser } from '../../types/onlineMusic';
import {
    readProviderSessionValue,
    removeProviderSessionValue,
    writeProviderSessionValue,
} from './providerStorage';
import {
    QISHUI_PROVIDER_ID,
    QISHUI_API,
    QISHUI_UA,
    pcQuery,
    passportHeaders,
    passportQuery,
    buildCheckQrBody,
    SESSION_COOKIE_KEYS,
} from './qishuiConstants';
import { coverFromUrlCover } from './qishuiNormalize';

const COOKIE_STORAGE_KEY = 'cookie';
const QR_MIN_POLL_MS = 3500;
const QR_RATE_LIMIT_BACKOFF_MS = 55_000;

// ─── 运行环境可用性 ────────────────────────────────────────────────────────

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as any).Capacitor?.getPlatform?.() === 'android'
);

/** 桌面版若以后内嵌汽水后端，可在此放行；当前只在 Android 原生桥下可用。 */
export const getQishuiTransportAvailability = () => (
    isAndroidNativeRuntime()
        ? ({ configured: true } as const)
        : ({ configured: false, reason: 'runtime-unavailable' } as const)
);

// ─── Cookie 维护 ─────────────────────────────────────────────────────────

type CookieMap = Record<string, string>;

let cookieCache: CookieMap | null = null;

const parseCookiePairs = (cookieHeader: string): CookieMap => {
    const out: CookieMap = {};
    if (!cookieHeader?.trim()) return out;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key && value) out[key] = value;
    }
    return out;
};

const mergeCookieMaps = (...maps: Array<CookieMap | undefined | null>): CookieMap => {
    const out: CookieMap = {};
    for (const map of maps) {
        if (!map) continue;
        for (const [k, v] of Object.entries(map)) {
            if (k && v) out[k] = v;
        }
    }
    return out;
};

const cookieHeaderFromMap = (map: CookieMap): string => (
    Object.entries(map)
        .filter(([k, v]) => Boolean(k && v))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
);

const loadCookieMap = (): CookieMap => {
    if (cookieCache) return cookieCache;
    const raw = readProviderSessionValue(QISHUI_PROVIDER_ID, COOKIE_STORAGE_KEY) || '';
    cookieCache = parseCookiePairs(raw);
    return cookieCache;
};

const saveCookieMap = (map: CookieMap): void => {
    cookieCache = map;
    writeProviderSessionValue(QISHUI_PROVIDER_ID, COOKIE_STORAGE_KEY, cookieHeaderFromMap(map));
};

export const clearQishuiSession = (): void => {
    cookieCache = null;
    removeProviderSessionValue(QISHUI_PROVIDER_ID, COOKIE_STORAGE_KEY);
};

const hasLoginSession = (map: CookieMap): boolean => SESSION_COOKIE_KEYS.some(k => Boolean(map[k]));

/** 从原生桥暴露的 x-folia-set-cookie 响应头收集 Set-Cookie（标准 set-cookie 是 forbidden header，
 *  桥把每条 Set-Cookie 镜像到了 x-folia-set-cookie；多个值会被 Headers 用 ", " 合并，
 *  再用「后面紧跟 name=value 的逗号」边界拆开，避免误切 Expires 里的日期逗号。）。 */
const collectSetCookies = (response: Response): CookieMap => {
    const out: CookieMap = {};
    const headers = response.headers;
    let lines: string[] = [];
    // 标准 getSetCookie()（若浏览器支持）只拿得到真实 set-cookie 头，桥里通常为空，仅作兜底。
    if (typeof (headers as any).getSetCookie === 'function') {
        const std = (headers as any).getSetCookie() as string[];
        if (Array.isArray(std) && std.length) lines = std;
    }
    if (!lines.length) {
        const merged = headers.get('x-folia-set-cookie');
        if (merged) lines = merged.split(/,(?=\s*[^;=]+=[^;]+)/);
    }
    for (const line of lines) {
        const nv = line.split(';')[0]?.trim();
        if (!nv) continue;
        const eq = nv.indexOf('=');
        if (eq > 0) out[nv.slice(0, eq)] = nv.slice(eq + 1);
    }
    return out;
};

// ─── HTTP ─────────────────────────────────────────────────────────────────

interface QishuiRequestOptions {
    method?: 'GET' | 'POST';
    json?: unknown;
    form?: string;
    extraHeaders?: Record<string, string>;
    /** 这一次请求使用的 cookie（扫码轮询阶段需要带二维码的 pending cookie）。 */
    cookieOverride?: CookieMap;
    timeoutMs?: number;
}

async function qishuiFetch(url: string, options: QishuiRequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const cookieMap = options.cookieOverride ?? loadCookieMap();
    const headers: Record<string, string> = {
        'User-Agent': QISHUI_UA,
        ...(options.extraHeaders || {}),
    };
    const cookie = cookieHeaderFromMap(cookieMap);
    if (cookie) headers.Cookie = cookie;

    let body: string | undefined;
    if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers['Content-Type'] = 'application/json; charset=utf-8';
    } else if (options.form !== undefined) {
        body = options.form;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    // 原生桥给普通请求 15s 预算；汽水接口都是立即返回（非长轮询），足够。
    const timeoutMs = options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
        });
        // 业务域 cookie 合并进会话（扫码登录态在这里落地）。
        const fresh = collectSetCookies(response);
        if (Object.keys(fresh).length) {
            saveCookieMap(mergeCookieMaps(loadCookieMap(), fresh));
        }
        return response;
    } catch (error) {
        throw new OnlineProviderError('network', `汽水音乐请求失败: ${url}`, QISHUI_PROVIDER_ID, error);
    } finally {
        clearTimeout(timer);
    }
}

async function qishuiJson<T = any>(url: string, options?: QishuiRequestOptions): Promise<T> {
    const response = await qishuiFetch(url, options);
    const raw = await response.text().catch(() => '');
    if (response.status >= 400) {
        throw new OnlineProviderError(
            'network',
            `汽水音乐 HTTP ${response.status}`,
            QISHUI_PROVIDER_ID,
            undefined,
            response.status,
        );
    }
    if (!raw.trim()) {
        // 字节服务端对未授权的取流 / 个人信息请求静默返回「200 空 body」。
        if (!hasLoginSession(loadCookieMap())) {
            throw new OnlineProviderError(
                'auth-required',
                '汽水音乐需要登录后才能播放，请先扫码登录',
                QISHUI_PROVIDER_ID,
                undefined,
                response.status,
            );
        }
        throw new OnlineProviderError('invalid-response', '汽水音乐返回了空响应', QISHUI_PROVIDER_ID,
            undefined, response.status);
    }
    try {
        return JSON.parse(raw) as T;
    } catch (error) {
        throw new OnlineProviderError('invalid-response', '汽水音乐返回了无法解析的响应', QISHUI_PROVIDER_ID, error);
    }
}

// ─── 扫码登录 ─────────────────────────────────────────────────────────────

interface QrPending {
    cookies: CookieMap;
    phoneConfirmed: boolean;
    lastPollAt: number;
    backoffUntil: number;
    qrcode: string;
}

const qrPending = new Map<string, QrPending>();

export interface QishuiQrCreate {
    token: string;
    /** 可直接放进 <img src> 的二维码图片地址（URL 或 data: URL）。 */
    imageUrl: string;
}

/** 创建扫码会话；返回 token 与二维码图片。 */
export async function createQrLogin(): Promise<QishuiQrCreate> {
    // 首次调用会把 get_qrcode 下发的 passport cookie 收进会话（用于随后 check_qrconnect）。
    const url = `${QISHUI_API}/passport/web/get_qrcode/?${passportQuery('create')}`;
    const response = await qishuiFetch(url, { extraHeaders: passportHeaders() });
    if (response.status >= 400) {
        throw new OnlineProviderError('network', `二维码获取失败 HTTP ${response.status}`, QISHUI_PROVIDER_ID,
            undefined, response.status);
    }
    const payload = await response.json().catch(() => null);
    const data = payload?.data ?? payload ?? {};
    const token = String(data.token ?? '');
    const qrcode = String(data.qrcode ?? data.qrcode_index_url ?? data.web_url ?? '');
    if (!token || !qrcode) {
        throw new OnlineProviderError('invalid-response', '汽水音乐二维码响应缺少 token', QISHUI_PROVIDER_ID);
    }
    qrPending.set(token, {
        cookies: loadCookieMap(),
        phoneConfirmed: false,
        lastPollAt: 0,
        backoffUntil: 0,
        qrcode,
    });
    return { token, imageUrl: qrcode };
}

export type QishuiQrState =
    | { state: 'waiting'; message?: string }
    | { state: 'scanned'; message?: string }
    | { state: 'confirmed' }
    | { state: 'expired'; message?: string }
    | { state: 'error'; message?: string };

/** 轮询扫码状态；成功后落地登录 cookie。 */
export async function pollQrLogin(token: string): Promise<QishuiQrState> {
    const pending = qrPending.get(token);
    if (!pending) {
        // 会话被刷新过：重新取码最省事。
        return { state: 'error', message: '二维码会话已失效，请重新获取' };
    }
    const now = Date.now();
    if (pending.backoffUntil > now) {
        return {
            state: pending.phoneConfirmed ? 'scanned' : 'waiting',
            message: pending.phoneConfirmed ? '手机已确认，正在等待下发登录态…' : '访问稍频繁，稍后自动继续…',
        };
    }
    if (pending.lastPollAt && now - pending.lastPollAt < QR_MIN_POLL_MS) {
        return { state: pending.phoneConfirmed ? 'scanned' : 'waiting' };
    }
    pending.lastPollAt = now;

    const url = `${QISHUI_API}/passport/web/check_qrconnect/?${passportQuery('check')}`;
    const response = await qishuiFetch(url, {
        method: 'POST',
        form: buildCheckQrBody(token),
        extraHeaders: passportHeaders(cookieHeaderFromMap(pending.cookies)),
        cookieOverride: pending.cookies,
        timeoutMs: 20_000,
    });
    let payload: any;
    try {
        payload = await response.json();
    } catch {
        // 网络层失败：二维码仍有效，按 waiting 处理，让上层继续轮询。
        return { state: 'waiting' };
    }
    const data = payload?.data ?? {};

    // 合并本次响应可能下发的 cookie（qishuiFetch 已做一次），再从 JSON 里补 session 字段。
    let nextJar = mergeCookieMaps(pending.cookies, loadCookieMap());
    for (const key of SESSION_COOKIE_KEYS) {
        const v = data[key] ?? payload[key];
        if (typeof v === 'string' && v) nextJar[key] = v;
    }
    pending.cookies = nextJar;
    saveCookieMap(nextJar);

    if (hasLoginSession(nextJar)) {
        qrPending.delete(token);
        return { state: 'confirmed' };
    }

    const rawStatus = String(data.status ?? '').toLowerCase();
    const errorCode = Number(data.error_code ?? payload.error_code ?? 0);
    const accountFlow = String(data.account_flow ?? '').toLowerCase();
    const desc = String(data.description ?? payload.description ?? payload.message ?? '');

    if (errorCode === 7 || desc.includes('太频繁') || desc.includes('稍后再试') || /rate|frequent/i.test(desc)) {
        pending.backoffUntil = Date.now() + QR_RATE_LIMIT_BACKOFF_MS;
        return { state: pending.phoneConfirmed ? 'scanned' : 'waiting', message: '访问太频繁，请等待约 1 分钟…' };
    }
    if (accountFlow === 'verify' || errorCode === 2046) {
        pending.phoneConfirmed = true;
        return { state: 'scanned', message: desc || '扫码后需要短信验证，请改用已登录的汽水账号或稍后重试' };
    }
    if (rawStatus.includes('scan')) {
        return { state: 'scanned', message: '已扫码，请在手机上确认' };
    }
    if (rawStatus.includes('confirm')) {
        pending.phoneConfirmed = true;
        pending.backoffUntil = Date.now() + 2500;
        return { state: 'scanned', message: '手机已确认，正在等待下发登录态…' };
    }
    if (rawStatus.includes('expir') || rawStatus.includes('timeout') || errorCode === 5) {
        qrPending.delete(token);
        return { state: 'expired', message: desc || '二维码已过期' };
    }
    if (rawStatus === 'error' || rawStatus === 'failed') {
        return { state: 'error', message: desc || `登录失败 (code=${errorCode || rawStatus})` };
    }
    return { state: 'waiting', message: desc || '等待扫码…' };
}

/** 释放一把二维码会话（关登录窗时 fire-and-forget；未知 / 过期 token 也算成功）。 */
export function cancelQrLogin(token: string): void {
    qrPending.delete(token);
}

// ─── 个人信息（登录态自检）────────────────────────────────────────────────

export async function getProfile(): Promise<ProviderUser | null> {
    if (!hasLoginSession(loadCookieMap())) return null;
    const url = `${QISHUI_API}/luna/pc/me?${pcQuery()}`;
    const data = await qishuiJson<any>(url);
    if (data.status_code && data.status_code !== 0) {
        clearQishuiSession();
        return null;
    }
    const me = data.my_info ?? data.user ?? data;
    const id = String(me.id ?? me.user_id ?? '');
    if (!id) return null;
    return {
        id,
        nickname: String(me.nickname ?? me.public_name ?? id),
        avatarUrl: coverFromUrlCover(me.larger_avatar_url ?? me.medium_avatar_url ?? me.avatar_url ?? me.avatar),
        vipType: Number(me.vip_info?.is_vip ?? me.is_vip ?? 0) ? 1 : 0,
    };
}

// ─── 搜索 ─────────────────────────────────────────────────────────────────

const randomUuid = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
};

export async function searchAll(keyword: string, cursor: string | number = 0): Promise<any> {
    const url = `${QISHUI_API}/luna/pc/search/all?${pcQuery({
        q: keyword,
        cursor: String(cursor),
        search_id: randomUuid(),
        search_method: 'input',
    })}`;
    return qishuiJson(url);
}

/** 从搜索聚合响应里取某一分组（tracks / playlists / artists / albums）。 */
export function resultGroup(data: any, groupId: string): any {
    const groups = data?.result_groups;
    if (!Array.isArray(groups)) return null;
    return groups.find((g: any) => String(g?.id ?? '') === groupId) ?? null;
}

// ─── 取流 ─────────────────────────────────────────────────────────────────

interface NormalizedPlayInfo {
    url: string;
    playAuth: string;
    bitrate: number;
    size: number;
    quality: string;
}

function normalizePlayList(raw: any): NormalizedPlayInfo[] {
    return (Array.isArray(raw) ? raw : [])
        .map((x): NormalizedPlayInfo | null => {
            if (!x || typeof x !== 'object') return null;
            const meta = x.video_meta ?? x.VideoMeta ?? {};
            const enc = x.encrypt_info ?? x.EncryptInfo ?? {};
            const url = String(
                x.MainPlayUrl ?? x.main_play_url ?? x.main_url ?? x.MainUrl
                ?? x.BackupPlayUrl ?? x.backup_play_url ?? x.backup_url ?? '',
            );
            if (!url) return null;
            return {
                url,
                playAuth: String(enc.spade_a ?? x.PlayAuth ?? x.play_auth ?? x.PlayAuthToken ?? x.spade_a ?? ''),
                bitrate: Number(meta.bitrate ?? meta.real_bitrate ?? x.Bitrate ?? x.bitrate ?? 0),
                size: Number(meta.size ?? x.Size ?? x.size ?? 0),
                quality: String(meta.quality ?? x.Quality ?? x.quality ?? ''),
            };
        })
        .filter((x): x is NormalizedPlayInfo => x !== null);
}

function qualityRank(q: string, bitrate: number): number {
    const s = (q ?? '').toLowerCase();
    if (s.includes('lossless') || s.includes('flac') || s.includes('hi_res') || s.includes('hires') || s === 'hi-res') return 100;
    if (s.includes('spatial') || s.includes('highest') || s.includes('atmos')) return 90;
    if (s.includes('higher') || s.includes('exhigh') || s.includes('320')) return 80;
    if (s.includes('medium') || s.includes('standard') || s.includes('128')) return 40;
    if (bitrate >= 900_000) return 100;
    if (bitrate >= 300_000) return 90;
    if (bitrate >= 200_000) return 80;
    if (bitrate >= 100_000) return 40;
    return 20;
}

const qualityToWanted = (quality: AudioQualityPreference): string => {
    if (quality === 'lossless' || quality === 'hires') return 'lossless';
    if (quality === 'high') return 'higher';
    return 'standard';
};

/** 从候选音质里按用户偏好挑一个；与 ly-music-source 相同的选档逻辑。 */
export function pickPlayInfo(list: any[], wanted: AudioQualityPreference): NormalizedPlayInfo | null {
    const normalized = normalizePlayList(list);
    if (!normalized.length) return null;
    const sorted = [...normalized].sort(
        (a, b) => qualityRank(b.quality, b.bitrate) - qualityRank(a.quality, a.bitrate) || (b.size - a.size),
    );
    const want = qualityToWanted(wanted);
    const wantRank = want === 'lossless' ? 100 : want === 'higher' ? 80 : 40;
    if (want === 'lossless') return sorted[0];
    const candidates = sorted.filter(item => qualityRank(item.quality, item.bitrate) <= wantRank);
    return candidates.length ? candidates[0] : sorted[sorted.length - 1];
}

export interface TrackPlayInfo {
    playInfo: NormalizedPlayInfo | null;
    durationMs: number;
    title?: string;
}

/** POST /luna/pc/track_v2 取视频模型并解析可播放地址。 */
export async function fetchTrackPlayInfo(trackId: string, quality: AudioQualityPreference): Promise<TrackPlayInfo> {
    const body = {
        media_type: 'track',
        queue_type: 'search_one_track',
        scene_name: 'search',
        track_id: trackId,
    };
    const url = `${QISHUI_API}/luna/pc/track_v2?${pcQuery()}`;
    const trackPayload = await qishuiJson<any>(url, { method: 'POST', json: body });

    let playList: any[] = [];
    const videoModel = trackPayload?.track_player?.video_model ?? trackPayload?.track_player?.videoModel;
    if (typeof videoModel === 'string' && videoModel) {
        try {
            const vm = JSON.parse(videoModel);
            playList = vm?.video_list ?? vm?.VideoList ?? vm?.data?.play_info_list ?? vm?.PlayInfoList ?? [];
        } catch {
            /* ignore */
        }
    } else if (videoModel && typeof videoModel === 'object') {
        playList = videoModel.video_list ?? videoModel.VideoList ?? videoModel.data?.play_info_list ?? [];
    }

    // 回退：url_player_info（Vod GetPlayInfo）。
    const urlPlayerInfo = trackPayload?.track_player?.url_player_info
        ?? trackPayload?.trackPlayer?.urlPlayerInfo
        ?? trackPayload?.data?.track_player?.url_player_info;
    if (!playList.length && urlPlayerInfo) {
        try {
            const playerInfo = await qishuiJson<any>(String(urlPlayerInfo));
            playList = playerInfo?.Result?.Data?.PlayInfoList
                ?? playerInfo?.result?.data?.play_info_list
                ?? playerInfo?.PlayInfoList
                ?? [];
        } catch {
            /* video_model 是主路径，失败则交给上层判空 */
        }
    }

    const rawDuration = Number(trackPayload?.track?.duration ?? trackPayload?.duration ?? trackPayload?.data?.duration ?? 0);
    const durationMs = rawDuration > 10_000 ? rawDuration : rawDuration * 1000;
    return { playInfo: pickPlayInfo(playList, quality), durationMs };
}
