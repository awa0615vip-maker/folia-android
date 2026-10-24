// src/services/onlineMusic/kugou/kugouDirectTransport.ts
//
// 安卓直连酷狗官方接口的传输层（无后端模式）。
//
// 上游架构里酷狗所有请求都走 VITE_KUGOU_API_BASE 指向的自部署后端（KuGouMusicApi），
// 安卓没有该后端也没有 Electron 内嵌桥，音源整体不可用。本文件把官方接口的请求与签名
// （Android 版 MD5 签名、Web 版 MD5 签名、signParamsKey/signKey）用纯浏览器能力实现，
// 直接请求酷狗官方域名（原生 OkHttp 桥已放行 *.kugou.com，不存在 CORS），返回与后端
// 一致的响应 JSON，provider 层无需改动即可工作。
//
// 接口来源：kugoumusicapi（MakcRe/KuGouMusicApi v1.6.0）各 module 的实现与签名算法，
// 实测搜索/歌词/取流链路可用。

import md5 from 'blueimp-md5';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { readProviderSessionValue, writeProviderSessionValue } from '../providerStorage';

// ---------- 常量（与 kugoumusicapi util/config.json 一致） ----------

const APPID = 1005;          // Android 标准版 appid
const APPID_WEB = 1014;      // Web 登录 appid
const SRCAPPID = 2919;
const CLIENTVER = 20489;

// Android 版签名盐值（标准版）
const SALT_ANDROID = 'OIlwieks28dk2k092lksi2UIkp';
// Web 版签名盐值
const SALT_WEB = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
// signKey 盐值（标准版）
const SALT_SIGNKEY = '57ae12eb6890223e355ccfcb74edf70d';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Xiaomi 14 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// KRC 歌词 XOR 解密密钥（16 字节，循环使用）
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

// ---------- 设备标识（mid / dfid，一次生成后持久化） ----------

const newGuid = (): string => {
    const e = () => ((65536 * (1 + Math.random())) | 0).toString(16).substring(1);
    return `${e()}${e()}-${e()}-${e()}-${e()}-${e()}${e()}${e()}`;
};

// calculateMid(uuid)：md5 十六进制串当作大整数转十进制，补零到 30 位。
const calculateMid = (str: string): string => {
    const digest = md5(str);
    let big = 0n;
    for (let i = 0; i < digest.length; i += 1) {
        big = big * 16n + BigInt(parseInt(digest.charAt(i), 16));
    }
    let s = big.toString();
    while (s.length < 30) s = `0${s}`;
    return s;
};

const randomString = (len = 16): string => {
    const keyString = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = '';
    for (let i = 0; i < len; i += 1) {
        out += keyString[Math.floor(Math.random() * keyString.length)];
    }
    return out;
};

// 读取/初始化设备标识：dfid 与 mid 持久化到 provider 会话存储。
export const ensureKugouDevice = (): { mid: string; dfid: string } => {
    let dfid = readProviderSessionValue('kugou', 'dfid');
    if (!dfid) {
        dfid = md5(`${newGuid()}-${Date.now()}`).toUpperCase();
        writeProviderSessionValue('kugou', 'dfid', dfid);
    }
    let mid = readProviderSessionValue('kugou', 'mid');
    if (!mid) {
        mid = calculateMid(newGuid());
        writeProviderSessionValue('kugou', 'mid', mid);
    }
    return { mid, dfid };
};

// ---------- 签名 ----------

