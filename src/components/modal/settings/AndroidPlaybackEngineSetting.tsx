import React from 'react';
import { AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { useAndroidPlaybackEngineStore, type PlaybackEngine } from '../../../stores/useAndroidPlaybackEngineStore';

// src/components/modal/settings/AndroidPlaybackEngineSetting.tsx
// 「播放方案」：内置（WebView，原版行为，安卓上在线播放易卡顿/炸音）与
// 原生播放器（MediaPlayer 硬解码，流畅干净；均衡器/频谱不作用于声音，仅在线歌曲）。
// 默认原生。切换即时生效（下一首开始走新方案）。

type AndroidPlaybackEngineSettingProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    theme?: { secondaryColor?: string } | null;
};

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const OPTIONS: Array<{ id: PlaybackEngine; labelKey: string; descKey: string }> = [
    { id: 'native', labelKey: 'options.playbackEngineNative', descKey: 'options.playbackEngineNativeDesc' },
    { id: 'webview', labelKey: 'options.playbackEngineWebview', descKey: 'options.playbackEngineWebviewDesc' },
];

const AndroidPlaybackEngineSetting: React.FC<AndroidPlaybackEngineSettingProps> = ({
    isDaylight,
    settingsCardClass,
    theme,
}) => {
    const { t } = useTranslation();
    const engine = useAndroidPlaybackEngineStore(state => state.playbackEngine);
    const setEngine = useAndroidPlaybackEngineStore(state => state.setPlaybackEngine);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <div className="space-y-4">
            <SettingsSectionHeading icon={AudioLines} label={t('options.playbackEngine')} />
            <div className={`p-4 rounded-xl border ${settingsCardClass}`}>
                <div className="space-y-3">
                    {OPTIONS.map((option) => {
                        const selected = engine === option.id;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setEngine(option.id)}
                                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                                    selected
                                        ? (isDaylight ? 'border-zinc-400 bg-white/60' : 'border-white/25 bg-white/10')
                                        : (isDaylight ? 'border-zinc-200 bg-white/40' : 'border-white/10 bg-white/5')
                                }`}
                                style={{ color: 'var(--text-primary)' }}
                            >
                                <span
                                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                        selected ? 'border-transparent' : (isDaylight ? 'border-zinc-400' : 'border-white/30')
                                    }`}
                                    style={{ backgroundColor: selected ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                                >
                                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                </span>
                                <span className="min-w-0 space-y-0.5">
                                    <span className="block text-sm font-medium">{t(option.labelKey)}</span>
                                    <span className="block text-xs opacity-50 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                        {t(option.descKey)}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default AndroidPlaybackEngineSetting;
