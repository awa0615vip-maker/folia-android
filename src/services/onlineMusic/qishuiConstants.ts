// src/services/onlineMusic/qishuiConstants.ts
// 汽水音乐（字节 Luna PC）接口常量。移植自 ly-music-source (GPL-3.0) 的纯 TS 实现，
// 去掉了 Node 依赖：设备 ID 由 localStorage 持久化，网络层走 window.fetch（安卓上由
// FoliaNative 原生 HTTP 桥接管，绕过 CORS）。

export const QISHUI_PROVIDER_ID = 'qishui';

export const QISHUI_AID = '386088';
export const QISHUI_APP_NAME = 'luna_pc';
/** Luna PC 客户端 UA（/luna/pc/* 业务接口）。 */
export const QISHUI_UA = 'LunaPC/3.5.2(412998333)';
/** passport 网页扫码接口用的桌面 Chrome UA。 */
export const QISHUI_PASSPORT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const QISHUI_API = 'https://api.qishui.com';
export const QISHUI_BFF_PC = 'https://bff-pc.qishui.com';
export const QISHUI_PASSPORT_JSSDK_VERSION = '2.4.13';
export const QISHUI_VERSION_NAME = '3.5.2';
export const QISHUI_VERSION_CODE = '30050200';

// 与 ly-music-source 一致的公开默认设备标识（业务接口只要求字段齐全）。
export const DEFAULT_DEVICE_ID = '3753066532709850';
export const DEFAULT_IID = '3753066532713946';

/** /luna/pc/* 业务接口的公共 query 参数。 */
export function pcQuery(extra: Record<string, string | number | undefined> = {}): string {
    const params = new URLSearchParams({
        aid: QISHUI_AID,
        app_name: QISHUI_APP_NAME,
        region: 'cn',
        geo_region: 'cn',
        os_region: 'cn',
        sim_region: '',
        device_id: DEFAULT_DEVICE_ID,
        cdid: '',
        iid: DEFAULT_IID,
        version_name: QISHUI_VERSION_NAME,
        version_code: QISHUI_VERSION_CODE,
        channel: 'official',
        build_mode: 'master',
        network_carrier: '',
        ac: 'wifi',
        tz_name: 'Asia/Shanghai',
        resolution: '',
        device_platform: 'windows',
        device_type: 'Windows',
        os_version: 'Windows 10',
        fp: DEFAULT_DEVICE_ID,
    });
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params.toString();
}

/**
 * passport 扫码接口使用「human」最简 query（不挂 a_bogus / msToken）。
 * 参考 PopDownloader / 精简网页客户端：字段越少越不容易被风控，签名反而常因版本不匹配失败。
 */
export function passportQuery(kind: 'create' | 'check'): string {
    const params = new URLSearchParams();
    params.set('passport_jssdk_version', QISHUI_PASSPORT_JSSDK_VERSION);
    params.set('passport_jssdk_type', 'normal');
    params.set('is_from_ttaccountsdk', '1');
    params.set('aid', QISHUI_AID);
    if (kind === 'create') params.set('next', QISHUI_API);
    return params.toString();
}

/** check_qrconnect 请求体（urlencoded）。 */
export function buildCheckQrBody(token: string): string {
    const pairs: Array<[string, string]> = [
        ['need_logo', 'false'],
        ['need_short_url', 'false'],
        ['is_frontier', 'true'],
        ['token', token],
        ['is_new_login', '1'],
        ['next', QISHUI_API],
    ];
    return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** passport 网页扫码请求头（伪装成 qishui.com 页面的 XHR）。 */
export function passportHeaders(cookie?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': QISHUI_PASSPORT_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.qishui.com',
        Referer: 'https://www.qishui.com/',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
}

export const SESSION_COOKIE_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'] as const;