// Android 版：md5(盐 + 按 key 排序的 k=v 拼接 + data + 盐)
const signatureAndroidParams = (params: Record<string, unknown>, data = ''): string => {
    const paramsString = Object.keys(params)
        .sort()
        .map(key => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
        .join('');
    return md5(`${SALT_ANDROID}${paramsString}${data}${SALT_ANDROID}`);
};

// Web 版：md5(盐 + 按 key 排序的 k=v 拼接 + 盐)
const signatureWebParams = (params: Record<string, unknown>): string => {
    const paramsString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .sort()
        .join('');
    return md5(`${SALT_WEB}${paramsString}${SALT_WEB}`);
};

// signParamsKey：md5(appid + 盐 + clientver + data)
const signParamsKey = (data: string | number): string => md5(`${APPID}${SALT_ANDROID}${CLIENTVER}${data}`);

// signKey：md5(hash + 盐 + appid + mid + userid)
const signKey = (hash: string, mid: string, userid: string | number): string =>
    md5(`${hash}${SALT_SIGNKEY}${APPID}${mid}${userid || 0}`);

// ---------- 请求封装 ----------

const kugouFetch = async (
    url: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<any> => {
    const response = await fetch(url, {
        method: options.method ?? 'GET',
        body: options.body,
        headers: {
            'User-Agent': ANDROID_UA,
            ...(options.headers ?? {}),
        },
    });
    if (!response.ok) {
        throw new OnlineProviderError('network', `KuGou direct request failed (HTTP ${response.status})`, 'kugou');
    }
    try {
        return await response.json();
    } catch {
        throw new OnlineProviderError('invalid-response', 'KuGou direct request returned an unreadable body', 'kugou');
    }
};

// 带默认设备参数 + Android 签名的 GET 请求（搜索/歌词/歌单等）
const androidGet = async (
    base: string,
    path: string,
    params: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
): Promise<any> => {
    const { mid, dfid } = ensureKugouDevice();
    const clienttime = Math.floor(Date.now() / 1000);
    const dataMap: Record<string, unknown> = {
        dfid,
        mid,
        uuid: '-',
        appid: APPID,
        clientver: CLIENTVER,
        clienttime,
        ...params,
    };
    dataMap.signature = signatureAndroidParams(dataMap);
    const query = new URLSearchParams();
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
    });
    return kugouFetch(`${base}${path}?${query}`, { headers: extraHeaders });
};

