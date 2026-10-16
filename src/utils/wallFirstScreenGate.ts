// src/utils/wallFirstScreenGate.ts
// 启动遮罩与海报墙首屏渲染之间的握手信号。
//
// 流程：海报墙容器测量完成（即将渲染第一屏卡片）时调用 wallFirstScreenStarted()；
// 首屏卡片挂载、封面解码完成（或墙内部超时）后调用 notifyWallFirstScreenReady()。
// 启动遮罩（AppSplashGate）等待 ready：
//   - 若检测窗口内墙根本没开始渲染（说明本次启动不在海报墙页面），直接放行，不白等；
//   - 墙开始了就等它渲染好，直到总时长上限（6 秒）兜底，绝不会卡死启动。

type GateState = 'idle' | 'started' | 'ready';
export type WallGateResult = 'ready' | 'absent' | 'timeout';

let state: GateState = 'idle';
const listeners = new Set<() => void>();

const emit = () => {
    listeners.forEach(listener => listener());
};

/** 海报墙开始首屏渲染（容器已测量，马上挂卡片）。只在 idle 时生效。 */
export function wallFirstScreenStarted(): void {
    if (state === 'idle') {
        state = 'started';
        emit();
    }
}

/** 首屏卡片与封面已就绪，可以撤掉启动遮罩。 */
export function notifyWallFirstScreenReady(): void {
    if (state !== 'ready') {
        state = 'ready';
        emit();
    }
}

/** 调试 / 重载时复位。 */
export function resetWallFirstScreenGate(): void {
    state = 'idle';
    emit();
}

/**
 * 等待海报墙首屏。
 * @param detectMs 检测窗口：这段时间内墙没 started 就视为本次启动不在墙页面，返回 'absent'。
 * @param totalMs 总等待上限：墙开始了但迟迟没 ready，到点返回 'timeout' 放行。
 */
export function waitForWallFirstScreen(detectMs: number, totalMs: number): Promise<WallGateResult> {
    return new Promise(resolve => {
        if (state === 'ready') {
            resolve('ready');
            return;
        }
        let done = false;
        let detectTimer = 0;
        const totalTimer = window.setTimeout(() => finish('timeout'), totalMs);
        const finish = (result: WallGateResult) => {
            if (done) return;
            done = true;
            window.clearTimeout(detectTimer);
            window.clearTimeout(totalTimer);
            listeners.delete(onChange);
            resolve(result);
        };
        function onChange() {
            if (state === 'ready') {
                finish('ready');
            } else if (state === 'started') {
                // 墙开始渲染了，检测窗口作废，专心等 ready（总时长上限兜底）。
                window.clearTimeout(detectTimer);
            }
        }
        detectTimer = window.setTimeout(() => {
            if (state === 'idle') finish('absent');
        }, detectMs);
        listeners.add(onChange);
    });
}
