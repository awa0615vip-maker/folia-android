import { loadPixi } from '../../../visualizer/pixi/loadPixi';

// src/components/app/lattice/lyrics/prewarmLatticeLyrics.ts
let started = false;
let contextWarmed = false;

/**
 * Pulls the lyric chunk and Pixi in before the card is opened, and warms a real WebGL context
 * once so the first click path is left with neither a chunk fetch, a module parse, nor the slow
 * first context creation (Android WebView compiles shaders synchronously, which froze the frame
 * and showed a black flash). Both imports are module-cached, so the click path reuses them.
 */
export const prewarmLatticeLyrics = () => {
    if (started) return;
    started = true;
    void Promise.all([import('./LatticeLyrics'), loadPixi().then(warmWebGLContext)]).catch(() => { started = false; });
};

/**
 * Creates one real WebGL context and immediately releases it. On Android this pays the one-time
 * GPU-process startup and first shader compile while the wall is idle instead of on the click:
 * a later Pixi Application initializes much faster even though this context was destroyed.
 */
const warmWebGLContext = async (pixi: typeof import('pixi.js')): Promise<void> => {
    if (contextWarmed) return;
    const app = new pixi.Application();
    try {
        await app.init({ preference: 'webgl', backgroundAlpha: 0, antialias: true,
            width: 1, height: 1, resolution: 1, autoDensity: true, autoStart: false, sharedTicker: false });
        contextWarmed = true;
    } catch {
        // No WebGL or a transient failure: the real lyric runtime will report its own error.
    } finally {
        try { app.destroy({ removeView: true }, { children: true }); } catch { /* ignore */ }
    }
};
