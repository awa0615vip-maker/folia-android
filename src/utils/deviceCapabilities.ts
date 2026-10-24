// src/utils/deviceCapabilities.ts
// 设备能力探测 + 性能分级（自适应性能引擎的第一环）。
//
// 目的：在 App 启动最早期读一次设备硬件信号，把设备归入 low / balanced / high 三档，
// 之后海报墙、封面、可视化器、特效、帧率、启动门等都从「档位参数表」(performanceProfile.ts)
// 取各自的参数，而不是各自写死一套对所有设备一视同仁的配置。
//
// 设计原则：
//   1. 纯能力探测，不读任何用户设置 —— 用户手动覆盖在 usePerformanceTierStore 里处理。
//   2. 多信号加权 + 兜底，不把分级押在单一信号上。拿不到某信号（如桌面浏览器、无 WebGL）
//      时该信号缺省，不让它把整体拖到错误的档位。
//   3. 全部读取都 SSR 安全（typeof window/document 守卫），可在模块加载期直接执行。

import { isAndroidNativeRuntime } from './platform';

export type PerformanceTier = 'low' | 'balanced' | 'high';

export type DeviceCapabilities = {
    /** 综合判定的档位。 */
    tier: PerformanceTier;
    /** 0~100 的综合能力分，仅用于诊断与展示，分档以它为准。 */
    score: number;
    /** 各单项信号的原始值与评分，供设置页展示和调试。 */
    signals: {
        /** navigator.deviceMemory，单位 GB；Chromium 只上报到 8，拿不到为 null。 */
        deviceMemoryGb: number | null;
        /** navigator.hardwareConcurrency 逻辑核数；拿不到为 null。 */
        hardwareConcurrency: number | null;
        devicePixelRatio: number;
        /** 逻辑分辨率（CSS 像素）。 */
        screenWidth: number;
        screenHeight: number;
        /** WebGL RENDERER 字符串（GPU 型号），如 "Mali-G52 MC2" / "Adreno 610"；拿不到为 null。 */
        gpuRenderer: string | null;
        /** 单独给 GPU 评的档位，拿不到为 null。 */
        gpuTier: PerformanceTier | null;
        /** navigator.connection.effectiveType，如 '4g'/'3g'；拿不到为 null。 */
        networkType: string | null;
        /** 从 UA 解析的 Android 主版本；非安卓或拿不到为 null。 */
        androidVersion: number | null;
        isAndroidWebView: boolean;
    };
};

type N = Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string };
};

/** 内存（GB）评分：0~3。 */
const scoreMemory = (gigabytes: number | null): number => {
    if (gigabytes === null) return 1.5; // 拿不到给中性分，不拖档
    if (gigabytes >= 8) return 3;
    if (gigabytes >= 4) return 2;
    if (gigabytes >= 3) return 1.25;
    if (gigabytes >= 2) return 0.75;
    return 0.25;
};

/** CPU 逻辑核数评分：0~3。 */
const scoreCores = (cores: number | null): number => {
    if (cores === null) return 1.5;
    if (cores >= 8) return 3;
    if (cores >= 6) return 2.25;
    if (cores >= 4) return 1.25;
    if (cores >= 2) return 0.5;
    return 0.25;
};

/**
 * 移动 GPU 型号分级。安卓中低端机的瓶颈往往是 GPU 而不是 CPU，所以单独识别。
 * 返回 high/balanced/low，认不出返回 null（不参与综合）。
 */
const classifyGpu = (renderer: string | null): PerformanceTier | null => {
    if (!renderer) return null;
    const r = renderer.toLowerCase();

    // 桌面 / 苹果：桌面独显、Apple 自研 GPU 直接归高端（它们不是移动端瓶颈场景）。
    if (/apple (gpu|m\d|a\d)|apple silicon/.test(r)) return 'high';
    if (/\b(nvidia|geforce|rtx|gtx|quadro|amd|radeon|intel)\b/.test(r)
        && !/mali|adreno|powervr/.test(r)) {
        // 极老的 Intel 核显也归中端，不当高端；但对本 App 足够。
        return r.includes('iris') || /hd graphics 6|uhd|arc|nvidia|radeon/.test(r) ? 'high' : 'balanced';
    }

    // —— Adreno ——
    // 型号与 SOC 对应（避免把「数字大但入门」的 710 误判成高端）：
    //   750/740/730=8 Gen3/2/1 旗舰；710=7s Gen2/6 Gen1 入门；725=7 Gen2 中端；
    //   660=888、650=870/865、640=855 老旗舰；643/642=7 Gen1/778 中端；619=695、610=680 低端。
    // 真实 RENDERER 形如 "Adreno (TM) 710"，型号前隔着 "(TM)"，用 \D 容忍而非写死空格。
    const adreno = r.match(/adreno\D{0,12}(\d{3})/);
    if (adreno) {
        const model = Number(adreno[1]);
        if (model >= 730
            || model === 640 || model === 650 || model === 660
            || model === 680 || model === 685 || model === 690) {
            return 'high';
        }
        if (model <= 610) return 'low'; // 610=680/6 Gen1、608=4 Gen2、5xx/4xx 入门
        return 'balanced';              // 710/725、643/642/619/612 等中端
    }

    // —— Mali / Immortalis ——
    // G7xx（G710/715/720、Immortalis）及 G77/G78 高端；G57/G6xx 中端；G52 及更早、G3xx 入门。
    const maliG = r.match(/(?:mali|immortalis)[-\s]?(?:g|x)(\d{2,3})/);
    if (maliG) {
        const model = Number(maliG[1]);
        if (model >= 700 || model === 77 || model === 78) return 'high';
        if (model === 57 || model >= 600) return 'balanced'; // G57/G602/G604/G608/G610
        return 'low';                                        // G52/G51/G50/G3xx
    }
    if (/mali[-\s]?t[0-9]|mali[-\s]?4[0-9]{2}/.test(r)) return 'low'; // 老 T8xx / 4xx

    // —— PowerVR（联发科/展讯老机型常见）——
    if (/powervr|imgtec|rogue|ge8|ge9/.test(r)) return 'low';

    return null;
};

