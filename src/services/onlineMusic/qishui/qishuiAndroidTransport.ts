// src/services/onlineMusic/qishuiTransport.ts
// 汽水音乐网络层：运行在 WebView 内，用 window.fetch 发请求；在 Android 上由 FoliaNative
// 原生 HTTP 桥（OkHttp）接管，绕过 CORS 并自动承载特权头。登录 cookie 由本模块自行维护并
// 持久化到 localStorage（不依赖原生 CookieManager 的跨重启行为）。
//
// 仅实现「登录自己账号、播放账号有权限内容」的最小闭环：扫码登录 / 搜索 / 取流 / 个人信息。
// 不实现任何绕过会员或 DRM 的能力。

import { OnlineProviderError } from '../../../types/onlineMusic';
import type { AudioQualityPreference, ProviderUser } from '../../../types/onlineMusic';
import {
    readProviderSessionValue,
    removeProviderSessionValue,
    writeProviderSessionValue,
} from '../providerStorage';
import {
    QISHUI_PROVIDER_ID,
    QISHUI_API,
    QISHUI_UA,
    pcQuery,
    passportHeaders,
    passportHeadersWithCsrf,
    passportQuery,
    buildCheckQrBody,
    buildSendSmsBody,
    buildSmsLoginBody,
    smsPassportQuery,
    explainSmsSendError,
    SESSION_COOKIE_KEYS,
} from './qishuiConstants';
import { coverFromUrlCover } from './qishuiNormalize';

const COOKIE_STORAGE_KEY = 'cookie';
const QR_MIN_POLL_MS = 3500;
const QR_RATE_LIMIT_BACKOFF_MS = 55_000;
// 取二维码是冷启动首个请求，OkHttp 单例 connectTimeout 恒为 20s（无 Happy-Eyeballs，先试被 VPN 黑洞的 IPv6），
// 给到 30s 以便在一次 IPv6→IPv4 回退（约 20s+1s）内救回「慢但能通 / 仅 IPv6 不通」的网络。
const QR_CREATE_TIMEOUT_MS = 30_000;

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

// passport 设备标识：每安装随机生成一次并持久化，避免全网共用固定设备 id 触发风控。
const PASSPORT_DEVICE_KEY = 'passport-device';
type PassportDeviceIds = { deviceId: string; installId: string };
let passportDeviceCache: PassportDeviceIds | null = null;

const getPassportDeviceIds = (): PassportDeviceIds => {
    if (passportDeviceCache) return passportDeviceCache;
    try {
        const raw = readProviderSessionValue(QISHUI_PROVIDER_ID, PASSPORT_DEVICE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PassportDeviceIds>;
            if (parsed.deviceId && parsed.installId) {
                passportDeviceCache = { deviceId: parsed.deviceId, installId: parsed.installId };
                return passportDeviceCache;
            }
        }
    } catch {
        /* 损坏则重新生成 */
    }
    // 时间戳风格数字 id（与参考实现一致），installId = deviceId + 1。
    const base = Date.now();
    const ids = { deviceId: String(base), installId: String(base + 1) };
    passportDeviceCache = ids;
    writeProviderSessionValue(QISHUI_PROVIDER_ID, PASSPORT_DEVICE_KEY, JSON.stringify(ids));
    return ids;
};

