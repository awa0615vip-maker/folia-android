import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, QrCode, ShieldCheck } from 'lucide-react';
import { openQishuiWebLogin } from '../../../../services/nativeAndroidBridge';

const isAndroidNative = (): boolean =>
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android';

type SmsSendOutcome = {
    ok: boolean;
    message: string;
    mobileTicket?: string;
    retryAfterSec?: number;
};

type SmsLoginOutcome = { ok: boolean; message: string };
type CookieImportOutcome = { ok: boolean; message: string; diagnostic?: string };

type QishuiSmsLoginFormProps = {
    onSendSms: (mobile: string) => Promise<SmsSendOutcome>;
    onSmsLogin: (mobile: string, code: string, mobileTicket?: string) => Promise<SmsLoginOutcome>;
    /** 短信被风控 / 图形验证过不去时的兜底：粘贴整段 Cookie 登录本人账号。 */
    onImportCookie?: (cookieText: string) => Promise<CookieImportOutcome>;
    onSuccess: () => void;
};

const DEFAULT_COUNTDOWN_SEC = 60;

const inputClass =
    'w-full rounded-xl bg-white/5 border border-white/10 px-3.5 py-2.5 text-sm outline-none focus:border-white/25 transition-colors';

/**
 * 汽水音乐手机号 + 短信验证码登录表单（自包含）。
 * 只登录自己账号；不提供任何会员绕过或 DRM 能力。
 * 短信收不到（平台风控 / 图形验证）时，可展开底部的「粘贴 Cookie 登录」兜底。
 */