// 带默认设备参数 + Android 签名的 POST JSON 请求
const androidPost = async (
    base: string,
    path: string,
    data: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
): Promise<any> => {
    const { mid, dfid } = ensureKugouDevice();
    const clienttime = Math.floor(Date.now() / 1000);
    const payload = {
        appid: APPID,
        clienttime,
        clientver: CLIENTVER,
        ...data,
        dfid,
        mid,
    };
    const body = JSON.stringify(payload);
    return kugouFetch(`${base}${path}`, {
        method: 'POST',
        body,
        headers: {
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
    });
};

// ---------- KRC 歌词解码 ----------

const decodeKrc = async (base64Content: string): Promise<string> => {
    const binary = atob(base64Content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    const krcBytes = bytes.slice(4); // 跳过 4 字节文件头
    for (let index = 0; index < krcBytes.length; index += 1) {
        krcBytes[index] ^= KRC_KEY[index % KRC_KEY.length];
    }
    try {
        const stream = new Response(krcBytes).body;
        if (!stream) return '';
        const decompressed = await new Response(stream.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        return new TextDecoder('utf-8').decode(decompressed);
    } catch {
        return '';
    }
};

// ---------- 各操作实现 ----------

// 搜索：mobilecdn.kugou.com/api/v3/search/song（Android 签名）→ 响应透传
const directSearch = async (params: Record<string, unknown>): Promise<any> => {
    const keyword = String(params.keyword ?? params.keywords ?? '');
    if (!keyword) throw new OnlineProviderError('invalid-response', 'KuGou search needs a keyword', 'kugou');
    const page = Number(params.page ?? params.page_num ?? 1) || 1;
    const pagesize = Number(params.pagesize ?? params.page_size ?? 30) || 30;
    return androidGet('https://mobilecdn.kugou.com', '/api/v3/search/song', {
        albumhide: 0,
        iscorrection: 1,
        keyword,
        nocollect: 0,
        page,
        pagesize,
        platform: 'AndroidFilter',
    });
};

// 歌曲音质列表：kmr.service.kugou.com/v1/audio/audio（http 明文，Android 签名）
const directAudio = async (params: Record<string, unknown>): Promise<any> => {
    const hashes = String(params.hash ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    if (hashes.length === 0) throw new OnlineProviderError('invalid-response', 'KuGou audio needs a hash', 'kugou');
    const { dfid } = ensureKugouDevice();
    const clienttime = Date.now();
    const body = JSON.stringify(hashes.map(hash => ({ hash, audio_id: 0 })));
    const payload: Record<string, unknown> = {
        appid: APPID,
        clienttime,
        clientver: CLIENTVER,
        data: hashes.map(hash => ({ hash, audio_id: 0 })),
        dfid,
        key: signParamsKey(clienttime),
        mid: readProviderSessionValue('kugou', 'mid') ?? '',
    };
    const token = readProviderSessionValue('kugou', 'token');
    if (token) payload.token = token;
    const userid = readProviderSessionValue('kugou', 'userid');
    if (userid) payload.userid = Number(userid);

    const response = await kugouFetch('http://kmr.service.kugou.com/v1/audio/audio', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', 'x-router': 'kmr.service.kugou.com' },
    });
    // audio 接口返回 { status, data: [...] }（音质 hash 列表，无直链）
    return response;
};

// 取流直链：trackercdn.kugou.com/v5/url（Android 签名 + signKey，带 album_audio_id）
const directSongUrl = async (params: Record<string, unknown>): Promise<any> => {
    const { mid, dfid } = ensureKugouDevice();
    const hash = String(params.hash ?? '').toLowerCase();
    if (!hash) throw new OnlineProviderError('invalid-response', 'KuGou song_url needs a hash', 'kugou');
    const clienttime = Math.floor(Date.now() / 1000);
    const quality = String(params.quality ?? 128);
    const userid = Number(readProviderSessionValue('kugou', 'userid') || 0);
    const token = readProviderSessionValue('kugou', 'token') || '';

    const dataMap: Record<string, unknown> = {
        album_id: Number(params.album_id ?? 0),
        area_code: 1,
        hash,
        ssa_flag: 'is_fromtrack',
        version: 11430,
        page_id: 151369488,
        quality,
        album_audio_id: Number(params.album_audio_id ?? 0),
        behavior: 'play',
        pid: 2,
        cmd: 26,
        pidversion: 3001,
        IsFreePart: 0,
        ppage_id: '463467626,350369493,788954147',
        cdnBackup: 1,
        module: '',
        clientver: 11430,
        dfid,
        mid,
        uuid: '-',
        appid: APPID,
        clienttime,
        token,
    };
    if (userid) dataMap.userid = userid;
    dataMap.key = signKey(hash, mid, userid);
    dataMap.signature = signatureAndroidParams(dataMap);
    const query = new URLSearchParams();
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
    });
    const response = await kugouFetch(`https://trackercdn.kugou.com/v5/url?${query}`, {
        headers: { 'x-router': 'trackercdn.kugou.com' },
    });
    // 归一化：后端 song_url 返回 { status, data: [{ play_url, ... }] }
    const data = response?.data ?? response;
    const first = Array.isArray(data) ? data[0] : data;
    const url = first?.play_url || first?.url || first?.playUrl;
    if (url) {
        return {
            status: 1,
            data: Array.isArray(data) ? data : [data],
        };
    }
    return response;
};

// 旧版移动端 playInfo 兜底：m.kugou.com/app/i/getSongInfo.php（免签名）
const directLegacyPlayInfo = async (hash: string): Promise<any> => {
    const url = new URL('https://m.kugou.com/app/i/getSongInfo.php');
    url.searchParams.set('cmd', 'playInfo');
    url.searchParams.set('hash', hash);
    const response = await kugouFetch(url.toString());
    const playUrl = response?.url || response?.play_url || '';
    if (playUrl) {
        return {
            status: 1,
            data: [{ play_url: playUrl, audio_name: response?.fileName }],
        };
    }
    return response;
};

// 歌词候选：lyrics.kugou.com/search（Android 签名）→ { candidates }
const directSearchLyric = async (params: Record<string, unknown>): Promise<any> => {
    const { dfid } = ensureKugouDevice();
    const dataMap: Record<string, unknown> = {
        ver: 1,
        man: 'no',
        client: 'android',
        hash: String(params.hash ?? '').toUpperCase(),
        dfid,
        mid: readProviderSessionValue('kugou', 'mid') ?? '',
        appid: APPID,
        clientver: CLIENTVER,
        clienttime: Math.floor(Date.now() / 1000),
    };
    if (params.duration !== undefined) dataMap.duration = Number(params.duration);
    if (params.album_audio_id !== undefined) dataMap.album_audio_id = String(params.album_audio_id);
    dataMap.signature = signatureAndroidParams(dataMap);
    const query = new URLSearchParams();
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
    });
    return kugouFetch(`https://lyrics.kugou.com/search?${query}`);
};

