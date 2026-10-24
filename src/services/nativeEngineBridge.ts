// src/services/nativeEngineBridge.ts
// 原生播放器（MediaPlayer）方案的 JS 桥。原版方案不加载本模块。
// 声音由 Android 侧 FoliaPlaybackService 的 MediaPlayer 输出；进度/结束/错误事件回传 JS。

type FoliaNativePlugin = {
    startNativePlayback: (options: { url: string; position?: number }) => Promise<unknown>;
    pauseNativePlayback: () => Promise<unknown>;
    resumeNativePlayback: () => Promise<unknown>;
    seekNativePlayback: (options: { position: number }) => Promise<unknown>;
    stopNativePlayback: () => Promise<unknown>;
    isIgnoringBatteryOptimizations: () => Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations: () => Promise<{ alreadyIgnoring?: boolean }>;
    addListener: (
        eventName: string,
        listener: (event: unknown) => void,
    ) => Promise<{ remove: () => Promise<void> }>;
};

type NativeProgressEvent = { position?: number; duration?: number };
type NativeErrorEvent = { message?: string };

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

/** 开始播放远程 URL（切换歌曲时调用）。positionMs 用于续播。 */
export const startNativeEnginePlayback = (url: string, positionMs = 0): Promise<void> =>
    safeCall((plugin) => plugin.startNativePlayback({ url, position: positionMs }).then(() => undefined), undefined);

export const pauseNativeEnginePlayback = (): Promise<void> =>
    safeCall((plugin) => plugin.pauseNativePlayback().then(() => undefined), undefined);

export const resumeNativeEnginePlayback = (): Promise<void> =>
    safeCall((plugin) => plugin.resumeNativePlayback().then(() => undefined), undefined);

export const seekNativeEnginePlayback = (positionMs: number): Promise<void> =>
    safeCall((plugin) => plugin.seekNativePlayback({ position: positionMs }).then(() => undefined), undefined);

export const stopNativeEnginePlayback = (): Promise<void> =>
    safeCall((plugin) => plugin.stopNativePlayback().then(() => undefined), undefined);

/** 是否已获得电池优化豁免。 */
export const isIgnoringBatteryOptimizations = (): Promise<boolean> =>
    safeCall(async (plugin) => {
        const result = await plugin.isIgnoringBatteryOptimizations();
        return Boolean(result?.ignoring);
    }, false);

/** 发起电池优化豁免请求（系统弹窗）。 */
export const requestIgnoreBatteryOptimizations = (): Promise<boolean> =>
    safeCall(async (plugin) => {
        const result = await plugin.requestIgnoreBatteryOptimizations();
        return Boolean(result?.alreadyIgnoring);
    }, false);

export type NativeEngineListener = (event: NativeProgressEvent) => void;

let listenersInstalled = false;
const progressListeners = new Set<NativeEngineListener>();
const endedListeners = new Set<() => void>();
const errorListeners = new Set<(message: string) => void>();

export const onNativeEngineProgress = (listener: NativeEngineListener): (() => void) => {
    installNativeEngineListeners();
    progressListeners.add(listener);
    return () => { progressListeners.delete(listener); };
};

export const onNativeEngineEnded = (listener: () => void): (() => void) => {
    installNativeEngineListeners();
    endedListeners.add(listener);
    return () => { endedListeners.delete(listener); };
};

export const onNativeEngineError = (listener: (message: string) => void): (() => void) => {
    installNativeEngineListeners();
    errorListeners.add(listener);
    return () => { errorListeners.delete(listener); };
};

const installNativeEngineListeners = (): void => {
    const plugin = getPlugin();
    if (!plugin || listenersInstalled) return;
    listenersInstalled = true;
    const listen = (eventName: string, handler: (event: any) => void) => {
        try {
            void plugin.addListener(eventName, handler).catch(() => undefined);
        } catch {
            // 监听注册失败不影响主流程。
        }
    };
    listen('nativeProgress', (event: NativeProgressEvent) => {
        progressListeners.forEach((listener) => {
            try { listener(event); } catch { /* ignore */ }
        });
    });
    listen('nativeEnded', () => {
        endedListeners.forEach((listener) => {
            try { listener(); } catch { /* ignore */ }
        });
    });
    listen('nativeError', (event: NativeErrorEvent) => {
        const message = event?.message ?? 'native-error';
        errorListeners.forEach((listener) => {
            try { listener(message); } catch { /* ignore */ }
        });
    });
};
