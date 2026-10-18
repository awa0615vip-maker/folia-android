import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, ShieldCheck } from 'lucide-react';

type SmsSendOutcome = {
    ok: boolean;
    message: string;
    mobileTicket?: string;
    retryAfterSec?: number;
};

type SmsLoginOutcome = { ok: boolean; message: string };

type QishuiSmsLoginFormProps = {
    onSendSms: (mobile: string) => Promise<SmsSendOutcome>;
    onSmsLogin: (mobile: string, code: string, mobileTicket?: string) => Promise<SmsLoginOutcome>;
    onSuccess: () => void;
};

const DEFAULT_COUNTDOWN_SEC = 60;

const inputClass =
    'w-full rounded-xl bg-white/5 border border-white/10 px-3.5 py-2.5 text-sm outline-none focus:border-white/25 transition-colors';

/**
 * 汽水音乐手机号 + 短信验证码登录表单（自包含）。
 * 只登录自己账号；不提供任何会员绕过或 DRM 能力。
 */
const QishuiSmsLoginForm = ({ onSendSms, onSmsLogin, onSuccess }: QishuiSmsLoginFormProps) => {
    const [mobile, setMobile] = useState('');
    const [code, setCode] = useState('');
    const [mobileTicket, setMobileTicket] = useState<string | undefined>(undefined);
    const [countdown, setCountdown] = useState(0);
    const [sending, setSending] = useState(false);
    const [logging, setLogging] = useState(false);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');
    const timerRef = useRef<number | null>(null);

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
        </div>
    );
};

export default QishuiSmsLoginForm;
