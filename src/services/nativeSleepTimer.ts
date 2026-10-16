// src/services/nativeSleepTimer.ts
// 原生层睡眠定时器（定时暂停）桥接。
//
// 到期暂停由 Android AlarmManager 的精确闹钟触发，即使 App 在后台、锁屏或进入 Doze
// 也能准时暂停；避免依赖 WebView 的 JavaScript setInterval（页面不可见时会被系统节流，
// 导致倒计时不走、歌曲不暂停）。

type SleepTimerPlugin = {
    armSleepTimer: (options: { durationMs: number }) => Promise<{ deadlineMs?: number }>;
    cancelSleepTimer: () => Promise<unknown>;
    getSleepTimerRemainingMs: () => Promise<{ remainingMs?: number }>;
    addListener: (
        eventName: string,
        listener: (event: Record<string, unknown>) => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
};

export const getSleepTimerPlugin = (): SleepTimerPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as any).Capacitor;
    const isAndroid =
        capacitor?.isNativePlatform?.() || capacitor?.getPlatform?.() === 'android';
    if (!isAndroid) return null;
    const plugin = capacitor?.Plugins?.FoliaNative;
    if (!plugin || typeof plugin.armSleepTimer !== 'function') return null;
    return plugin as SleepTimerPlugin;
};

export const isNativeSleepTimerAvailable = (): boolean => getSleepTimerPlugin() !== null;

/** 布防定时器，返回到期的绝对时间戳（毫秒）。 */
export const armNativeSleepTimer = async (durationMs: number): Promise<number> => {
    const plugin = getSleepTimerPlugin();
    if (!plugin) throw new Error('Native sleep timer unavailable');
    const result = await plugin.armSleepTimer({ durationMs });
    return result.deadlineMs ?? Date.now() + durationMs;
};

/** 取消定时器。 */
export const cancelNativeSleepTimer = async (): Promise<void> => {
    const plugin = getSleepTimerPlugin();
    if (!plugin) return;
    await plugin.cancelSleepTimer();
};

/** 监听原生到期事件，返回取消监听函数。 */
export const addNativeSleepTimerExpiredListener = (
    onExpired: () => void,
): (() => void) => {
    const plugin = getSleepTimerPlugin();
    if (!plugin) return () => undefined;
    let removed = false;
    const handle = plugin.addListener('sleepTimerExpired', () => onExpired());
    void Promise.resolve(handle).then((registration) => {
        if (removed) void registration.remove();
    });
    return () => {
        removed = true;
        void Promise.resolve(handle).then((registration) => void registration.remove());
    };
};
