import React, { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IS_ANDROID_WEBVIEW } from '../../../../utils/platform';
import { settingsCardClassFor, settingsDividerClassFor } from '../settingsCardClasses';
import { useSettingsKitTheme } from '../kit';
import { clearCoverAssets, getCoverAssetUsage } from '../../../../services/coverCache';
import { formatBytes } from '../../../../services/appUpdate';
import SettingsSectionHeading from '../navigation/SettingsSectionHeading';
import AdaptiveLayoutSetting from '../AdaptiveLayoutSetting';
import AndroidImmersiveSetting from '../AndroidImmersiveSetting';
import AndroidKeepScreenOnSetting from '../AndroidKeepScreenOnSetting';
import AndroidPhoneFitSetting from '../AndroidPhoneFitSetting';
import AndroidUpdateSection from '../AndroidUpdateSection';

// src/components/modal/settings/pages/AndroidSettingsSections.tsx
// 安卓专属设置条目（旧版优化迁移）：通用页底部的设备适配开关（沉浸/常亮/手机适配/自适应），
// 以及性能页底部的应用内更新（检查 GitHub Releases → 原生 DownloadManager 下载 → 安装）。
// 仅安卓 WebView 渲染，桌面保持上游原样。

const useAndroidCardClasses = () => {
    const { isDaylight } = useSettingsKitTheme();
    const settingsCardClass = settingsCardClassFor(isDaylight);
    const dividerClass = settingsDividerClassFor(isDaylight);
    const utilityGhostButtonClass = isDaylight
        ? 'border-zinc-300 bg-white/50 hover:bg-white/80'
        : 'border-white/10 bg-white/5 hover:bg-white/10';
    return { isDaylight, settingsCardClass, dividerClass, utilityGhostButtonClass };
};

/** 封面缓存占用显示 + 一键清除（旧版优化迁移）。 */
const CoverCacheUsageSection: React.FC = () => {
    const { t } = useTranslation();
    const { isDaylight } = useSettingsKitTheme();
    const settingsCardClass = settingsCardClassFor(isDaylight);
    const [usageBytes, setUsageBytes] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);

    const refresh = useCallback(() => {
        void getCoverAssetUsage().then(setUsageBytes).catch(() => setUsageBytes(0));
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    return (
        <div className="space-y-2">
            <SettingsSectionHeading icon={ImageIcon} label={t('options.covers') || '封面缓存'} />
            <div className={`p-4 rounded-xl border ${settingsCardClass}`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('options.covers') || '封面缓存'}
                        </div>
                        <div className="text-xs opacity-50 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {usageBytes == null
                                ? (t('options.mediaCacheSizePending') || '正在统计…')
                                : `${t('options.mediaCacheUsage') || '占用'} ${formatBytes(usageBytes) || '0 B'}`}
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={clearing || usageBytes === 0}
                        onClick={() => {
                            setClearing(true);
                            void clearCoverAssets().then(() => setUsageBytes(0)).finally(() => setClearing(false));
                        }}
                        className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium ${isDaylight
                            ? 'border-zinc-300 bg-white/50 hover:bg-white/80'
                            : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                        style={{ color: 'var(--text-primary)' }}
                    >
                        <Trash2 className="h-4 w-4" />
                        {clearing ? (t('options.clearing') || '清除中…') : (t('options.clearCache') || '一键清除')}
                    </button>
                </div>
            </div>
        </div>
    );
};

/** 通用页底部：自适应屏幕分辨率 / 全沉浸 / 屏幕常亮 / 手机适配 / 封面缓存。 */
export const AndroidGeneralSettingsSection: React.FC = () => {
    const { isDaylight, settingsCardClass, dividerClass, utilityGhostButtonClass } = useAndroidCardClasses();
    if (!IS_ANDROID_WEBVIEW) return null;
    const theme = { secondaryColor: 'var(--text-accent)' };
    return (
        <div className="space-y-4">
            <AdaptiveLayoutSetting
                isDaylight={isDaylight}
                settingsCardClass={settingsCardClass}
                theme={theme}
            />
            <AndroidImmersiveSetting
                isDaylight={isDaylight}
                settingsCardClass={settingsCardClass}
                theme={theme}
            />
            <AndroidKeepScreenOnSetting
                isDaylight={isDaylight}
                settingsCardClass={settingsCardClass}
                theme={theme}
            />
            <AndroidPhoneFitSetting
                isDaylight={isDaylight}
                settingsCardClass={settingsCardClass}
                theme={theme}
            />
            <CoverCacheUsageSection />
            <div className={dividerClass} />
        </div>
    );
};

/** 性能与动效页底部：当前版本 + 检查更新 + 下载安装（GitHub Releases）。 */
export const AndroidUpdateSettingsSection: React.FC = () => {
    const { isDaylight, settingsCardClass, dividerClass, utilityGhostButtonClass } = useAndroidCardClasses();
    if (!IS_ANDROID_WEBVIEW) return null;
    return (
        <div className="space-y-4">
            <div className={dividerClass} />
            <AndroidUpdateSection
                settingsCardClass={settingsCardClass}
                dividerClass={dividerClass}
                utilityGhostButtonClass={utilityGhostButtonClass}
            />
        </div>
    );
};

/** 帮助页「关于与版本」区：安卓专属的版本 + 检查更新入口（仅安卓 WebView 渲染）。 */
export const AndroidHelpUpdateEntry: React.FC = () => {
    const { isDaylight, settingsCardClass, dividerClass, utilityGhostButtonClass } = useAndroidCardClasses();
    if (!IS_ANDROID_WEBVIEW) return null;
    return (
        <AndroidUpdateSection
            settingsCardClass={settingsCardClass}
            dividerClass={dividerClass}
            utilityGhostButtonClass={utilityGhostButtonClass}
        />
    );
};
