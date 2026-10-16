import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import type { SleepTimerMode } from '../../stores/useSleepTimerStore';
import { DioramaSettingsToggle } from '../visualizer/diorama/DioramaSettingsToggle';

// src/components/command-palette/SleepTimerControl.tsx

type SleepTimerControlProps = {
    isDaylight: boolean;
    theme: Theme;
    enabled: boolean;
    hours: number;
    minutes: number;
    mode: SleepTimerMode;
    deadlineMs: number | null;
    currentTrackName: string | null;
    queryFeedback: { isError: boolean; text: string } | null;
    onEnabledChange: (enabled: boolean) => void;
    onHoursChange: (hours: number) => void;
    onMinutesChange: (minutes: number) => void;
    onModeChange: (mode: SleepTimerMode) => void;
    /** 选择快捷预设：一次性设置时长并开启定时器。 */
    onPresetSelect: (totalMinutes: number) => void;
    /** 倒计时进行中再延长若干分钟。 */
    onExtend: (minutes: number) => void;
};

const formatRemaining = (remainingMs: number) => {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

// 常用快捷时长（分钟）。
const SLEEP_TIMER_PRESETS = [15, 30, 45, 60, 90];
// 进行中可延长的时长（分钟）。
const SLEEP_TIMER_EXTEND_OPTIONS = [5, 10, 15];

type NumberFieldProps = {
    isDaylight: boolean;
    label: string;
    max: number;
    value: number;
    onChange: (next: number) => void;
};

// Numeric field that blocks illegal input: everything but digits is stripped, and any value
// above `max` is refused (the field keeps its previous value).
const SleepTimerNumberField: React.FC<NumberFieldProps> = ({ isDaylight, label, max, value, onChange }) => {
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const digits = event.currentTarget.value.replace(/\D/g, '');
        if (digits === '') {
            onChange(0);
            return;
        }
        const next = Number(digits);
        if (next > max) {
            return;
        }
        onChange(next);
    };

    return (
        <input
            type="text"
            inputMode="numeric"
            maxLength={max > 99 ? 3 : 2}
            value={String(value)}
            onChange={handleChange}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={label}
            className={`w-16 rounded-lg border px-3 py-2 text-center text-sm outline-none transition-colors ${isDaylight
                ? 'border-black/10 bg-white/60 text-zinc-900'
                : 'border-white/10 bg-black/40 text-white'
                }`}
        />
    );
};

