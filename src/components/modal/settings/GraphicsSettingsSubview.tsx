import React, { useState } from 'react';
import { Download, Gauge, MonitorCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import type { Theme, VisualizerFrameRate } from '../../../types';
import { VISUALIZER_FRAME_RATE_OPTIONS } from '../../../utils/frameRateLimiter';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import ThemedDialog from '../../shared/ThemedDialog';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import MotionReductionSettingsSection from './MotionReductionSettingsSection';
import AndroidUpdateSection from './AndroidUpdateSection';
import SettingsRow, { SettingsToggle } from './SettingsRow';
import { settingsDividerClassFor } from './settingsCardClasses';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { usePlayerChromeSettingsStore } from '../../../stores/usePlayerChromeSettingsStore';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import {
    resolveEffectiveTier,
    usePerformanceTierStore,
    type PerformanceModePreference,
} from '../../../stores/usePerformanceTierStore';

// 性能模式分段选项（自动跟随硬件 / 手动强制三档）。
const PERF_MODE_OPTIONS: ReadonlyArray<{ value: PerformanceModePreference; label: string }> = [
    { value: 'auto', label: '自动' },
    { value: 'high', label: '高画质' },
    { value: 'balanced', label: '均衡' },
    { value: 'low', label: '省电' },
];

const TIER_LABELS: Record<string, string> = {
    high: '高画质',
    balanced: '均衡',
    low: '省电',
};

// src/components/modal/settings/GraphicsSettingsSubview.tsx
// Everything that trades picture for smoothness or works around a renderer problem: static mode,
// the home background, native blur, the frame-rate cap, the Linux glow fix and reduced motion.
// Moved out of the lab page, where these sat among unrelated player-chrome switches.

/** Docs page behind the "Fix lyric animation freeze on Linux" switch. */
const CHROMIUM_FD_EXHAUSTION_DOCS_URL = 'https://folia-site.cielaniska.top/guide/chromium-fd-exhaustion';

/** On desktop a plain link would open inside the app window; hand it to the system browser instead. */
const openDocsLinkExternally = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!window.electron?.openExternalUrl) return;
    event.preventDefault();
    void window.electron.openExternalUrl(event.currentTarget.href);
};

const getFrameRateLabel = (frameRate: VisualizerFrameRate) => `${frameRate} FPS`;

type GraphicsSettingsSubviewProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    toggleOffBackgroundClass: string;
    utilityGhostButtonClass: string;
    rangeInputClass: string;
    theme?: Theme;
};

