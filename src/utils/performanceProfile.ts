// src/utils/performanceProfile.ts
// 自适应性能引擎的「档位参数表」：单一事实源。
//
// 所有「随设备档位变化」的渲染参数集中在这里，海报墙 / 可视化器 / 帧率 / 启动门等运行时
// 只读本表，不各自写死。新增一个可降级点时，先在 PerformanceProfile 里加字段，再接线。
//
// 三档定位：
//   high     —— 高画质：满血渲染，与优化前的桌面/旗舰体验一致。
//   balanced —— 均衡：外观基本不变，靠降帧率、按世界尺寸取图、收紧渲染余量减负担。
//   low      —— 省电：为低端机保底可用，回收离屏卡片、关重特效、可视化器退静态、锁低帧率。
//
// 内容（歌曲、封面、歌词、功能、布局、交互逻辑）任何档位都不删，只降低渲染量、精度与
// 华丽度。用户可在设置里手动覆盖档位，选了 high 就不受这里自动降级影响。

import type { VisualizerFrameRate, VisualizerMode } from '../types';
import type { PerformanceTier } from './deviceCapabilities';

export type PerformanceProfile = {
    /** 海报墙（lattice）渲染策略。 */
    wall: {
        /** 四周额外预留的屏幕边长比例：0.35 ≈ 一次性渲染 1.7 倍视口。 */
        overscanFactor: number;
        /** 累积挂载卡片数的硬上限，防止超大曲库拖爆内存。 */
        maxRenderedInstances: number;
        /** 低端档：视口外的卡片滑走后回收（滑动窗口），而不是永久累积。 */
        recycleOffscreen: boolean;
        /**
         * 低端回收窗口「各边总外扩比例」（与 overscanFactor 同量纲、互补）：bounds 外扩
         * recycleWindowFactor - overscanFactor，layoutLattice 再外扩 overscanFactor，合计在视口
         * 四周各留 recycleWindowFactor 屏。0.3 ≈ 常驻约 1.6 倍视口，既不露白又把内存钉死。
         */
        recycleWindowFactor: number;
        /** 现有的「性能优先」：相机行程有限化 + 封面按世界尺寸取档。 */
        finiteCamera: boolean;
        /** 一次性预留的飞行路径视口数（越小越省）。 */
        reservedViewports: number;
    };
    /** 渲染精度与帧率。 */
    render: {
        /** devicePixelRatio 上限：高 DPR 屏按此钳制，减少 GPU 填充像素。 */
        maxPixelRatio: number;
        /** 封面采样 pixelScale 上限（相机缩放×DPR 之后再钳制）。 */
        coverPixelScaleCap: number;
        /** 全局 RAF 帧率门；'off' 表示不限制。 */
        visualizerFrameRate: VisualizerFrameRate;
    };
    /** 可视化器策略。 */
    visualizer: {
        /**
         * 当用户没有手动指定可视化器、或其选择属于重负载模式时，自动退到的档位兜底模式。
         * low 用 'still'（静态，几乎不跑 WebGL）；其余为 null（尊重用户选择）。
         */
        autoFallbackMode: VisualizerMode | null;
        /** 背景是否允许动态（monet/sora 等动态背景）。 */
        allowDynamicBackground: boolean;
    };
    /** 重特效开关（主要由 CSS 的 data-perf-tier 属性落地，这里供 JS 侧需要时读取）。 */
    effects: {
        backdropFilter: boolean;
        heavyShadows: boolean;
        coverTiltMotion: boolean;
        flip3d: boolean;
    };
    /** 安卓启动门（首屏遮罩）等待上限。 */
    splash: {
        maxWaitMs: number;
    };
    /** 封面预取（视口外多预取的边长比例）。 */
    prefetch: {
        coverWindowFactor: number;
    };
};

export const PERFORMANCE_PROFILES: Record<PerformanceTier, PerformanceProfile> = {
    high: {
        wall: {
            overscanFactor: 0.35,
            maxRenderedInstances: 3000,
            recycleOffscreen: false,
            recycleWindowFactor: 1,
            finiteCamera: false,
            reservedViewports: 3,
        },
        render: {
            maxPixelRatio: 3,
            coverPixelScaleCap: Number.POSITIVE_INFINITY,
            visualizerFrameRate: 60,
        },
        visualizer: {
            autoFallbackMode: null,
            allowDynamicBackground: true,
        },
        effects: {
            backdropFilter: true,
            heavyShadows: true,
            coverTiltMotion: true,
            flip3d: true,
        },
        splash: {
            maxWaitMs: 6000,
        },
        prefetch: {
            coverWindowFactor: 0.9,
        },
    },
    balanced: {
        wall: {
            overscanFactor: 0.22,
            maxRenderedInstances: 1400,
            recycleOffscreen: false,
            recycleWindowFactor: 1,
            finiteCamera: true,
            reservedViewports: 2,
        },
        render: {
            maxPixelRatio: 2,
            coverPixelScaleCap: 1,
            visualizerFrameRate: 30,
        },
        visualizer: {
            autoFallbackMode: null,
            allowDynamicBackground: true,
        },
        effects: {
            backdropFilter: true,
            heavyShadows: true,
            coverTiltMotion: true,
            flip3d: true,
        },
        splash: {
            maxWaitMs: 4800,
        },
        prefetch: {
            coverWindowFactor: 0.6,
        },
    },
    low: {
        wall: {
            overscanFactor: 0.12,
            maxRenderedInstances: 350,
            recycleOffscreen: true,
            recycleWindowFactor: 0.3,
            finiteCamera: true,
            reservedViewports: 1,
        },
        render: {
            maxPixelRatio: 1.5,
            coverPixelScaleCap: 0.75,
            visualizerFrameRate: 30,
        },
        visualizer: {
            autoFallbackMode: 'still',
            allowDynamicBackground: false,
        },
        effects: {
            backdropFilter: false,
            heavyShadows: false,
            coverTiltMotion: false,
            flip3d: false,
        },
        splash: {
            maxWaitMs: 3200,
        },
        prefetch: {
            coverWindowFactor: 0.35,
        },
    },
};

export const getPerformanceProfile = (tier: PerformanceTier): PerformanceProfile =>
    PERFORMANCE_PROFILES[tier];

/** 档位展示顺序与标签键（设置 UI 用）。 */
export const PERFORMANCE_TIER_ORDER: readonly PerformanceTier[] = ['high', 'balanced', 'low'];
