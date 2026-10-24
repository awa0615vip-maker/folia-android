import React, { useCallback, useEffect, useState } from 'react';
import { BatteryCharging, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import {
    isIgnoringBatteryOptimizations,
    requestIgnoreBatteryOptimizations,
} from '../../../services/nativeEngineBridge';

// src/components/modal/settings/AndroidBatteryOptimizationSetting.tsx
// 「后台无限制」：查看当前电池优化豁免状态，一键发起系统授权弹窗。
// 播放器会在启动时自动请求一次（每 3 天提醒一次），这里提供手动入口。
// 注意：MIUI/HyperOS 还需在设置里允许自启动与后台运行，本项解决的是省电杀后台。

type AndroidBatteryOptimizationSettingProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    utilityGhostButtonClass: string;
};

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

const AndroidBatteryOptimizationSetting: React.FC<AndroidBatteryOptimizationSettingProps> = ({
    isDaylight,
    settingsCardClass,
    utilityGhostButtonClass,
}) => {
    const { t } = useTranslation();
    const [ignoring, setIgnoring] = useState<boolean | null>(null);
    const [requesting, setRequesting] = useState(false);

    const refresh = useCallback(() => {
        void isIgnoringBatteryOptimizations()
            .then(setIgnoring)
            .catch(() => setIgnoring(false));
    }, []);

    useEffect(() => {
        if (!isAndroidNativeRuntime()) return;
        refresh();
    }, [refresh]);

    if (!isAndroidNativeRuntime()) return null;

    return (
        <div className="space-y-4">
            <SettingsSectionHeading icon={BatteryCharging} label={t('options.batteryOptimization')} />
            <div className={`p-4 rounded-xl border ${settingsCardClass}`}>
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {ignoring === true && <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />}
                            {ignoring === true
                                ? (t('options.batteryExempted') || '已获得后台无限制')
                                : (t('options.batteryNotExempted') || '尚未获得后台无限制')}
                        </div>
                        <div className="text-xs opacity-50 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.batteryOptimizationDesc')}
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={requesting || ignoring === true}
                        onClick={() => {
                            setRequesting(true);
                            void requestIgnoreBatteryOptimizations()
                                .then(() => refresh())
                                .finally(() => setRequesting(false));
                        }}
                        className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                        style={{ color: 'var(--text-primary)' }}
                    >
                        <BatteryCharging className="h-4 w-4" />
                        {ignoring === true
                            ? (t('options.batteryGranted') || '已授权')
                            : (requesting
                                ? (t('options.requestingBattery') || '请求中…')
                                : (t('options.requestBatteryExemption') || '去授权'))}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AndroidBatteryOptimizationSetting;
