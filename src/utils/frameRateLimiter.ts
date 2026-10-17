// src/utils/frameRateLimiter.ts
// Shared helpers and global RAF gate for optional visualizer frame throttling.

import type { VisualizerFrameRate } from '../types';
import { IS_ANDROID_WEBVIEW } from './platform';

type AnimationFrameCallback = FrameRequestCallback;
type RequestAnimationFrameFn = (callback: AnimationFrameCallback) => number;
type CancelAnimationFrameFn = (handle: number) => void;

type FrameRateLimitedRaf = {
    requestAnimationFrame: RequestAnimationFrameFn;
    cancelAnimationFrame: CancelAnimationFrameFn;
    setFrameRate: (frameRate: VisualizerFrameRate) => void;
    getFrameRate: () => VisualizerFrameRate;
    /** 进入后台时冻结所有 RAF 回调（可视化器/动画停止绘制），回到前台时恢复；音频播放不受影响。 */
    setBackgroundPaused: (paused: boolean) => void;
    /** 拖拽海报墙等手势期间，临时把所有动画帧率压到 15fps，让 GPU 优先跟手；松手/惯性结束后恢复。 */
    setGestureThrottled: (throttled: boolean) => void;
};

type WindowWithVisualizerFrameRateLimiter = Window & {
    __foliaNativeRequestAnimationFrame?: RequestAnimationFrameFn;
    __foliaNativeCancelAnimationFrame?: CancelAnimationFrameFn;
};

export const VISUALIZER_FRAME_RATE_OPTIONS = [30, 60, 90, 120] as const satisfies VisualizerFrameRate[];
export const VISUALIZER_FRAME_RATE_STORAGE_KEY = 'visualizer_frame_rate';
const FRAME_INTERVAL_TOLERANCE_MS = 1;

export const isVisualizerFrameRate = (value: unknown): value is VisualizerFrameRate => (
    value === 'off'
    || value === 30
    || value === 120
    || value === 90
    || value === 60
);

export const parseVisualizerFrameRate = (value: string | null): VisualizerFrameRate => {
    if (value === 'off' || value === 'auto' || value === null) {
        return 'off';
    }

    const parsed = Number(value);
    return isVisualizerFrameRate(parsed) ? parsed : 'off';
};

// Decides whether a RAF tick should run under the configured FPS cap.
export const shouldProcessFrameAtRate = (
    timestampMs: number,
    lastProcessedTimestampMs: number,
    frameRate: VisualizerFrameRate | number,
) => {
    if (frameRate === 'off') {
        return true;
    }

    const intervalMs = 1000 / frameRate - FRAME_INTERVAL_TOLERANCE_MS;
    return lastProcessedTimestampMs === 0 || timestampMs - lastProcessedTimestampMs >= intervalMs;
};

const reportAnimationFrameCallbackError = (error: unknown) => {
    console.error('Error in requestAnimationFrame callback:', error);
    setTimeout(() => {
        throw error;
    }, 0);
};

