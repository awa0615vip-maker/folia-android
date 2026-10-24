// src/components/app/lattice/lyrics/latticeLyricFrameLoop.ts
// One demand-driven loop; paused and hidden cards never keep a background ticker alive.
export function createLatticeLyricFrameLoop(draw: (delta: number) => boolean,
    request: (callback: FrameRequestCallback) => number = requestAnimationFrame,
    cancel: (id: number) => void = cancelAnimationFrame,
    maxFps = 60) {
    let frame: number | null = null, previous = 0, visible = true, destroyed = false;
    let lastFrameTime = 0;
    const intervalMs = maxFps > 0 ? 1000 / maxFps : 0;
    const tick: FrameRequestCallback = time => {
        frame = null;
        if (destroyed || !visible) return;
        if (intervalMs > 0 && lastFrameTime > 0 && time - lastFrameTime < intervalMs) {
            wake();
            return;
        }
        lastFrameTime = time;
        const delta = previous ? Math.min(0.05, (time - previous) / 1000) : 1 / Math.max(1, maxFps);
        previous = time;
        if (draw(delta)) wake();
    };
    const wake = () => {
        if (!destroyed && visible && frame === null) frame = request(tick);
    };
    const stop = () => { if (frame !== null) cancel(frame); frame = null; previous = 0; };
    return { wake,
        setVisible(value: boolean) { visible = value; if (value) wake(); else stop(); },
        destroy() { destroyed = true; stop(); },
    };
}
