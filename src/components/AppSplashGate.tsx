import React from 'react';
import { hideAppSplash } from '../utils/appSplash';
import { IS_ANDROID_WEBVIEW } from '../utils/platform';

// src/components/AppSplashGate.tsx
// 包在根组件树外层：首帧挂载完成后（useEffect 在浏览器绘制之后触发）移除首屏加载遮罩，
// 保证遮罩淡出时下面已经是渲染好的界面，而不是空白。
//
// 安卓上额外做一次「提前渲染」：复用原有的启动遮罩（不新增任何界面），让首屏在遮罩下
// 先挂载、封面走 Service Worker 持久缓存命中并解码，等封面 SW 就绪（或到最长时间窗）再淡出。
// 遮罩本身的样式与动画完全不变，只是淡出时机延后到首屏就绪。

const PREWARM_MIN_MS = 900;   // 遮罩至少停留，与原生启动画面时长对齐，避免衔接闪烁
const PREWARM_MAX_MS = 1600;  // 最长停留，慢网络 / SW 未就绪也保证进入
const SW_READY_TIMEOUT_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise(resolve => {
    window.setTimeout(resolve, ms);
});

// 等封面 Service Worker 就绪（在线 / 本地封面缓存路由生效），自带超时，绝不卡住启动。
const waitForCoverWorker = (): Promise<void> => new Promise(resolve => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        resolve();
        return;
    }
    let settled = false;
    const done = () => {
        if (!settled) {
            settled = true;
            resolve();
        }
    };
    const timer = window.setTimeout(done, SW_READY_TIMEOUT_MS);
    navigator.serviceWorker.ready
        .then(() => {
            window.clearTimeout(timer);
            done();
        })
        .catch(() => {
            window.clearTimeout(timer);
            done();
        });
});

const AppSplashGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    React.useEffect(() => {
        // 非安卓：保持原有行为，首帧后立即淡出。
        if (!IS_ANDROID_WEBVIEW) {
            hideAppSplash();
            return;
        }

        let cancelled = false;
        const start = performance.now();
        // children 已经在遮罩下挂载，首屏封面会在这个窗口内经过 SW 缓存提前渲染。
        void Promise.all([wait(PREWARM_MIN_MS), waitForCoverWorker()])
            .then(() => {
                if (cancelled) return;
                const elapsed = performance.now() - start;
                // 不早于最短窗口、不晚于最长窗口。
                const holdFor = Math.min(PREWARM_MAX_MS, Math.max(PREWARM_MIN_MS, elapsed));
                const remaining = Math.max(0, holdFor - elapsed);
                return wait(remaining);
            })
            .then(() => {
                if (!cancelled) hideAppSplash();
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return <>{children}</>;
};

export default AppSplashGate;