// 歌词正文：lyrics.kugou.com/download（Android 签名）→ 本地 KRC 解码 → { decodeContent }
const directLyric = async (params: Record<string, unknown>): Promise<any> => {
    const { dfid } = ensureKugouDevice();
    const dataMap: Record<string, unknown> = {
        ver: 1,
        client: 'android',
        id: String(params.id ?? ''),
        accesskey: String(params.accesskey ?? ''),
        fmt: params.fmt || 'krc',
        charset: 'utf8',
        dfid,
        mid: readProviderSessionValue('kugou', 'mid') ?? '',
        appid: APPID,
        clientver: CLIENTVER,
        clienttime: Math.floor(Date.now() / 1000),
    };
    dataMap.signature = signatureAndroidParams(dataMap);
    const query = new URLSearchParams();
    Object.entries(dataMap).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
    });
    const response = await kugouFetch(`https://lyrics.kugou.com/download?${query}`);
    const content = response?.content;
    if (typeof content === 'string' && content) {
        const fmt = params.fmt || 'krc';
        const contentType = Number(response?.contenttype);
        // lrc 直接 base64 解码；krc 需要 XOR + zlib
        const decoded = fmt === 'lrc' || contentType !== 0
            ? atob(content)
            : await decodeKrc(content);
        return { ...response, decodeContent: decoded };
    }
    return response;
};

// 每日推荐（每日歌曲推荐/私人 FM 兜底）：mobilecdn.kugou.com/api/v3/recommend/song（Android 签名）
const directEverydayRecommend = async (): Promise<any> => {
    return androidGet('https://mobilecdn.kugou.com', '/api/v3/recommend/song', {
        page: 1,
        pagesize: 30,
        platform: 'AndroidFilter',
    });
};

// 用户歌单列表：mobilecdn.kugou.com/api/v3/user/playlist（Android 签名）
const directUserPlaylist = async (params: Record<string, unknown>): Promise<any> => {
    const userid = String(params.userid ?? readProviderSessionValue('kugou', 'userid') ?? '');
    if (!userid) throw new OnlineProviderError('auth-required', 'KuGou user playlist needs a login', 'kugou');
    const page = Number(params.page ?? 1) || 1;
    const pagesize = Number(params.pagesize ?? 30) || 30;
    return androidGet('https://mobilecdn.kugou.com', '/api/v3/user/playlist', {
        userid,
        page,
        pagesize,
        platform: 'AndroidFilter',
    });
};

// ---------- 入口 ----------

/**
 * 安卓直连酷狗官方接口的统一入口。
 * 与 requestKugou 同构：operation + params → 后端风格 JSON。
 * 不支持的操作为了不让 UI 静默空白，抛出带原因的 OnlineProviderError。
 */
export const requestKugouDirect = async <T = unknown>(
    operation: string,
    params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> => {
    switch (operation) {
        case 'search':
            return directSearch(params) as Promise<T>;
        case 'audio':
            return directAudio(params) as Promise<T>;
        case 'song_url':
            return directSongUrl(params) as Promise<T>;
        case 'search_lyric':
            return directSearchLyric(params) as Promise<T>;
        case 'lyric':
            return directLyric(params) as Promise<T>;
        case 'everyday_recommend':
        case 'everyday_history':
            return directEverydayRecommend() as Promise<T>;
        case 'user_playlist':
            return directUserPlaylist(params) as Promise<T>;
        default:
            throw new OnlineProviderError(
                'unsupported',
                `KuGou operation ${operation} is not available in Android direct mode`,
                'kugou',
            );
    }
};

/** 旧版 playInfo 兜底（不带签名，直连 m.kugou.com）。 */
export const requestKugouLegacyPlayInfoDirect = async (hash: string): Promise<any> => directLegacyPlayInfo(hash);
