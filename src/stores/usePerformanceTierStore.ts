import { create } from 'zustand';
import { getStoredString, setStoredString } from './storagePrimitives';
import {
    detectDeviceCapabilities,
    type DeviceCapabilities,
    type PerformanceTier,
} from '../utils/deviceCapabilities';
import { getPerformanceProfile, type PerformanceProfile } from '../utils/performanceProfile';

// src/stores/usePerformanceTierStore.ts
// 自适应性能引擎的档位控制面。
//
// 与 useMotionSettingsStore（单个动效面的手动降级）互补：
//   - 本 store 决定「整台设备处于哪一档」，默认 auto —— 由 deviceCapabilities 探测硬件后自动决定；
//   - 海报墙、可视化器、帧率、CSS 特效等再读 effectiveTier，从 performanceProfile 取参数。
// 手动选择永远优先：用户在设置里选了 high，哪怕硬件探测判成 low，也按 high 走。
//
// 全局属性 `<html data-perf-tier="low|balanced|high">` 与 `data-reduce-motion` 同样在模块加载时
// 就写好（bootstrap 副作用 import），第一帧即生效，不会先满血渲染再突然降级。

/** 用户偏好：auto 跟随硬件探测；否则强制指定档位。 */
export type PerformanceModePreference = 'auto' | PerformanceTier;

export const PERF_MODE_STORAGE_KEY = 'performance_mode';

export const isPerformanceModePreference = (value: unknown): value is PerformanceModePreference => (
    value === 'auto' || value === 'low' || value === 'balanced' || value === 'high'
);

const readStoredMode = (): PerformanceModePreference => {
    const raw = getStoredString(PERF_MODE_STORAGE_KEY, 'auto');
    return isPerformanceModePreference(raw) ? raw : 'auto';
};

// 硬件探测在模块加载时执行一次，结果对整个会话有效（同一设备不会中途换硬件）。
export const DEVICE_CAPABILITIES: DeviceCapabilities = detectDeviceCapabilities();

export type PerformanceTierState = {
    /** 用户选择的模式（auto 或强制档位）。 */
    mode: PerformanceModePreference;
    /** 本次探测到的设备能力（只读，供设置页展示 CPU/内存/GPU/分辨率）。 */
    capabilities: DeviceCapabilities;
    setPerformanceMode: (mode: PerformanceModePreference) => void;
};

export const usePerformanceTierStore = create<PerformanceTierState>(set => ({
    mode: readStoredMode(),
    capabilities: DEVICE_CAPABILITIES,
    setPerformanceMode: (mode) => {
        set({ mode });
        setStoredString(PERF_MODE_STORAGE_KEY, mode);
    },
}));

/** 解析当前真正生效的档位：auto 时取硬件探测结果。 */
export const resolveEffectiveTier = (
    state: Pick<PerformanceTierState, 'mode' | 'capabilities'>,
): PerformanceTier => (state.mode === 'auto' ? state.capabilities.tier : state.mode);

/** hook 外 / 命令式代码读取当前档位。 */
export const readEffectiveTier = (): PerformanceTier =>
    resolveEffectiveTier(usePerformanceTierStore.getState());

/** 读取当前档位对应的参数表。 */
export const readPerformanceProfile = (): PerformanceProfile =>
    getPerformanceProfile(readEffectiveTier());

const syncTierAttribute = (state: PerformanceTierState): void => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.setAttribute('data-perf-tier', resolveEffectiveTier(state));
};

// import 时先写一次，再订阅变化（手动切档即时生效）。
syncTierAttribute(usePerformanceTierStore.getState());
usePerformanceTierStore.subscribe(syncTierAttribute);
