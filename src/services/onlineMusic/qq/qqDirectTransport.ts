// src/services/onlineMusic/qq/qqDirectTransport.ts
//
// 安卓直连 QQ 音乐官方接口的传输层（无后端模式）。
//
// 上游架构里 QQ 音乐所有请求走 VITE_QQ_API_BASE 指向的自部署后端（@yakult-green-tea/qq-music-api）
// 或 Electron 内嵌后端；安卓两者都没有，音源整体不可用。本文件用官方 Web 端接口
// （u.y.qq.com/cgi-bin/musicu.fcg 的 DoSearchForQQMusicDesktop / CgiGetVkey）本地实现
// 搜索与取流，返回与后端一致的响应 JSON，provider 层无需改动。
//
// 接口实测：搜索可用（ct:23, cv:0, platform:yqq.json）；免登录取流只回试听文件
// （purl 为空，完整播放需登录，登录为后续版本）。

import { OnlineProviderError } from '../../../types/onlineMusic';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from '../providerStorage';
import { openProviderWebLogin } from '../../nativeAndroidBridge';

const QQ_UA = 'Mozilla/5.0 (Linux; Android 14; Xiaomi 14 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// 本机设备标识：QQ 播放需要 guid（10 位以上数字串），一次生成后全链路复用。
let qqGuid: string | null = null;
export const getQqGuid = (): string => {
    if (!qqGuid) {
        qqGuid = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 9000 + 1000)}`;
    }
    return qqGuid;
};

// 登录态：整段 Cookie 与 uin 存在 'qq' 会话存储（与上游后端登录共用同一存储键，登录状态 UI 直接可见）。
const readQqSessionCookie = (): string => readProviderSessionValue('qq', 'cookie') || '';
const readQqSessionUin = (): string => {
    const stored = readProviderSessionValue('qq', 'uin');
    if (stored) return stored;
    // 从 Cookie 里兜底解析（y.qq.com 登录后的 uin=QQ号）。
    const cookie = readQqSessionCookie();
    for (const part of cookie.split(';')) {
        const p = part.trim();
        const eq = p.indexOf('=');
        if (eq > 0 && p.substring(0, eq).trim() === 'uin') return p.substring(eq + 1).trim();
    }
    return '';
};

// musicu.fcg 统一请求：comm + 命名 req_1..req_N；带登录态时 comm.uin 与 Cookie header 一起发。
const qqMusicu = async <T = any>(
    module: string,
    method: string,
    param: Record<string, unknown>,
): Promise<T> => {
    const uin = readQqSessionUin() || '0';
    const sessionCookie = readQqSessionCookie();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': QQ_UA,
        Referer: 'https://y.qq.com/',
    };
    if (sessionCookie) headers.Cookie = sessionCookie;
    const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            comm: { ct: 23, cv: 0, uin, format: 'json', platform: 'yqq.json' },
            req_1: { module, method, param },
        }),
    });
    if (!response.ok) {
        throw new OnlineProviderError('network', `QQMusic direct request failed (HTTP ${response.status})`, 'qq');
    }
    let body: any;
    try {
        body = await response.json();
    } catch {
        throw new OnlineProviderError('invalid-response', 'QQMusic direct request returned an unreadable body', 'qq');
    }
    const req = body?.req_1;
    if (!req) {
        throw new OnlineProviderError('invalid-response', 'QQMusic direct request answered no req_1', 'qq', body);
    }
    if (Number(req.code) !== 0) {
        throw new OnlineProviderError(
            'unavailable',
            `QQMusic direct request refused (code ${req.code})`,
            'qq',
            req,
        );
    }
    return req.data as T;
};

// 搜索：DoSearchForQQMusicDesktop → 后端 search 响应形状 { items, total }
export const qqDirectSearch = async (params: Record<string, unknown>): Promise<any> => {
    const keyword = String(params.keyword ?? params.keywords ?? '');
    if (!keyword) throw new OnlineProviderError('invalid-response', 'QQ search needs a keyword', 'qq');
    const page = Number(params.page ?? 1) || 1;
    const limit = Number(params.limit ?? params.pageSize ?? 30) || 30;
    const data = await qqMusicu(
        'music.search.SearchCgiService',
        'DoSearchForQQMusicDesktop',
        { search_type: 0, query: keyword, num_per_page: limit, page_num: page, grp: 1 },
    );
    const songList = data?.body?.song?.list ?? [];
    const total = Number(data?.body?.song?.totalNumber ?? songList.length);
    return {
        items: songList,
        total,
        more: songList.length >= limit,
    };
};

// 取流：CgiGetVkey → 后端 music_play 响应形状 { data: { playUrl: { [songmid]: { url } } } }
export const qqDirectPlay = async (params: Record<string, unknown>): Promise<any> => {
    const songmid = String(params.songmid ?? '');
    if (!songmid) throw new OnlineProviderError('invalid-response', 'QQ play needs a songmid', 'qq');
    const guid = getQqGuid();
    const uin = readQqSessionUin() || '0';
    const data = await qqMusicu(
        'vkey.GetVkeyServer',
        'CgiGetVkey',
        { guid, songmid: [songmid], songtype: [0], uin, loginflag: 1, platform: '20' },
    );
    const entries = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
    const entry = entries[0] ?? {};
    const purl = String(entry?.purl ?? '');
    const playUrlMap: Record<string, { url: string; preview?: boolean }> = {
        [songmid]: { url: purl },
    };
    // 免登录时 purl 为空：把官方给的试听文件名（testfile2g/testfilewifi）补进 preview 字段，
    // provider 的试听路径（requestQqPreviewSource）能拿到片段。
    const wantPreview = Number(params.preview ?? 0) === 1;
    const testFile = String(data?.testfile2g || data?.testfilewifi || '');
    if (wantPreview && testFile) {
        const sip = Array.isArray(data?.sip) && data.sip.length > 0 ? data.sip[0] : 'https://aqqmusic.tc.qq.com/';
        playUrlMap[songmid] = { url: `${sip}${testFile}`, preview: true };
    }
    return { data: { playUrl: playUrlMap } };
};

// ---------- 内置网页登录（安卓 WebView 官方登录页 + Cookie 提取） ----------

const NATIVE_LOGIN_KEY = 'native-web-login';
let nativeLoginPromise: Promise<{ ok: boolean; cookie?: string; message?: string }> | null = null;

const startNativeWebLogin = (): Promise<{ ok: boolean; cookie?: string; message?: string }> => {
    if (nativeLoginPromise) return nativeLoginPromise;
    const started = openProviderWebLogin('qq')
        .then((res) => {
            const cookie = res?.cookie ?? '';
            if (cookie) return { ok: true, cookie };
            return { ok: false, message: res?.cancelled ? '登录已取消' : '未检测到登录 Cookie' };
        })
        .catch((err: any) => ({ ok: false, message: String(err?.message ?? err) }))
        .finally(() => {
            setTimeout(() => { nativeLoginPromise = null; }, 5000);
        });
    nativeLoginPromise = started;
    return nativeLoginPromise;
};

const parseQqCookiePair = (cookie: string, key: string): string => {
    for (const part of cookie.split(';')) {
        const p = part.trim();
        const eq = p.indexOf('=');
        if (eq > 0 && p.substring(0, eq).trim() === key) return p.substring(eq + 1).trim();
    }
    return '';
};

/** 登录成功后把 QQ 会话 Cookie 导入会话存储：整段写 'qq'/'cookie'（上游后端同一键），uin 单独存。 */
const importQqCookie = (cookie: string): { ok: boolean; reason?: string } => {
    const uin = parseQqCookiePair(cookie, 'uin') || parseQqCookiePair(cookie, 'wxuin');
    if (!uin && !cookie.includes('qqmusic_key')) {
        return { ok: false, reason: 'Cookie 中未找到 QQ 音乐登录凭证' };
    }
    writeProviderSessionValue('qq', 'cookie', cookie);
    if (uin) writeProviderSessionValue('qq', 'uin', uin);
    return { ok: true };
};

// 安卓直连统一入口：operation + params → 后端风格 JSON。
export const requestQqDirect = async (
    operation: string,
    params: Record<string, unknown>,
): Promise<any> => {
    switch (operation) {
        case 'login_qr_key': {
            startNativeWebLogin();
            return { data: { unikey: NATIVE_LOGIN_KEY } };
        }
        case 'login_qr_create': {
            // 原生页面已展示官方登录页，这里返回 1x1 透明占位图，UI 会被原生页面遮挡。
            const transparentPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            return { data: { qrimg: transparentPng } };
        }
        case 'login_qr_check': {
            if (!nativeLoginPromise) {
                return { code: 801 };
            }
            const result = await nativeLoginPromise;
            if (result.ok && result.cookie) {
                const imported = importQqCookie(result.cookie);
                if (imported.ok) return { code: 803, cookie: readQqSessionCookie() };
                return { code: 800, message: imported.reason ?? '登录失败' };
            }
            if (result.message?.includes('取消')) {
                return { code: 800 };
            }
            return { code: 801 };
        }
        case 'login_qr_cancel': {
            nativeLoginPromise = null;
            return undefined;
        }
        case 'login_channels': {
            // 直连模式始终提供两个通道：QQ 扫码 + 微信扫码（与上游默认一致）。
            return { data: { channels: ['qq', 'wechat'] } };
        }
        case 'login_refresh': {
            return { data: {} };
        }
        case 'login_status': {
            const uin = readQqSessionUin();
            if (!uin) return { data: { profile: null } };
            return { data: { profile: { uin, nickname: 'QQ音乐用户', avatarUrl: '' } } };
        }
        case 'logout': {
            removeProviderSessionValue('qq', 'cookie');
            removeProviderSessionValue('qq', 'uin');
            return undefined;
        }
        case 'search':
            return qqDirectSearch(params);
        case 'music_play':
            return qqDirectPlay(params);
        default:
            // 未实现的高级操作返回安全空，不让登录/账号链路因辅助调用中断。
            return {};
        
    }
};