const QishuiSmsLoginForm = ({ onSendSms, onSmsLogin, onImportCookie, onSuccess }: QishuiSmsLoginFormProps) => {
    const [mobile, setMobile] = useState('');
    const [code, setCode] = useState('');
    const [mobileTicket, setMobileTicket] = useState<string | undefined>(undefined);
    const [countdown, setCountdown] = useState(0);
    const [sending, setSending] = useState(false);
    const [logging, setLogging] = useState(false);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');
    const timerRef = useRef<number | null>(null);
    // Cookie 兜底
    const [showCookie, setShowCookie] = useState(false);
    const [cookieText, setCookieText] = useState('');
    const [cookieBusy, setCookieBusy] = useState(false);
    const [webBusy, setWebBusy] = useState(false);
    const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) window.clearInterval(timerRef.current);
        };
    }, []);

    useEffect(() => {
        if (countdown <= 0) {
            if (timerRef.current) {
                window.clearInterval(timerRef.current);
                timerRef.current = null;
            }
            return;
        }
        if (!timerRef.current) {
            timerRef.current = window.setInterval(() => {
                setCountdown(prev => (prev > 0 ? prev - 1 : 0));
            }, 1000);
        }
    }, [countdown]);

    const digits = mobile.replace(/\D/g, '');
    const mobileValid = /^1\d{10}$/.test(digits);
    const codeDigits = code.replace(/\D/g, '');
    const codeValid = codeDigits.length >= 4;

    const handleSend = async () => {
        setError('');
        setInfo('');
        if (!mobileValid) {
            setError('请输入 11 位中国大陆手机号');
            return;
        }
        setSending(true);
        try {
            const result = await onSendSms(digits);
            if (!result.ok) {
                setError(result.message);
                if (result.retryAfterSec) setCountdown(result.retryAfterSec);
                return;
            }
            setMobileTicket(result.mobileTicket);
            setInfo(result.message || '验证码已发送，请查收短信');
            setCountdown(result.retryAfterSec ?? DEFAULT_COUNTDOWN_SEC);
        } catch (e) {
            setError(e instanceof Error ? e.message : '验证码请求失败，请重试');
        } finally {
            setSending(false);
        }
    };

    const handleLogin = async () => {
        setError('');
        setInfo('');
        if (!mobileValid) {
            setError('请输入 11 位中国大陆手机号');
            return;
        }
        if (!codeValid) {
            setError('请输入收到的短信验证码');
            return;
        }
        setLogging(true);
        try {
            const result = await onSmsLogin(digits, codeDigits, mobileTicket);
            if (!result.ok) {
                setError(result.message);
                return;
            }
            setInfo('登录成功');
            onSuccess();
        } catch (e) {
            setError(e instanceof Error ? e.message : '登录失败，请重试');
        } finally {
            setLogging(false);
        }
    };

    const handleImportCookie = async () => {
        if (!onImportCookie) return;
        setCookieMsg(null);
        const text = cookieText.trim();
        if (!text) {
            setCookieMsg({ ok: false, text: '请先粘贴 Cookie' });
            return;
        }
        setCookieBusy(true);
        try {
            const result = await onImportCookie(text);
            if (!result.ok) {
                setCookieMsg({ ok: false, text: result.message });
                return;
            }
            setCookieMsg({ ok: true, text: result.message });
            onSuccess();
        } catch (e) {
            setCookieMsg({ ok: false, text: e instanceof Error ? e.message : 'Cookie 登录失败，请重试' });
        } finally {
            setCookieBusy(false);
        }
    };

    // 内置网页扫码登录：打开原生 WebView，登录后自动带出 Cookie 并导入。
    const handleWebLogin = async () => {
        if (!onImportCookie) return;
        setCookieMsg(null);
        setWebBusy(true);
        try {
            const { cancelled, cookie, url: landedUrl, cookieKeys: webCookieKeys } = await openQishuiWebLogin();
            if (cancelled || !cookie.trim()) return;
            const result = await onImportCookie(cookie);
            // 把落地页、网页 Cookie 键、luna_pc 的 me 自检结果全部展示，方便截图定位。
            const text = [
                result.message,
                landedUrl ? `网页落地页: ${landedUrl}` : '',
                webCookieKeys ? `网页读到的Cookie键: ${webCookieKeys}` : '',
                result.diagnostic ? `【服务端自检】\n${result.diagnostic}` : '',
            ].filter(Boolean).join('\n');
            if (!result.ok) {
                setCookieMsg({ ok: false, text });
                return;
            }
            setCookieMsg({ ok: true, text });
            // 只有真正读到账号昵称才算完全登录，才自动关窗；否则保留窗口显示诊断，供截图反馈。
            if (result.message.startsWith('登录成功：')) {
                onSuccess();
            }
        } catch (e) {
            setCookieMsg({ ok: false, text: e instanceof Error ? e.message : '网页登录失败，请重试' });
        } finally {
            setWebBusy(false);
        }
    };

    return (
        <div className="w-full text-left">
            <div className="flex items-center gap-2 mb-4 text-[11px] opacity-55" style={{ color: 'var(--text-secondary)' }}>
                <ShieldCheck size={14} />
                <span>仅登录本人账号，不提供会员破解或 DRM 绕过</span>
            </div>

            <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45 mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                手机号
            </label>
            <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={11}
                value={mobile}
                onChange={e => setMobile(e.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="请输入 11 位手机号"
                className={inputClass}
                style={{ color: 'var(--text-primary)' }}
            />

            <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] opacity-45 mb-1.5 mt-4" style={{ color: 'var(--text-secondary)' }}>
                短信验证码
            </label>
            <div className="flex items-center gap-2">
                <input
                    type="tel"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="6 位验证码"
                    className={`${inputClass} flex-1`}
                    style={{ color: 'var(--text-primary)' }}
                />
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || countdown > 0 || !mobileValid}
                    className="shrink-0 rounded-xl bg-white/10 border border-white/10 px-3 py-2.5 text-xs font-medium transition-colors hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {sending
                        ? <Loader2 size={14} className="animate-spin" />
                        : countdown > 0
                            ? `${countdown}s`
                            : <span className="flex items-center gap-1"><MessageSquare size={13} />获取验证码</span>}
                </button>
            </div>

            {info && (
                <p className="mt-3 text-[11px] leading-snug opacity-70" style={{ color: 'var(--text-secondary)' }}>{info}</p>
            )}
            {error && (
                <p className="mt-3 text-[11px] leading-snug text-rose-400">{error}</p>
            )}

            <button
                type="button"
                onClick={handleLogin}
                disabled={logging || !mobileValid || !codeValid}
                className="mt-5 w-full rounded-xl bg-white/10 border border-white/10 py-2.5 text-sm font-semibold transition-colors hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                style={{ color: 'var(--text-primary)' }}
            >
                {logging ? <Loader2 size={15} className="animate-spin" /> : '登录'}
            </button>

            {onImportCookie ? (
                <div className="mt-4 border-t border-white/10 pt-3">
                    <button
                        type="button"
                        onClick={() => setShowCookie(v => !v)}
                        className="text-[11px] opacity-60 hover:opacity-100 transition-opacity"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {showCookie ? '收起 ▲' : '收不到短信 / 图形验证过不去？用 Cookie 登录 ▼'}
                    </button>
                    {showCookie ? (
                        <div className="mt-3">
                            {isAndroidNative() ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleWebLogin}
                                        disabled={webBusy || cookieBusy}
                                        className="w-full rounded-xl bg-white/5 border border-white/10 py-2.5 text-sm font-semibold transition-colors hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                                        style={{ background: '#10B981', color: '#fff', borderColor: 'transparent' }}
                                    >
                                        {webBusy ? <Loader2 size={16} className="animate-spin" /> : <QrCode size={16} />}
                                        {webBusy ? '正在登录…' : '用汽水 App 扫码登录（最简单，不用抓包）'}
                                    </button>
                                    <p className="text-[11px] leading-snug opacity-55 mt-2 mb-3" style={{ color: 'var(--text-secondary)' }}>
                                        点上面按钮 → 弹出汽水官方网页 → 用手机上的汽水 App 扫码并确认 → 自动登录。
                                    </p>
                                    <div className="flex items-center gap-2 mb-2 opacity-60">
                                        <span className="flex-1 h-px bg-white/10" />
                                        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>扫码不行？手动粘贴 Cookie</span>
                                        <span className="flex-1 h-px bg-white/10" />
                                    </div>
                                </>
                            ) : null}
                            <p className="text-[11px] leading-snug opacity-55 mb-2" style={{ color: 'var(--text-secondary)' }}>
                                1. 在手机装「Stream 抓包」或「Reqable」（免费免 root），开始抓包并信任证书；<br />
                                2. 打开汽水音乐 App，确认已登录，随便点一下首页；<br />
                                3. 找一条 <span style={{ opacity: 0.9 }}>api.qishui.com</span> 的请求，复制请求头里整段 Cookie，粘到下面。
                            </p>
                            <textarea
                                value={cookieText}
                                onChange={e => setCookieText(e.target.value)}
                                placeholder="粘贴形如 sessionid=…; sessionid_ss=…; sid_tt=… 的整段 Cookie"
                                rows={3}
                                className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-[11px] outline-none focus:border-white/25 font-mono break-all"
                                style={{ color: 'var(--text-primary)' }}
                            />
                            <button
                                type="button"
                                onClick={handleImportCookie}
                                disabled={cookieBusy || !cookieText.trim()}
                                className="mt-2 w-full rounded-xl bg-white/10 border border-white/10 py-2 text-xs font-semibold transition-colors hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                                style={{ color: 'var(--text-primary)' }}
                            >
                                {cookieBusy ? <Loader2 size={14} className="animate-spin" /> : '用 Cookie 登录'}
                            </button>
                            {cookieMsg ? (
                                <div className="mt-2">
                                    <p className={`text-[11px] leading-snug ${cookieMsg.ok ? 'opacity-90' : 'text-rose-400'}`}
                                       style={{
                                           color: cookieMsg.ok ? 'var(--text-secondary)' : undefined,
                                           whiteSpace: 'pre-wrap',
                                           wordBreak: 'break-all',
                                           maxHeight: 240,
                                           overflowY: 'auto',
                                           background: 'rgba(255,255,255,0.04)',
                                           border: '1px solid rgba(255,255,255,0.08)',
                                           borderRadius: 10,
                                           padding: '8px 10px',
                                           WebkitUserSelect: 'text',
                                           userSelect: 'text',
                                       }}>
                                        {cookieMsg.text}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => { try { navigator.clipboard?.writeText(cookieMsg.text); } catch { /* 忽略 */ } }}
                                        className="mt-1 text-[10px] underline opacity-70 cursor-pointer"
                                        style={{ color: 'var(--text-secondary)' }}
                                    >
                                        复制诊断（发给豆包）
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

export default QishuiSmsLoginForm;