// 每次请求一个随机 trace-id（参考实现 passport 请求头携带 X-Tt-Passport-Trace-Id）。
const randomTraceId = (): string => {
    const bytes = new Uint8Array(8);
    try {
        const cryptoObj = globalThis.crypto ?? (typeof window !== 'undefined' ? window.crypto : undefined);
        cryptoObj?.getRandomValues?.(bytes);
    } catch {
        /* 退化为时间戳派生 */
    }
    if (Array.from(bytes).every(b => b === 0)) {
        return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
    }
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
};

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
        // foliaTimeoutMs 是原生桥自定义字段：把本地算出的请求预算透传给安卓 OkHttp 桥，
        // 否则桥会对所有汽水请求一律 15s 硬封顶（即便这里已设 AbortController 也无济于事）。
        const response = await fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
            foliaTimeoutMs: timeoutMs,
        } as RequestInit & { foliaTimeoutMs?: number });
        // 业务域 cookie 合并进会话（扫码登录态在这里落地）。
        const fresh = collectSetCookies(response);
        if (Object.keys(fresh).length) {
            saveCookieMap(mergeCookieMaps(loadCookieMap(), fresh));
        }
        return response;
    } catch (error) {
        // 中止 / 连接或读取超时（含桥侧报的 connect timeout / network unreachable）时给出可操作文案。
        const cause = error instanceof Error ? error : new Error(String(error));
        const isTimeout = cause.name === 'AbortError'
            || /timed out|timeout|failed to connect|network is unreachable|enetunreach/i.test(cause.message);
        const message = isTimeout
            ? `汽水音乐连接超时，请关闭 VPN/代理或切换网络（Wi-Fi/流量）后重试: ${url}`
            : `汽水音乐请求失败: ${url}`;
        throw new OnlineProviderError('network', message, QISHUI_PROVIDER_ID, cause);
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

// 最近 check_qrconnect 原始响应快照，供登录诊断报告输出（沙箱无法真实扫码，这是唯一能看到
// 「手机确认后服务端到底返回了什么」的途径）。
interface CheckSnapshot {
    at: number;
    status: unknown;
    errorCode: unknown;
    accountFlow: unknown;
    description: unknown;
    redirect: unknown;
    cookieKeys: string[];
    hasSession: boolean;
}
const checkHistory: CheckSnapshot[] = [];
const CHECK_HISTORY_LIMIT = 10;
function recordCheck(snapshot: CheckSnapshot): void {
    checkHistory.push(snapshot);
    if (checkHistory.length > CHECK_HISTORY_LIMIT) checkHistory.shift();
}
/** 诊断报告的 qishui details：逐次列出 check_qrconnect 的真实 status/redirect/cookie 状态。 */
export function getQrCheckDiagnosticLines(): string[] {
    if (!checkHistory.length) return ['(no check_qrconnect response recorded)'];
    return checkHistory.map((s, i) => {
        const t = new Date(s.at).toISOString().slice(11, 23);
        const redir = s.redirect ? ` redirect="${String(s.redirect).slice(0, 140)}"` : '';
        const desc = s.description ? ` desc="${String(s.description).slice(0, 140)}"` : '';
        return `#${i} ${t} status=${JSON.stringify(s.status)} code=${s.errorCode}`
            + ` flow=${s.accountFlow ?? '-'} hasSession=${s.hasSession} cookieKeys=[${s.cookieKeys.join(',')}]${redir}${desc}`;
    });
}

export interface QishuiQrCreate {
    token: string;
    /** 可直接放进 <img src> 的二维码图片地址（URL 或 data: URL）。 */
    imageUrl: string;
}

/** 创建扫码会话；返回 token 与二维码图片。 */
export async function createQrLogin(): Promise<QishuiQrCreate> {
    // 首次调用会把 get_qrcode 下发的 passport cookie 收进会话（用于随后 check_qrconnect）。
    const url = `${QISHUI_API}/passport/web/get_qrcode/?${passportQuery('create')}`;
    const response = await qishuiFetch(url, {
        extraHeaders: passportHeaders(),
        timeoutMs: QR_CREATE_TIMEOUT_MS,
    });
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

    // 无论 status 文本是 confirmed/success/done 还是别的，只要服务端给了 redirect_url，
    // session cookie 就挂在它的响应（含重定向中间跳）。原生桥已会沿重定向链收集每一跳 Set-Cookie，
    // 主动 GET redirect_url 收割。
    const redirect = String(data.redirect_url ?? data.redirect ?? '').trim();
    if (redirect.startsWith('http')) {
        try {
            await qishuiFetch(redirect, {
                extraHeaders: passportHeaders(cookieHeaderFromMap(nextJar)),
                cookieOverride: nextJar,
                timeoutMs: 20_000,
            });
            const redirJar = mergeCookieMaps(nextJar, loadCookieMap());
            pending.cookies = redirJar;
            saveCookieMap(redirJar);
            if (hasLoginSession(redirJar)) {
                qrPending.delete(token);
                return { state: 'confirmed' };
            }
        } catch {
            /* redirect 收割失败：继续按 status 分支处理 */
        }
    }

    recordCheck({
        at: Date.now(),
        status: data.status,
        errorCode: data.error_code ?? payload.error_code,
        accountFlow: data.account_flow,
        description: data.description ?? payload.description ?? payload.message,
        redirect: data.redirect_url ?? data.redirect,
        cookieKeys: Object.keys(pending.cookies),
        hasSession: hasLoginSession(pending.cookies),
    });

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
        // redirect_url 已在上面统一收割；若仍未拿到 session，短暂退避后继续轮询，不失败。
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

// ─── 手机号 + 短信验证码登录（passport web SMS）──────────────────────────

export interface SmsSendResult {
    ok: boolean;
    message: string;
    /** 风控返回的 mobile_ticket，需在 sms_login 时回传。 */
    mobileTicket?: string;
    /** 限流时建议的冷却秒数。 */
    retryAfterSec?: number;
}

/** 校验并归一化为 11 位大陆手机号。 */
function normalizeMobile(mobile: string): string {
    const m = mobile.replace(/\D/g, '');
    if (!/^1\d{10}$/.test(m)) {
        throw new Error('手机号需为 11 位中国大陆号码');
    }
    return m;
}

/** 从会话 cookie 取 passport CSRF token。 */
function csrfFromJar(jar: CookieMap): string | undefined {
    return jar.passport_csrf_token || jar.passport_csrf_token_default;
}

/** 把网络层错误（DNS / 超时 / 连接失败）翻成中文可操作提示（真机常因 VPN 导致 api.qishui.com 解析失败）。 */
function explainSmsNetworkError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    if (/Unable to resolve host|No address associated|ENOTFOUND|hostname/i.test(msg)) {
        return '无法连接汽水服务器（域名解析失败）。请关闭 VPN / 代理，或切换 Wi-Fi / 手机流量后重试。';
    }
    if (/timeout|timed out|ETIMEDOUT|SocketTimeout/i.test(msg)) {
        return '连接汽水服务器超时。请检查网络（必要时关闭 VPN / 代理）后重试。';
    }
    if (/Failed to connect|ECONNREFUSED|ECONNRESET|Connection|SSL|TLS/i.test(msg)) {
        return '无法连接汽水服务器。请检查网络后重试。';
    }
    return `网络请求失败：${msg}`;
}

/** 确保会话里有 passport_csrf_token（借 get_qrcode 预热），预热后清掉临时二维码会话。 */
async function warmPassportCsrf(): Promise<void> {
    if (csrfFromJar(loadCookieMap())) return;
    try {
        const qr = await createQrLogin();
        cancelQrLogin(qr.token);
    } catch {
        /* warm 失败不阻断：send_code 仍可能成功 */
    }
}

/**
 * 发送短信验证码：POST /passport/web/send_code/。
 * 1204 风控会返回 mobile_ticket 但不真正下发短信。
 */
export async function sendSmsCode(mobile: string): Promise<SmsSendResult> {
    const m = normalizeMobile(mobile);
    try {
        await warmPassportCsrf();
        const { deviceId, installId } = getPassportDeviceIds();
        const jar = loadCookieMap();
        const url = `${QISHUI_API}/passport/web/send_code/?${smsPassportQuery(deviceId, installId)}`;
        const response = await qishuiFetch(url, {
            method: 'POST',
            form: buildSendSmsBody(m),
            extraHeaders: passportHeadersWithCsrf(cookieHeaderFromMap(jar), csrfFromJar(jar), randomTraceId()),
            cookieOverride: jar,
            timeoutMs: 20_000,
        });
        const payload: any = await response.json().catch(() => null);
        const data = payload?.data ?? {};
        const errorCode = Number(data.error_code ?? 0);
        const desc = String(data.description || payload?.message || '');

        if (payload?.message === 'success' || errorCode === 0) {
            return { ok: true, message: desc || '验证码已发送（请查收短信）', mobileTicket: data.mobile_ticket };
        }
        return {
            ok: false,
            message: explainSmsSendError(errorCode, desc),
            mobileTicket: data.mobile_ticket,
            retryAfterSec: errorCode === 7 || errorCode === 2156 ? 90 : undefined,
        };
    } catch (error) {
        return { ok: false, message: explainSmsNetworkError(error) };
    }
}

/**
 * 手机号 + 验证码登录：POST /passport/web/sms_login/，成功后会话 cookie 已持久化。
 */
export async function smsLogin(
    mobile: string,
    code: string,
    mobileTicket?: string,
): Promise<{ ok: boolean; message: string }> {
    const m = normalizeMobile(mobile);
    const c = code.replace(/\D/g, '');
    if (c.length < 4 || c.length > 8) {
        throw new Error('验证码格式不正确');
    }
    try {
        await warmPassportCsrf();
        const { deviceId, installId } = getPassportDeviceIds();
        const jar = loadCookieMap();
        const url = `${QISHUI_API}/passport/web/sms_login/?${smsPassportQuery(deviceId, installId)}`;
        const response = await qishuiFetch(url, {
            method: 'POST',
            form: buildSmsLoginBody(m, c, mobileTicket),
            extraHeaders: passportHeadersWithCsrf(cookieHeaderFromMap(jar), csrfFromJar(jar), randomTraceId()),
            cookieOverride: jar,
            timeoutMs: 20_000,
        });
        // Set-Cookie 已由 qishuiFetch 收进全局；再从 JSON 补 session 字段。
        const payload: any = await response.json().catch(() => null);
        const data = payload?.data ?? {};
        const nextJar = mergeCookieMaps(loadCookieMap());
        for (const key of SESSION_COOKIE_KEYS) {
            const v = data[key] ?? payload?.[key];
            if (typeof v === 'string' && v) nextJar[key] = v;
        }
        saveCookieMap(nextJar);
        if (hasLoginSession(nextJar)) return { ok: true, message: '登录成功' };

        const errorCode = Number(data.error_code ?? 0);
        const desc = String(data.description || payload?.message || '登录失败');
        return { ok: false, message: desc + (errorCode ? ` (${errorCode})` : '') };
    } catch (error) {
        return { ok: false, message: explainSmsNetworkError(error) };
    }
}

// ─── 个人信息（登录态自检）────────────────────────────────────────────────

export async function getProfile(): Promise<ProviderUser | null> {
    if (!hasLoginSession(loadCookieMap())) return null;
    const url = `${QISHUI_API}/luna/pc/me?${pcQuery()}`;
    // 注意：这里绝不因为一次 me 失败（风控 / aid 不匹配 / 空响应 / 网络抖动）就清空刚导入的会话。
    // 网页扫码登录刚导入的 Cookie 可能需要一拍才在服务端生效；清空会让用户反复登录失败。
    let data: any;
    try {
        data = await qishuiJson<any>(url);
    } catch {
        return null;
    }
    if (data.status_code && data.status_code !== 0) {
        // 业务层未授权（如会话不属于 luna_pc）：保留会话，仅返回 null，由显式登出清理。
        return null;
    }
    const me = data.my_info ?? data.user ?? data.data ?? data;
    const id = String(me.id ?? me.user_id ?? '');
    if (!id) return null;
    return {
        id,
        nickname: String(me.nickname ?? me.public_name ?? id),
        avatarUrl: coverFromUrlCover(me.larger_avatar_url ?? me.medium_avatar_url ?? me.avatar_url ?? me.avatar),
        vipType: Number(me.vip_info?.is_vip ?? me.is_vip ?? 0) ? 1 : 0,
    };
}

// ─── 粘贴 Cookie 登录（短信风控 / 图形验证兜底）────────────────────────────

/**
 * 用户从汽水 App / 网页抓包复制整段 Cookie（含 sessionid 等）粘贴进来，直接建立会话。
 * 只用于登录本人账号；不做 me 失败即清空（避免刚导入、接口瞬时风控被误清）。
 */
export async function importQishuiCookie(rawCookieText: string): Promise<{
    ok: boolean;
    message: string;
    matchedKeys?: string[];
    /** 供真机排查的诊断串（Cookie 键名 + me 接口原始响应），不含 Cookie 值。 */
    diagnostic?: string;
}> {
    const text = String(rawCookieText ?? '').trim();
    if (!text) return { ok: false, message: 'Cookie 为空，请把抓到的完整 Cookie 粘贴进来' };

    // 兼容：去掉 "Cookie:"/"Set-Cookie:" 前缀、首尾引号、多条 -H 拼接，只留 key=value。
    const cleaned = text
        .replace(/(^|[\s;])(?:set-)?cookie\s*:\s*/gi, '; ')
        .replace(/^["'`]+|["'`]+$/g, '');
    const incoming = parseCookiePairs(cleaned);
    if (Object.keys(incoming).length === 0) {
        return { ok: false, message: '没识别到 Cookie，确认复制的是「Cookie:」那一整行（形如 sessionid=…; sid_tt=…）' };
    }
    const sessionKeys = SESSION_COOKIE_KEYS.filter(k => Boolean(incoming[k]));
    if (sessionKeys.length === 0) {
        return {
            ok: false,
            message: `识别到 ${Object.keys(incoming).length} 个字段，但没有会话字段（${SESSION_COOKIE_KEYS.join(' / ')}）。请抓 api.qishui.com 域名下、且已登录的请求。`,
            diagnostic: `识别到的Cookie键: ${Object.keys(incoming).join(',')}`,
        };
    }

    // 合并保留已有 cookie（passport_csrf 等），覆盖同名键。
    const merged = mergeCookieMaps(loadCookieMap(), incoming);
    saveCookieMap(merged);

    // 直接用原始请求探 me（不经过 qishuiJson 的错误归一化），拿到 HTTP 状态 / status_code / body 片段，
    // 这样当会话属于音乐人平台或别的 aid 时，能一眼看出 luna_pc 为什么不认。
    let nickname = '';
    let meLines: string[] = [];
    try {
        const resp = await qishuiFetch(`${QISHUI_API}/luna/pc/me?${pcQuery()}`);
        const raw = await resp.text().catch(() => '');
        let parsed: any = null;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        } catch {
            /* 非 JSON 响应，原样保留片段 */
        }
        const code = parsed?.status_code;
        const statusMsg = parsed?.status_info?.status_msg ?? parsed?.message ?? parsed?.description ?? '';
        const me = parsed?.my_info ?? parsed?.user ?? parsed?.data ?? null;
        const id = me ? (me.id ?? me.user_id) : null;
        if (id) {
            nickname = String(me.nickname ?? me.public_name ?? me.user_id ?? id);
        }
        meLines = [
            `me HTTP ${resp.status}`,
            `status_code=${code ?? '(无)'}`,
            statusMsg ? `msg=${String(statusMsg)}` : '',
            id ? `id=${id} 昵称=${nickname}` : 'me 未含用户字段',
            `body=${raw.slice(0, 200)}`,
        ].filter(Boolean);
    } catch (error) {
        meLines = [`me 请求失败: ${error instanceof Error ? error.message : String(error)}`];
    }

    const diagnostic = [
        `会话键: ${sessionKeys.join(',')}`,
        `全部Cookie键: ${Object.keys(merged).join(',')}`,
        ...meLines,
    ].join('\n');

    return {
        ok: true,
        message: nickname
            ? `登录成功：${nickname}`
            : `已保存会话 Cookie（识别到 ${sessionKeys.join('、')}），但 luna_pc 没读到账号资料，请看下方诊断截图发我。`,
        matchedKeys: sessionKeys.slice() as string[],
        diagnostic,
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
