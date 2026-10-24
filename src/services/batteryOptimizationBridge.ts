// src/services/batteryOptimizationBridge.ts
// 「后台无限制」桥：查询电池优化豁免状态 + 发起系统授权弹窗。
// 独立成模块（不依赖任何播放方案），播放器启动时自动请求一次，设置页提供手动入口。

type FoliaNativePlugin = {
    isIgnoringBatteryOptimizations: () => Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations: () => Promise<{ alreadyIgnoring?: boolean }>;
};

const getPlugin = (): FoliaNativePlugin | null => {
    if (typeof window === 'undefined') return null;
    const plugin = (window as any).Capacitor?.Plugins?.FoliaNative as FoliaNativePlugin | undefined;
    return plugin ?? null;
};

const safeCall = <T,>(operation: (plugin: FoliaNativePlugin) => Promise<T> | T, fallback: T): Promise<T> => {
    const plugin = getPlugin();
    if (!plugin) return Promise.resolve(fallback);
    try {
        return Promise.resolve(operation(plugin));
    } catch {
        return Promise.resolve(fallback);
    }
};

/** 是否已获得电池优化豁免。 */
export const isIgnoringBatteryOptimizations = (): Promise<boolean> =>
    safeCall(async (plugin) => {
        const result = await plugin.isIgnoringBatteryOptimizations();
        return Boolean(result?.ignoring);
    }, false);

/** 发起电池优化豁免请求（系统弹窗，用户确认；MIUI 需另在设置里放行自启动）。 */
export const requestIgnoreBatteryOptimizations = (): Promise<boolean> =>
    safeCall(async (plugin) => {
        const result = await plugin.requestIgnoreBatteryOptimizations();
        return Boolean(result?.alreadyIgnoring);
    }, false);
