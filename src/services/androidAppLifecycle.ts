// 安卓 WebView 前后台生命周期：原生 MainActivity onStart/onStop 会通过 FoliaNative 插件发
// "appLifecycle" 事件。WebView 作为原生视图被切到后台时，通常不会触发页面的 visibilitychange，
// 因此这里以原生事件为主、页面 visibilitychange 为辅，统一维护“当前是否在后台”的状态。
//
// 进入后台时：冻结全部可视化器/动画的 RAF（只保留音频，由前台服务 + audio 元素继续播放），
// 解决“放着歌退出软件特别卡/耗电”；回到前台时：恢复渲染，由播放看门狗检查并续播被系统挂起的音频。

import { IS_ANDROID_WEBVIEW } from '../utils/platform';
import { setVisualizerBackgroundPaused } from '../utils/frameRateLimiter';

export type AppLifecycleState = 'foreground' | 'background';

type LifecycleListener = (state: AppLifecycleState) => void;

let currentState: AppLifecycleState = 'foreground';
let installed = false;
const listeners = new Set<LifecycleListener>();

const applyState = (next: AppLifecycleState) => {
    if (next === currentState) {
        return;
    }
    currentState = next;
    const backgrounded = next === 'background';

    // 后台冻结可视化渲染（音频不走 RAF，不受影响）。
    setVisualizerBackgroundPaused(backgrounded);
    try {
        document.documentElement.dataset.appBackgrounded = backgrounded ? 'true' : 'false';
    } catch {
        // document/documentElement 不可用时忽略。
    }

    listeners.forEach((listener) => {
        try {
            listener(next);
        } catch (error) {
            console.warn('[AppLifecycle] listener failed', error);
        }
    });
};

export const getAppLifecycleState = (): AppLifecycleState => currentState;

export const isAppInBackground = (): boolean => currentState === 'background';

export const subscribeAppLifecycle = (listener: LifecycleListener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const installAndroidAppLifecycle = (): void => {
    if (installed || typeof window === 'undefined') {
        return;
    }
    installed = true;

    // 页面可见性兜底（桌面/浏览器、部分 ROM 多窗口下会与原生事件并存）。
    document.addEventListener('visibilitychange', () => {
        applyState(document.hidden ? 'background' : 'foreground');
    });

    if (!IS_ANDROID_WEBVIEW) {
        return;
    }

    const plugin = (window as any).Capacitor?.Plugins?.FoliaNative;
    if (plugin && typeof plugin.addListener === 'function') {
        Promise.resolve(
            plugin.addListener('appLifecycle', (event: { state?: string }) => {
                if (event?.state === 'background' || event?.state === 'foreground') {
                    applyState(event.state);
                }
            }),
        ).catch((error) => {
            console.warn('[AppLifecycle] native appLifecycle listener failed', error);
        });
    }
};