const gpuTierScore = (tier: PerformanceTier | null): number => {
    if (tier === 'high') return 3;
    if (tier === 'balanced') return 1.5;
    if (tier === 'low') return 0.5;
    return 1.5; // 认不出给中性分
};

/** 读取 WebGL RENDERER（GPU 型号）。WebGL 不可用时返回 null。 */
const readGpuRenderer = (): string | null => {
    if (typeof document === 'undefined') return null;
    try {
        const canvas = document.createElement('canvas');
        const gl = (
            canvas.getContext('webgl')
            || canvas.getContext('experimental-webgl')
        ) as WebGLRenderingContext | null;
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debug) return null;
        const renderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
        return typeof renderer === 'string' && renderer.length > 0 ? renderer : null;
    } catch {
        return null;
    }
};

const readAndroidVersion = (): number | null => {
    if (typeof navigator === 'undefined') return null;
    const match = /android\s+(\d{1,2})/i.exec(navigator.userAgent);
    return match ? Number(match[1]) : null;
};

/**
 * 综合评分：内存 0.25 + CPU 0.25 + GPU 0.50，折算成 0~100。
 * GPU 权重最高（海报墙/可视化器的卡顿主要来自 GPU 合成与着色）；deviceMemory 最高只报 8、
 * 主流中端机也常是 8 核，这两项在中高端区分度低，所以靠 GPU 把「中档机」从满血档拉开。
 */
const computeScore = (
    memoryScore: number,
    coresScore: number,
    gpuScore: number,
): number => {
    const weighted = memoryScore * 0.25 + coresScore * 0.25 + gpuScore * 0.5;
    return Math.round((weighted / 3) * 100);
};

/** 分数 → 档位。阈值偏保守：宁可把设备高估一档，也别让正常设备默认被砍功能；
 * 但中端（8 核 8GB 配中档 GPU）要落到均衡，避免被满屏累积渲染拖垮。 */
const tierFromScore = (score: number): PerformanceTier => {
    if (score >= 78) return 'high';
    if (score <= 42) return 'low';
    return 'balanced';
};

/**
 * 硬性兜底规则：命中任一「明确低端」特征直接压到 low，即使综合分被某个高信号拉高。
 * 典型：2GB 内存、或四核 + 低端 GPU + 高 DPR（高分屏拖累低端 GPU 最常见）。
 */
const hardLowFloor = (
    gigabytes: number | null,
    cores: number | null,
    gpuTier: PerformanceTier | null,
    dpr: number,
): boolean => {
    if (gigabytes !== null && gigabytes <= 2) return true;
    if (cores !== null && cores <= 4 && gpuTier === 'low' && dpr >= 2) return true;
    if (gpuTier === 'low' && gigabytes !== null && gigabytes <= 3) return true;
    return false;
};

/**
 * 探测一次设备能力。纯函数式、无副作用，可安全重复调用（结果确定性，除非换硬件）。
 */
export const detectDeviceCapabilities = (): DeviceCapabilities => {
    const nav = (typeof navigator === 'undefined' ? {} : navigator) as N;
    const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
    const hardwareConcurrency = typeof nav.hardwareConcurrency === 'number'
        ? Math.max(1, Math.round(nav.hardwareConcurrency))
        : null;
    const devicePixelRatio = typeof window !== 'undefined' && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1;
    const screenWidth = typeof screen !== 'undefined' ? screen.width : 0;
    const screenHeight = typeof screen !== 'undefined' ? screen.height : 0;
    const gpuRenderer = readGpuRenderer();
    const gpuTier = classifyGpu(gpuRenderer);
    const networkType = nav.connection?.effectiveType ?? null;
    const androidVersion = readAndroidVersion();

    const memoryScore = scoreMemory(deviceMemoryGb);
    const coresScore = scoreCores(hardwareConcurrency);
    const gpuScore = gpuTierScore(gpuTier);
    let score = computeScore(memoryScore, coresScore, gpuScore);
    let tier = tierFromScore(score);

    if (hardLowFloor(deviceMemoryGb, hardwareConcurrency, gpuTier, devicePixelRatio) && tier !== 'low') {
        tier = 'low';
        score = Math.min(score, 42);
    }

    return {
        tier,
        score,
        signals: {
            deviceMemoryGb,
            hardwareConcurrency,
            devicePixelRatio,
            screenWidth,
            screenHeight,
            gpuRenderer,
            gpuTier,
            networkType,
            androidVersion,
            isAndroidWebView: isAndroidNativeRuntime(),
        },
    };
};
