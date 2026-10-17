// src/utils/performanceRuntime.ts
// 自适应性能引擎的运行时联动：在用户于设置里手动切换档位时，让可即时调整的参数跟上。
//
// 边界（刻意保守）：
//   - 帧率：用户没手动设过就随档位走（60/30），手动设过则永远尊重。
//   - 可视化器「模式」：不在运行时强行切换——用户可能正在看某个可视化器，突然被换成静态会像
//     功能丢了。低端默认模式由 index.tsx 在首次启动、用户尚未选择时预设一次；切档后若想更省，
//     用户在可视化器设置里一键就能选「静态」。
//   - 墙面 / 封面 / DPR / CSS 等参数由各组件直接读档位渲染，切档后下一帧自然生效，无需这里联动。

import {
    resolveEffectiveTier,
    usePerformanceTierStore,
} from '../stores/usePerformanceTierStore';
import { getPerformanceProfile } from './performanceProfile';
import {
    VISUALIZER_FRAME_RATE_STORAGE_KEY,
    setGlobalVisualizerFrameRate,
} from './frameRateLimiter';
import { IS_ANDROID_WEBVIEW } from './platform';

const syncFrameRateToTier = (): void => {
    if (typeof window === 'undefined' || !IS_ANDROID_WEBVIEW) return;
    // 用户手动设置过帧率（图形设置里选了 30/60/90/120/不限制），档位不覆盖。
    if (window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY) !== null) return;
    const tier = resolveEffectiveTier(usePerformanceTierStore.getState());
    setGlobalVisualizerFrameRate(getPerformanceProfile(tier).render.visualizerFrameRate);
};

/** 在 bootstrap 调用一次，挂上档位切换的运行时联动。 */
export const installPerformanceRuntime = (): void => {
    usePerformanceTierStore.subscribe(syncFrameRateToTier);
};