// Creates a shared RAF queue so every callback scheduled for an allowed frame flushes together.
export const createFrameRateLimitedRaf = (
    nativeRequestAnimationFrame: RequestAnimationFrameFn,
    nativeCancelAnimationFrame: CancelAnimationFrameFn,
    initialFrameRate: VisualizerFrameRate = 60,
): FrameRateLimitedRaf => {
    let frameRate = initialFrameRate;
    let nextHandle = 1;
    let nativeFrameHandle: number | null = null;
    let lastProcessedTimestamp = 0;
    let backgroundPaused = false;
    // 手势节流：拖拽/惯性期间把动画帧率压到 15fps，松开恢复。
    let gestureThrottled = false;
    const callbacks = new Map<number, AnimationFrameCallback>();

    const scheduleNativeFrame = () => {
        if (nativeFrameHandle !== null || callbacks.size === 0 || backgroundPaused) {
            return;
        }

        nativeFrameHandle = nativeRequestAnimationFrame(processNativeFrame);
    };

    const processNativeFrame = (timestamp: number) => {
        nativeFrameHandle = null;

        // 后台冻结：不执行任何回调，也不再排下一帧，等 setBackgroundPaused(false) 恢复。
        if (backgroundPaused) {
            return;
        }

        if (!shouldProcessFrameAtRate(timestamp, lastProcessedTimestamp, gestureThrottled ? 15 : frameRate)) {
            scheduleNativeFrame();
            return;
        }

        lastProcessedTimestamp = timestamp;
        const frameHandles = Array.from(callbacks.keys());

        for (const handle of frameHandles) {
            // Match native RAF: an earlier callback may cancel a later one in the same frame.
            const callback = callbacks.get(handle);
            if (!callback) continue;
            callbacks.delete(handle);
            try {
                callback(timestamp);
            } catch (error) {
                reportAnimationFrameCallbackError(error);
            }
        }

        scheduleNativeFrame();
    };

    return {
        requestAnimationFrame: (callback) => {
            const handle = nextHandle;
            nextHandle += 1;
            callbacks.set(handle, callback);
            scheduleNativeFrame();
            return handle;
        },
        cancelAnimationFrame: (handle) => {
            callbacks.delete(handle);
            if (callbacks.size === 0 && nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
        },
        setFrameRate: (nextFrameRate) => {
            frameRate = nextFrameRate;
            lastProcessedTimestamp = 0;

            if (nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
            scheduleNativeFrame();
        },
        getFrameRate: () => frameRate,
        setBackgroundPaused: (paused) => {
            if (backgroundPaused === paused) {
                return;
            }
            backgroundPaused = paused;
            if (paused) {
                if (nativeFrameHandle !== null) {
                    nativeCancelAnimationFrame(nativeFrameHandle);
                    nativeFrameHandle = null;
                }
            } else {
                lastProcessedTimestamp = 0;
                scheduleNativeFrame();
            }
        },
        setGestureThrottled: (throttled) => {
            if (gestureThrottled === throttled) {
                return;
            }
            gestureThrottled = throttled;
            lastProcessedTimestamp = 0;
            if (nativeFrameHandle !== null) {
                nativeCancelAnimationFrame(nativeFrameHandle);
                nativeFrameHandle = null;
            }
            scheduleNativeFrame();
        },
    };
};

let installedLimiter: FrameRateLimitedRaf | null = null;

/**
 * 进后台冻结/回前台恢复全部可视化器与动画的 RAF。
 * 若用户选了“不限帧率”（此时 RAF 尚未被接管），进入后台时先装一个透明门（frameRate='off'，
 * 前台不限制帧率），仅为获得统一的后台冻结入口；前台帧率不受影响。
 */
export const setVisualizerBackgroundPaused = (paused: boolean) => {
    if (typeof window === 'undefined') {
        return;
    }

    if (paused) {
        if (!installedLimiter) {
            installGlobalVisualizerFrameRateLimiter('off', true);
        }
        installedLimiter?.setBackgroundPaused(true);
    } else {
        installedLimiter?.setBackgroundPaused(false);
    }
};

export const setGlobalVisualizerFrameRate = (frameRate: VisualizerFrameRate) => {
    if (typeof window === 'undefined') {
        return;
    }

    if (frameRate === 'off') {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (!installedLimiter) {
        installGlobalVisualizerFrameRateLimiter(frameRate);
        return;
    }

    installedLimiter.setFrameRate(frameRate);
};

// 拖拽海报墙等手势期间，临时把动画帧率压到 15fps（歌词/可视化/卡片入场动画让路，GPU 优先跟手）；
// 松手/惯性结束后恢复档位帧率。若帧率门未安装（用户手动选了"不限制"），此调用为空操作。
export const setWallGestureThrottle = (throttled: boolean) => {
    installedLimiter?.setGestureThrottled(throttled);
};

export const restoreGlobalVisualizerFrameRateLimiter = () => {
    if (typeof window === 'undefined') {
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    if (frameWindow.__foliaNativeRequestAnimationFrame) {
        window.requestAnimationFrame = frameWindow.__foliaNativeRequestAnimationFrame;
    }
    if (frameWindow.__foliaNativeCancelAnimationFrame) {
        window.cancelAnimationFrame = frameWindow.__foliaNativeCancelAnimationFrame;
    }
    installedLimiter = null;
};

export const installGlobalVisualizerFrameRateLimiter = (
    overrideFrameRate?: VisualizerFrameRate,
    forceInstallTransparentGate = false,
) => {
    if (typeof window === 'undefined') {
        return;
    }

    const initialFrameRate = overrideFrameRate
        ?? parseVisualizerFrameRate(window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY));
    // 安卓手机 WebView 上，用户从未手动设置过帧率时，默认 30FPS：把可视化器/动画的 GPU 绘制减半，
    // 明显降低发热与耗电。这只是默认值，设置里仍有 60/90/120/不限制，用户一旦手动选择永远优先。
    const storedRaw = window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY);
    const effectiveFrameRate = initialFrameRate === 'off'
        && !overrideFrameRate
        && storedRaw === null
        && IS_ANDROID_WEBVIEW
        ? 30
        : initialFrameRate;
    // forceInstallTransparentGate：即使帧率为 'off'（不限制），也安装一个“每帧全过”的透明包装器，
    // 仅用于接管 RAF，使后台冻结开关对选择了“不限帧率”的用户同样生效；前台帧率不受影响。
    if (effectiveFrameRate === 'off' && !forceInstallTransparentGate) {
        restoreGlobalVisualizerFrameRateLimiter();
        return;
    }

    if (installedLimiter) {
        installedLimiter.setFrameRate(effectiveFrameRate);
        return;
    }

    const frameWindow = window as WindowWithVisualizerFrameRateLimiter;
    frameWindow.__foliaNativeRequestAnimationFrame ??= window.requestAnimationFrame;
    frameWindow.__foliaNativeCancelAnimationFrame ??= window.cancelAnimationFrame;
    const nativeRequestAnimationFrame: RequestAnimationFrameFn = (callback) => (
        frameWindow.__foliaNativeRequestAnimationFrame?.call(window, callback) ?? 0
    );
    const nativeCancelAnimationFrame: CancelAnimationFrameFn = (handle) => {
        frameWindow.__foliaNativeCancelAnimationFrame?.call(window, handle);
    };
    installedLimiter = createFrameRateLimitedRaf(nativeRequestAnimationFrame, nativeCancelAnimationFrame, effectiveFrameRate);

    window.requestAnimationFrame = installedLimiter.requestAnimationFrame;
    window.cancelAnimationFrame = installedLimiter.cancelAnimationFrame;
};