const GraphicsSettingsSubview: React.FC<GraphicsSettingsSubviewProps> = ({
    isDaylight,
    settingsCardClass,
    toggleOffBackgroundClass,
    utilityGhostButtonClass,
    rangeInputClass,
    theme,
}) => {
    const { t } = useTranslation();
    const [isNativeBlurNoticeOpen, setIsNativeBlurNoticeOpen] = useState(false);
    const {
        disableHomeDynamicBackground,
        staticMode,
        onToggleDisableHomeDynamicBackground,
        onToggleStaticMode,
    } = useThemeSettingsStore(useShallow(state => ({
        disableHomeDynamicBackground: state.disableHomeDynamicBackground,
        staticMode: state.staticMode,
        onToggleDisableHomeDynamicBackground: state.handleToggleDisableHomeDynamicBackground,
        onToggleStaticMode: state.handleToggleStaticMode,
    })));
    const enablePlayerPageNativeBlur = usePlayerChromeSettingsStore(state => state.enablePlayerPageNativeBlur);
    const onTogglePlayerPageNativeBlur = usePlayerChromeSettingsStore(state => state.handleTogglePlayerPageNativeBlur);
    const visualizerFrameRate = useVisualizerSettingsStore(state => state.visualizerFrameRate);
    const onVisualizerFrameRateChange = useVisualizerSettingsStore(state => state.handleSetVisualizerFrameRate);
    const glowBlurQuantize = useVisualizerSettingsStore(state => state.glowBlurQuantize);
    const onToggleGlowBlurQuantize = useVisualizerSettingsStore(state => state.handleToggleGlowBlurQuantize);

    // 自适应性能引擎：性能模式（自动/高画质/均衡/省电）与检测到的设备信息。
    const perfMode = usePerformanceTierStore(state => state.mode);
    const setPerfMode = usePerformanceTierStore(state => state.setPerformanceMode);
    const deviceCapabilities = usePerformanceTierStore(state => state.capabilities);
    const effectiveTier = usePerformanceTierStore(state => resolveEffectiveTier(state));
    const deviceInfo = (() => {
        const sig = deviceCapabilities.signals;
        const mem = sig.deviceMemoryGb !== null ? `内存 ${sig.deviceMemoryGb}GB` : null;
        const cores = sig.hardwareConcurrency !== null ? `${sig.hardwareConcurrency} 核 CPU` : null;
        const gpu = sig.gpuRenderer ? `GPU ${sig.gpuRenderer}` : null;
        const screen = sig.screenWidth > 0
            ? `${sig.screenWidth}×${sig.screenHeight} @${sig.devicePixelRatio}x`
            : null;
        return [mem, cores, screen, gpu].filter(Boolean).join(' · ');
    })();

    const dividerClass = settingsDividerClassFor(isDaylight);
    const isLinux = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('linux');
    const isVisualizerFrameRateLimiterEnabled = visualizerFrameRate !== 'off';
    const selectedVisualizerFrameRate = isVisualizerFrameRateLimiterEnabled ? visualizerFrameRate : 120;
    const selectedVisualizerFrameRateIndex = VISUALIZER_FRAME_RATE_OPTIONS.indexOf(selectedVisualizerFrameRate);

    const renderToggle = (checked: boolean, onChange: () => void) => (
        <SettingsToggle checked={checked} onChange={onChange} offClass={toggleOffBackgroundClass} onColor={theme?.secondaryColor} />
    );

    // Native blur can drop frames on some GPUs, so switching it on goes through a confirmation.
    const handleNativeBlurToggle = () => {
        if (enablePlayerPageNativeBlur) {
            onTogglePlayerPageNativeBlur(false);
            return;
        }
        setIsNativeBlurNoticeOpen(true);
    };

    const confirmNativeBlur = () => {
        onTogglePlayerPageNativeBlur(true);
        setIsNativeBlurNoticeOpen(false);
    };

    const handleFrameRateSliderChange = (value: string) => {
        const nextIndex = Math.min(VISUALIZER_FRAME_RATE_OPTIONS.length - 1, Math.max(0, Number(value)));
        onVisualizerFrameRateChange(VISUALIZER_FRAME_RATE_OPTIONS[nextIndex]);
    };

    return (
        <div className="space-y-5">
            <SettingsAnchor anchorId="graphicsPerformance" label={t('options.labPerformanceSection')} className="space-y-4">
                <SettingsSectionHeading icon={MonitorCog} label={t('options.labPerformanceSection')} />
                <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                    <SettingsRow
                        title="性能模式"
                        description={perfMode === 'auto'
                            ? `自动识别设备配置并调整渲染、特效与帧率，当前判定为「${TIER_LABELS[effectiveTier]}」`
                            : '手动指定性能档位，将覆盖自动识别'}
                        dividerClass={dividerClass}
                    >
                        <div className="space-y-3">
                            <div className="grid grid-cols-4 gap-1.5">
                                {PERF_MODE_OPTIONS.map(option => {
                                    const selected = perfMode === option.value;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => setPerfMode(option.value)}
                                            className="rounded-lg border px-2 py-2 text-xs font-medium transition-colors"
                                            style={selected
                                                ? {
                                                    backgroundColor: theme?.accentColor || '#3b82f6',
                                                    borderColor: theme?.accentColor || '#3b82f6',
                                                    color: '#fff',
                                                }
                                                : {
                                                    borderColor: 'var(--border-color, rgba(255,255,255,0.12))',
                                                    color: 'var(--text-secondary)',
                                                }}
                                        >
                                            {option.label}
                                        </button>
                                    );
                                })}
                            </div>
                            {deviceInfo && (
                                <div className="text-[11px] leading-5 opacity-60 break-words" style={{ color: 'var(--text-secondary)' }}>
                                    检测到：{deviceInfo}
                                </div>
                            )}
                            <div className="text-[11px] leading-5 opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                省电档会回收离屏卡片、关闭毛玻璃与重阴影、可视化器转静态并锁 30 帧；均衡档保持外观、降低渲染量；高画质满血。
                            </div>
                        </div>
                    </SettingsRow>
                </div>
                <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
                    <SettingsRow
                        title={t('options.enableStaticMode')}
                        description={t('options.enableStaticModeDesc')}
                        note={t('options.enableStaticModeDescSub')}
                        control={renderToggle(staticMode, () => onToggleStaticMode(!staticMode))}
                        dividerClass={dividerClass}
                    />
                    <SettingsRow
                        title={t('options.disableHomeDynamicBackground')}
                        description={t('options.disableHomeDynamicBackgroundDesc')}
                        note={t('options.disableHomeDynamicBackgroundWarning')}
                        control={renderToggle(disableHomeDynamicBackground, () => onToggleDisableHomeDynamicBackground(!disableHomeDynamicBackground))}
                        dividerClass={dividerClass}
                    />
                    {!isLinux && (
                        <SettingsRow
                            title={t('options.enablePlayerPageNativeBlur')}
                            description={t('options.enablePlayerPageNativeBlurDesc')}
                            control={renderToggle(enablePlayerPageNativeBlur, handleNativeBlurToggle)}
                            dividerClass={dividerClass}
                        />
                    )}
                    <SettingsRow
                        title={t('options.visualizerFrameRate')}
                        description={t('options.visualizerFrameRateDesc')}
                        control={renderToggle(
                            isVisualizerFrameRateLimiterEnabled,
                            () => onVisualizerFrameRateChange(isVisualizerFrameRateLimiterEnabled ? 'off' : selectedVisualizerFrameRate),
                        )}
                        dividerClass={dividerClass}
                    >
                        <div className={`space-y-3 transition-opacity ${isVisualizerFrameRateLimiterEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'}`}>
                            <div className="flex items-center justify-between text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <span className="opacity-60">{t('options.visualizerFrameRateValue')}</span>
                                <span className="font-mono opacity-70">{getFrameRateLabel(selectedVisualizerFrameRate)}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max={VISUALIZER_FRAME_RATE_OPTIONS.length - 1}
                                step="1"
                                value={Math.max(0, selectedVisualizerFrameRateIndex)}
                                onChange={(event) => handleFrameRateSliderChange(event.target.value)}
                                className={rangeInputClass}
                                aria-label={t('options.visualizerFrameRateValue')}
                                disabled={!isVisualizerFrameRateLimiterEnabled}
                            />
                            <div className="grid grid-cols-4 text-[11px] font-mono opacity-50" style={{ color: 'var(--text-secondary)' }}>
                                {VISUALIZER_FRAME_RATE_OPTIONS.map((frameRate, index) => (
                                    <span key={frameRate} className={(index === 1 || index === 2) ? 'text-center' : index === 3 ? 'text-right' : ''}>
                                        {frameRate}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </SettingsRow>
                    <SettingsRow
                        title={t('options.glowBlurQuantize')}
                        description={(
                            <>
                                {t('options.glowBlurQuantizeDesc')}{' '}
                                <a
                                    href={CHROMIUM_FD_EXHAUSTION_DOCS_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={openDocsLinkExternally}
                                    className="underline underline-offset-2 hover:opacity-80"
                                >
                                    {t('options.glowBlurQuantizeDocs')}
                                </a>
                            </>
                        )}
                        control={renderToggle(glowBlurQuantize, () => onToggleGlowBlurQuantize(!glowBlurQuantize))}
                        dividerClass={dividerClass}
                        isLast
                    />
                </div>
            </SettingsAnchor>

            <SettingsAnchor anchorId="graphicsMotion" label={t('options.reduceMotionSection')} className="space-y-4">
                <SettingsSectionHeading icon={Gauge} label={t('options.reduceMotionSection')} />
                <MotionReductionSettingsSection
                    settingsCardClass={settingsCardClass}
                    settingsDividerClass={dividerClass}
                    toggleOffBackgroundClass={toggleOffBackgroundClass}
                    theme={theme}
                />
            </SettingsAnchor>

            {IS_ANDROID_WEBVIEW && (
                <SettingsAnchor anchorId="graphicsAppUpdate" label="关于与更新" className="space-y-4">
                    <SettingsSectionHeading icon={Download} label="关于与更新" />
                    <AndroidUpdateSection
                        settingsCardClass={settingsCardClass}
                        dividerClass={dividerClass}
                        utilityGhostButtonClass={utilityGhostButtonClass}
                    />
                </SettingsAnchor>
            )}

            <ThemedDialog
                isOpen={isNativeBlurNoticeOpen}
                onClose={() => setIsNativeBlurNoticeOpen(false)}
                isDaylight={isDaylight}
                title={t('options.nativeBlurConfirmTitle')}
                footer={(
                    <>
                        <button
                            type="button"
                            onClick={() => setIsNativeBlurNoticeOpen(false)}
                            className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${utilityGhostButtonClass}`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {t('localMusic.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={confirmNativeBlur}
                            className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                            style={{ backgroundColor: theme?.accentColor || '#3b82f6' }}
                        >
                            {t('options.nativeBlurConfirmAction')}
                        </button>
                    </>
                )}
            >
                <p className="text-sm leading-6 opacity-75" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.nativeBlurConfirmDesc')}
                </p>
            </ThemedDialog>
        </div>
    );
};

export default GraphicsSettingsSubview;