// 模式切换按钮组。
const ModeSwitch: React.FC<{
    isDaylight: boolean;
    theme: Theme;
    mode: SleepTimerMode;
    onModeChange: (mode: SleepTimerMode) => void;
}> = ({ isDaylight, theme, mode, onModeChange }) => {
    const { t } = useTranslation();
    const modes: Array<{ id: SleepTimerMode; label: string }> = [
        { id: 'duration', label: t('commandPalette.sleepTimerModeDuration', 'Countdown') },
        { id: 'trackEnd', label: t('commandPalette.sleepTimerModeTrackEnd', 'After this track') },
    ];
    return (
        <div className={`mb-7 inline-flex rounded-full border p-1 ${isDaylight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-white/5'}`}>
            {modes.map((item) => {
                const isActive = item.id === mode;
                return (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => onModeChange(item.id)}
                        aria-pressed={isActive}
                        className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${isActive ? 'text-white' : isDaylight ? 'text-zinc-700' : 'text-white/70'}`}
                        style={isActive ? { backgroundColor: theme.accentColor } : undefined}
                    >
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
};

const SleepTimerControl: React.FC<SleepTimerControlProps> = ({
    isDaylight,
    theme,
    enabled,
    hours,
    minutes,
    mode,
    deadlineMs,
    currentTrackName,
    queryFeedback,
    onEnabledChange,
    onHoursChange,
    onMinutesChange,
    onModeChange,
    onPresetSelect,
    onExtend,
}) => {
    const { t } = useTranslation();
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        if (!enabled || deadlineMs === null || mode !== 'duration') {
            return;
        }
        setNowMs(Date.now());
        const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [deadlineMs, enabled, mode]);

    const configuredTotalMinutes = hours * 60 + minutes;
    const remainingMs = enabled && deadlineMs !== null ? Math.max(0, deadlineMs - nowMs) : null;
    const durationHint = !enabled
        ? t('commandPalette.sleepTimerDisabledHint', 'Turn it on to start the timer')
        : configuredTotalMinutes === 0
            ? t('commandPalette.sleepTimerZeroHint', 'Choose a duration greater than zero')
            : t(
                window.electron?.quitApp
                    ? 'commandPalette.sleepTimerCountdownHint'
                    : 'commandPalette.sleepTimerPauseCountdownHint',
                window.electron?.quitApp ? 'Closing in {{time}}' : 'Pausing playback in {{time}}',
            )
                .replace('{{time}}', formatRemaining(remainingMs ?? configuredTotalMinutes * 60 * 1000));
    const trackEndHint = !enabled
        ? t('commandPalette.sleepTimerDisabledHint', 'Turn it on to start the timer')
        : t('commandPalette.sleepTimerTrackEndHint', 'Pausing after the current track ends');
    const hint = queryFeedback?.text ?? (mode === 'trackEnd' ? trackEndHint : durationHint);

    return (
        <div className="flex h-full items-center justify-center px-4 py-10">
            <div className="w-full max-w-lg px-6 py-7">
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <Timer size={22} style={{ color: theme.accentColor }} />
                        <div>
                            <div className="text-sm font-medium">{t('commandPalette.sleepTimerTitle', 'Sleep timer')}</div>
                            <div
                                className={`mt-0.5 max-w-[300px] truncate text-xs tabular-nums ${queryFeedback?.isError ? 'text-red-400' : 'opacity-50'}`}
                                aria-live="polite"
                            >
                                {hint}
                            </div>
                        </div>
                    </div>
                    <DioramaSettingsToggle
                        checked={enabled}
                        label={t('commandPalette.sleepTimerTitle', 'Sleep timer')}
                        onChange={onEnabledChange}
                        theme={theme}
                        isDaylight={isDaylight}
                    />
                </div>

                <div className="flex justify-center">
                    <ModeSwitch isDaylight={isDaylight} theme={theme} mode={mode} onModeChange={onModeChange} />
                </div>

                {mode === 'trackEnd' ? (
                    <div className="text-center">
                        <div className={`rounded-xl border px-4 py-5 text-sm ${isDaylight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-white/5'}`}>
                            <div className="opacity-50 text-xs mb-1.5">{t('commandPalette.sleepTimerTrackEndCurrent', 'Current track')}</div>
                            <div className="font-medium truncate">{currentTrackName || '—'}</div>
                        </div>
                        {enabled && (
                            <div className="mt-7 flex justify-center">
                                <button
                                    type="button"
                                    onClick={() => onEnabledChange(false)}
                                    className={`rounded-full px-5 py-2 text-sm transition-colors ${isDaylight
                                        ? 'bg-black/5 text-zinc-800 hover:bg-black/10'
                                        : 'bg-white/10 text-white hover:bg-white/20'
                                        }`}
                                >
                                    {t('commandPalette.sleepTimerCancelPreset', 'Cancel timer')}
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <>
                        {/* 快捷预设：点一下即可设置并开启，到期自动暂停。 */}
                        <div className="mb-2 text-xs font-medium opacity-50">
                            {t('commandPalette.sleepTimerPresetsLabel', 'Quick presets')}
                        </div>
                        <div className="mb-7 flex flex-wrap items-center justify-center gap-2">
                            {SLEEP_TIMER_PRESETS.map((preset) => {
                                const isActivePreset = enabled && configuredTotalMinutes === preset;
                                return (
                                    <button
                                        key={preset}
                                        type="button"
                                        onClick={() => onPresetSelect(preset)}
                                        aria-pressed={isActivePreset}
                                        className={`rounded-full border px-4 py-1.5 text-sm tabular-nums transition-colors ${isActivePreset
                                            ? 'border-transparent text-white'
                                            : isDaylight
                                                ? 'border-black/10 bg-white/50 text-zinc-800 hover:bg-black/5'
                                                : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                                            }`}
                                        style={isActivePreset
                                            ? { backgroundColor: theme.accentColor }
                                            : undefined}
                                    >
                                        {t('commandPalette.sleepTimerPresetMinutes', '{{minutes}} min')
                                            .replace('{{minutes}}', String(preset))}
                                    </button>
                                );
                            })}
                        </div>

                        {/* 自定义时长。 */}
                        <div className="mb-2 text-xs font-medium opacity-50">
                            {t('commandPalette.sleepTimerCustomLabel', 'Custom')}
                        </div>
                        <div className="flex items-center justify-center gap-3">
                            <SleepTimerNumberField
                                isDaylight={isDaylight}
                                label={t('commandPalette.sleepTimerHoursLabel', 'Hours')}
                                max={999}
                                value={hours}
                                onChange={onHoursChange}
                            />
                            <span className={`text-sm font-semibold ${isDaylight ? 'text-black/50' : 'text-white/50'}`}>h</span>
                            <SleepTimerNumberField
                                isDaylight={isDaylight}
                                label={t('commandPalette.sleepTimerMinutesLabel', 'Minutes')}
                                max={59}
                                value={minutes}
                                onChange={onMinutesChange}
                            />
                            <span className={`text-sm font-semibold ${isDaylight ? 'text-black/50' : 'text-white/50'}`}>min</span>
                        </div>

                        {/* 激活后：延长 + 取消。 */}
                        {enabled && (
                            <div className="mt-7 space-y-3">
                                <div className="flex flex-wrap items-center justify-center gap-2">
                                    <span className="text-xs opacity-50 mr-1">{t('commandPalette.sleepTimerExtendLabel', 'Extend')}</span>
                                    {SLEEP_TIMER_EXTEND_OPTIONS.map((extra) => (
                                        <button
                                            key={extra}
                                            type="button"
                                            onClick={() => onExtend(extra)}
                                            className={`rounded-full border px-3.5 py-1.5 text-xs tabular-nums transition-colors ${isDaylight
                                                ? 'border-black/10 bg-white/50 text-zinc-800 hover:bg-black/5'
                                                : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                                                }`}
                                        >
                                            +{extra}
                                        </button>
                                    ))}
                                </div>
                                <div className="flex justify-center">
                                    <button
                                        type="button"
                                        onClick={() => onEnabledChange(false)}
                                        className={`rounded-full px-5 py-2 text-sm transition-colors ${isDaylight
                                            ? 'bg-black/5 text-zinc-800 hover:bg-black/10'
                                            : 'bg-white/10 text-white hover:bg-white/20'
                                            }`}
                                    >
                                        {t('commandPalette.sleepTimerCancelPreset', 'Cancel timer')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default SleepTimerControl;
