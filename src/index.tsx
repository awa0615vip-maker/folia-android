import { Buffer } from 'buffer';
import {
    installGlobalVisualizerFrameRateLimiter,
    VISUALIZER_FRAME_RATE_STORAGE_KEY,
} from './utils/frameRateLimiter';
import { readPerformanceProfile } from './stores/usePerformanceTierStore';
import { IS_ANDROID_WEBVIEW } from './utils/platform';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installCrashDiagnostics } from './utils/crashDiagnostics';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installFrameTimingDiagnostics } from './utils/frameTimingDiagnostics';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installAndroidAppLifecycle } from './services/androidAppLifecycle';
import { installAndroidPhoneFitPreference } from './services/androidPhoneLayout';
import { installKeepScreenOnPreference } from './services/androidKeepScreenOn';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
if (IS_ANDROID_WEBVIEW) installCrashDiagnostics();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
if (IS_ANDROID_WEBVIEW) installFrameTimingDiagnostics();
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
// 全局帧率门：用户在图形设置里手动选过就永远听用户；否则安卓按设备档位给默认（高端 60、
// 中低端 30），桌面保持原行为不限制。
const userSetFrameRate = typeof window !== 'undefined'
    && window.localStorage.getItem(VISUALIZER_FRAME_RATE_STORAGE_KEY) !== null;
if (IS_ANDROID_WEBVIEW && !userSetFrameRate) {
    installGlobalVisualizerFrameRateLimiter(readPerformanceProfile().render.visualizerFrameRate);
} else {
    installGlobalVisualizerFrameRateLimiter();
}
if (IS_ANDROID_WEBVIEW) {
    installAndroidPhoneFitPreference();
    // 屏幕常亮：启动时套用保存的开关状态（安卓走原生窗口标志）。
    installKeepScreenOnPreference();
    void installNativeAndroidBridge();
    // 前后台生命周期：进后台冻结可视化渲染只保留音频、回前台检查并续播被系统挂起的音频。
    installAndroidAppLifecycle();

    // 低端省电档且用户从未手动选过可视化器时，预设为官方静态低资源模式（still）。
    // 必须在动态 import('./bootstrap') 之前写入 localStorage —— 可视化器 store 首次读取就会拿到它；
    // 用户一旦手动选过任意模式，这里就不再介入。
    if (typeof window !== 'undefined'
        && window.localStorage.getItem('visualizer_mode') === null) {
        const fallbackVisualizer = readPerformanceProfile().visualizer.autoFallbackMode;
        if (fallbackVisualizer) {
            window.localStorage.setItem('visualizer_mode', fallbackVisualizer);
        }
    }
}

void import('./bootstrap');
