import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SongResult } from '../../../types';
import {
    getLatticeGeometry,
    layoutExpandedBlock,
    layoutLattice,
    overlaps,
    toBounds,
    type Bounds,
    type ReflowTile,
    type WallMetrics,
} from '../../wall/layout';
import { useWallCameraPan, type LatticeCamera } from '../../wall/useWallCameraPan';
import { useLatticePosterSelection } from './useLatticePosterSelection';
import { useWallKeyboardFocus } from './useWallKeyboardFocus';
import { useWallPointerPan } from '../../wall/useWallPointerPan';
import { formatWorldTransform } from '../../wall/wallView';
import type { LatticeTile } from './latticeModel';
import LatticePoster from './LatticePoster';
import { countRender } from '../../../dev/renderCount';
import {
    useLatticePlaybackFocus,
} from './useLatticePlaybackFocus';
import { setLatticeCurrentSongPosterVisible } from '../../../stores/useLatticeControlsStore';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useDevicePixelRatio } from '../../../hooks/useMediaQuery';
import { useReducedMotionFor } from '../../../hooks/useReducedMotionFor';
import { EXPANSION_SPAN } from '../../wall/blockTemplates';
import { useLatticeSettingsStore } from '../../../stores/useLatticeSettingsStore';
import { resolveWallHandoffRole, useWallHandoffStore } from '../../../stores/useWallHandoffStore';
import { useLatticeWallHandoff } from './useLatticeWallHandoff';
import { wallFirstScreenStarted, notifyWallFirstScreenReady } from '../../../utils/wallFirstScreenGate';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import { setWallGestureThrottle } from '../../../utils/frameRateLimiter';
import { resolveEffectiveTier, usePerformanceTierStore } from '../../../stores/usePerformanceTierStore';
import { getPerformanceProfile } from '../../../utils/performanceProfile';

// Draggable poster field: one greedily packed block template repeats over the queue.
// 翻牌交接（设计稿 §7「进入队列」）：从资料库墙进来时不跑自己的入场波次，海报侧立着等资料库墙翻出、再按到起点的距离翻进；
// 回资料库墙时海报按距离翻出（useLatticeWallHandoff）。

type PosterWallProps = {
    tiles: LatticeTile[];
    /** Only for playback focus and visibility tracking; the chrome reads transport state from context. */
    currentSong: SongResult | null;
    onPlay: (tile: LatticeTile) => void;
    onTogglePlayback: () => void;
    onSeek: (time: number) => void;
    onOpenPlayer: () => void;
    onBack: () => void;
};


const CELL_SIZE = 128;
const GAP = 8;
const OVERSCAN = 500;
// 性能优先时的裁剪余量：默认那 500px 是为了让快速拖动不露白，但它同时也是 world 层被重画的面积。
const PERFORMANCE_OVERSCAN = 140;
// How much of the flight path may stay rendered while the camera travels, in viewports.
const MAX_RESERVED_VIEWPORTS = 3;
// Metro tile landing: the wave starts at the top-left of the viewport and runs down the diagonal.
const ENTRANCE_STAGGER = 0.03;
const ENTRANCE_MAX_DELAY = 0.34;
const ENTRANCE_WINDOW = 1100;
const METRICS: WallMetrics = { cellSize: CELL_SIZE, gap: GAP };
// Longest edge a card can reach, which is the gear expansion hands it.
const EXPANDED_SIZE = EXPANSION_SPAN.cols * (CELL_SIZE + GAP) - GAP;


const getScale = (width: number) => width < 640 ? 0.52 : width < 1100 ? 0.64 : 0.76;

const getWorldBounds = (camera: LatticeCamera, viewport: { width: number; height: number }): Bounds => ({
    left: -camera.x / camera.scale,
    top: -camera.y / camera.scale,
    right: (viewport.width - camera.x) / camera.scale,
    bottom: (viewport.height - camera.y) / camera.scale,
});

export default function PosterWall({
    tiles,
    currentSong,
    onPlay,
    onTogglePlayback,
    onSeek,
    onOpenPlayer,
    onBack,
}: PosterWallProps) {
    countRender('PosterWall');
    const containerRef = useRef<HTMLDivElement>(null);
    const worldRef = useRef<HTMLDivElement>(null);
    const cameraRef = useRef<LatticeCamera>({ x: 34, y: 80, scale: 0.76 });
    const viewportRef = useRef({ width: 1280, height: 720 });
    const frameRef = useRef<number | null>(null);
    const trackedCurrentPosterRef = useRef<{
        enabled: boolean;
        rect: Omit<ReflowTile, 'instanceId'> | null;
    }>({ enabled: false, rect: null });
    const currentPosterVisibleRef = useRef(true);
    const [bounds, setBounds] = useState<Bounds>(() => getWorldBounds(cameraRef.current, viewportRef.current));
    // Nothing is drawn until the field reports its size: the seeded camera and the default
    // viewport would otherwise place the entering wave, and the playing song, off centre.
    const [measured, setMeasured] = useState(false);
    const [entranceDone, setEntranceDone] = useState(false);
    // Camera scale, mirrored into state only so posters can size their artwork. It follows the
    // width breakpoints, so this settles after the first measure and then only moves on a resize.
    const [cameraScale, setCameraScale] = useState(() => cameraRef.current.scale);
    const reducedMotion = useReducedMotionFor('lattice');
    // 从资料库墙翻牌交接进来（或淡入交叉）：入场由交接代替，不跑抬起落下的波次。
    const entranceSuppressed = useWallHandoffStore(state => resolveWallHandoffRole(state.session, 'lattice') === 'in');
    const autoFocusOnSongChange = useLatticeSettingsStore(state => state.autoFocusOnSongChange);
    const performanceMode = useLatticeSettingsStore(state => state.latticePerformanceMode);
    // 自适应性能引擎：auto 时由硬件探测决定档位，手动选择则覆盖。所有渲染参数都从参数表取。
    const effectiveTier = usePerformanceTierStore(state => resolveEffectiveTier(state));
    const perfProfile = getPerformanceProfile(effectiveTier);
    // 用 ref 把档位参数交给命令式相机回调，避免档位没变就因 profile 重建一串 useCallback。
    const wallProfileRef = useRef(perfProfile.wall);
    wallProfileRef.current = perfProfile.wall;
    const devicePixelRatioRaw = useDevicePixelRatio();
    // 高 DPR 屏按档位钳制：低端机不按物理像素绘满，直接砍掉 GPU 填充量。
    const devicePixelRatio = Math.min(devicePixelRatioRaw, perfProfile.render.maxPixelRatio);
    // 性能优先（手动开关）或档位要求时，相机行程有限化；封面采样按档位取上限（低端 0.75，均衡 1）。
    const finiteCamera = performanceMode || perfProfile.wall.finiteCamera;
    const coverPixelScaleCap = performanceMode
        ? Math.min(perfProfile.render.coverPixelScaleCap, 1)
        : perfProfile.render.coverPixelScaleCap;
    const pixelScale = Math.min(cameraScale * devicePixelRatio, coverPixelScaleCap);
    // 相机行程（见 clampFiniteCamera）与裁剪余量都跟着收窄：性能优先时不再无限铺下去。
    const reservedViewports = finiteCamera ? perfProfile.wall.reservedViewports : MAX_RESERVED_VIEWPORTS;

    const geometry = useMemo(() => getLatticeGeometry(tiles.length, METRICS), [tiles.length]);
    // 每次只渲染约 (1+2*factor) 倍屏幕大小的区域：高端 0.35（1.7 倍）、均衡 0.22、低端 0.12。
    // 高端/均衡滑过的区域由 bounds 累积永久保留；低端档为有界滑动窗口，远处卡片会回收（见 applyCamera）。
    const overscan = measured
        ? Math.max(viewportRef.current.width / cameraScale, viewportRef.current.height / cameraScale)
            * perfProfile.wall.overscanFactor
        : OVERSCAN;
    const [activePoster, setActivePoster] = useLatticePosterSelection(tiles, geometry, METRICS);

    const publishCurrentPosterVisibility = useCallback((camera: LatticeCamera) => {
        const tracked = trackedCurrentPosterRef.current;
        const visible = !tracked.enabled || Boolean(
            tracked.rect && overlaps(toBounds(tracked.rect), getWorldBounds(camera, viewportRef.current)),
        );
        if (currentPosterVisibleRef.current === visible) return;
        currentPosterVisibleRef.current = visible;
        setLatticeCurrentSongPosterVisible(visible);
    }, []);

    const applyCamera = useCallback((next: LatticeCamera, updateBounds = false) => {
        cameraRef.current = next;
        if (worldRef.current) {
            /*
             * 相机用**二维** transform，不要用 translate3d。
             *
             * translate3d 会把整面墙提成常驻合成层，而 world 的实际 bounds 是
             * 12212x11580（受限的另一头）—— 任何一张磁贴在这个层里 repaint，
             * 都要按这个尺寸重新栅格化一遍 tile。桌面 GPU 撑得住，
             * Android WebView 的合成器面对超限层会反复丢弃重建，用户看到的就是
             * 「选歌时整屏闪烁」。实测 Trajectory：world 层整屏级 paint 6~10 次/次选歌，
             * 改成二维 transform 之后降到 0 —— 层不再存在，重绘被 `.lattice-field`
             * 的 paint containment 裁在保证可见的那一小块里。
             *
             * 平移本身不受影响：2D transform 同样可以被合成器处理，
             * pan 期间 Chromium 会临时提层，pan 结束自动降级。
             */
            worldRef.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
        }
        publishCurrentPosterVisibility(next);
        if (!updateBounds || frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
            setBounds(prev => {
                const next = getWorldBounds(cameraRef.current, viewportRef.current);
                const wall = wallProfileRef.current;
                if (wall.recycleOffscreen) {
                    // 低端档「有界滑动窗口」：bounds 各边外扩 recycleWindowFactor-overscanFactor，
                    // 交给 layoutLattice 再外扩 overscanFactor，合计在视口四周各留 recycleWindowFactor
                    // （0.3）屏、常驻约 1.6 倍视口。滑出窗口的卡片卸载，内存被钉死、不再越逛越大。
                    const scale = cameraRef.current.scale;
                    const margin = Math.max(viewportRef.current.width, viewportRef.current.height)
                        / scale * Math.max(0, wall.recycleWindowFactor - wall.overscanFactor);
                    const windowBounds = {
                        left: next.left - margin,
                        right: next.right + margin,
                        top: next.top - margin,
                        bottom: next.bottom + margin,
                    };
                    const prevCoversNext = next.left >= prev.left && next.right <= prev.right
                        && next.top >= prev.top && next.bottom <= prev.bottom;
                    // 视口还在已渲染区域内、且已渲染区域没有比窗口大太多时，继续累积（减少卸载抖动）；
                    // 一旦离开或区域过大，就以当前视口为中心重建窗口，远处卡片随之回收。
                    if (prevCoversNext) {
                        const prevArea = (prev.right - prev.left) * (prev.bottom - prev.top);
                        const windowArea = (windowBounds.right - windowBounds.left)
                            * (windowBounds.bottom - windowBounds.top);
                        if (prevArea <= windowArea * 1.4) return prev;
                    }
                    return windowBounds;
                }
                // 高/均衡档：渲染区域只增不减，把新视口并进已渲染区域，滑过的卡片永久保留、不再卸载。
                if (next.left >= prev.left && next.right <= prev.right
                    && next.top >= prev.top && next.bottom <= prev.bottom) return prev;
                return {
                    left: Math.min(prev.left, next.left),
                    right: Math.max(prev.right, next.right),
                    top: Math.min(prev.top, next.top),
                    bottom: Math.max(prev.bottom, next.bottom),
                };
            });
            frameRef.current = null;
        });
    }, [publishCurrentPosterVisibility]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(([entry]) => {
            viewportRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
            const scale = getScale(entry.contentRect.width);
            applyCamera({ ...cameraRef.current, scale }, true);
            setCameraScale(previous => previous === scale ? previous : scale);
            setMeasured(true);
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        };
    }, [applyCamera]);

    // Widens the culled region to cover a pan's destination the moment it starts. Held arrow
    // keys interrupt each pan before it settles, so bounds cannot wait for the animation to end.
    const reserveBounds = useCallback((camera: LatticeCamera) => {
        const destination = getWorldBounds(camera, viewportRef.current);
        setBounds(current => {
            const covered = destination.left >= current.left && destination.right <= current.right
                && destination.top >= current.top && destination.bottom <= current.bottom;
            if (covered) return current;

            const merged = {
                left: Math.min(current.left, destination.left),
                right: Math.max(current.right, destination.right),
                top: Math.min(current.top, destination.top),
                bottom: Math.max(current.bottom, destination.bottom),
            };
            // A long flight would otherwise reserve more than the render cap can fill, which
            // empties the far end; past that point only the destination is worth keeping.
            const mergedArea = (merged.right - merged.left) * (merged.bottom - merged.top);
            const destinationArea = (destination.right - destination.left)
                * (destination.bottom - destination.top);
            return mergedArea > destinationArea * reservedViewports ? destination : merged;
        });
    }, [reservedViewports]);

    /**
     * 性能优先：把相机拴在「一个格子 + 一屏余量」的框里，拖到底就停住，不再无限铺下去
     * （world 层的 bounds 因此始终在一屏上下，而不是用户拖到哪就长到哪）。
     * 只用在拖动 / 滚轮 / 惯性上：键盘与播放跟随（panTo）要能把任意一张卡带到眼前；它们真把相机带出框外时，
     * 框会把当前视口并进去一起放宽，所以下一次拖动不会被拽回来。
     */
    const clampFiniteCamera = useCallback((camera: LatticeCamera): LatticeCamera => {
        if (!finiteCamera) return camera;
        const viewport = viewportRef.current;
        const marginX = viewport.width / camera.scale;
        const marginY = viewport.height / camera.scale;
        const visible = getWorldBounds(camera, viewport);
        const range = {
            left: Math.min(-marginX, visible.left - marginX),
            right: Math.max(geometry.cellWidth + marginX, visible.right + marginX),
            top: Math.min(-marginY, visible.top - marginY),
            bottom: Math.max(geometry.cellHeight + marginY, visible.bottom + marginY),
        };
        const minX = viewport.width - range.right * camera.scale;
        const maxX = -range.left * camera.scale;
        const minY = viewport.height - range.bottom * camera.scale;
        const maxY = -range.top * camera.scale;
        return {
            ...camera,
            x: minX > maxX ? camera.x : Math.min(maxX, Math.max(minX, camera.x)),
            y: minY > maxY ? camera.y : Math.min(maxY, Math.max(minY, camera.y)),
        };
    }, [geometry.cellHeight, geometry.cellWidth, finiteCamera]);

    const { panTo, stopPan, animationRef } = useWallCameraPan({ cameraRef, viewportRef, reducedMotion, applyCamera, reserveBounds });

    useEffect(() => {
        if (!measured || entranceDone) return;
        if (reducedMotion || entranceSuppressed) {
            setEntranceDone(true);
            return;
        }
        const timer = setTimeout(() => setEntranceDone(true), ENTRANCE_WINDOW);
        return () => clearTimeout(timer);
    }, [entranceDone, entranceSuppressed, measured, reducedMotion]);

    // Posters landing in the opening wave are held back by their distance from that corner; once
    // the wave is over every poster mounts in place, so panning never replays it.
    const getEntranceDelay = useCallback((rect: { x: number; y: number }) => {
        if (entranceDone || reducedMotion || entranceSuppressed) return null;
        const steps = Math.max(0, rect.x - bounds.left) + Math.max(0, rect.y - bounds.top);
        return Math.min(ENTRANCE_MAX_DELAY, (steps / (CELL_SIZE + GAP)) * ENTRANCE_STAGGER);
    }, [bounds.left, bounds.top, entranceDone, entranceSuppressed, reducedMotion]);

    // The entry wave reaches the top-left first; leaving reverses that order while cards retrace
    // their upward flight, so the wall empties back toward the corner it entered from.
    //
    // Permanently identified, and reading the corner it measures from through a ref, because the
    // posters hold this across camera moves. A delay computed per render would have to be handed
    // down as a changing number, and the corner moves with every pan - which defeated
    // LatticePoster's memo and re-rendered every mounted card on each re-cull. The card calls this
    // when it actually leaves, so the wave is still measured against the corner of the moment.
    const exitWaveRef = useRef({ bounds, reducedMotion });
    exitWaveRef.current = { bounds, reducedMotion };
    const getExitDelay = useCallback((rect: { x: number; y: number }) => {
        const { bounds: corner, reducedMotion: reduced } = exitWaveRef.current;
        if (reduced) return 0;
        const steps = Math.max(0, rect.x - corner.left) + Math.max(0, rect.y - corner.top);
        const entranceDelay = Math.min(ENTRANCE_MAX_DELAY, (steps / (CELL_SIZE + GAP)) * ENTRANCE_STAGGER);
        return ENTRANCE_MAX_DELAY - entranceDelay;
    }, []);

    const instances = useMemo(() => {
        if (!measured) return [];
        const visible = layoutLattice(
            geometry,
            tiles.length,
            bounds,
            overscan,
            METRICS,
            perfProfile.wall.maxRenderedInstances,
        );
        if (!activePoster || visible.some(instance => instance.instanceId === activePoster.instance.instanceId)) {
            return visible;
        }
        return [...visible, activePoster.instance];
    }, [activePoster, bounds, geometry, measured, overscan, perfProfile.wall.maxRenderedInstances, tiles.length]);

    // Only changes when the mounted instance set changes, not on every camera frame.
    const renderedInstanceIds = useMemo(
        () => new Set(instances.map(instance => instance.instanceId)),
        [instances],
    );

    // 安卓启动门：首屏卡片在启动遮罩下完成挂载、封面经 SW 缓存解码后才放行（见 AppSplashGate）。
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW || !measured || instances.length === 0) return;
        wallFirstScreenStarted();
        const field = containerRef.current;
        if (!field) {
            notifyWallFirstScreenReady();
            return;
        }
        const start = performance.now();
        // 启动门等待上限按档位：低端 3.2s 早进（避免低端机被遮罩卡更久），高端 6s 等首屏完整。
        const INNER_LIMIT_MS = perfProfile.splash.maxWaitMs;
        let cancelled = false;
        let timer = 0;
        const probes = new Map<string, HTMLImageElement>();
        const waitFrames = (n: number) => new Promise<void>(resolve => {
            const step = () => {
                n -= 1;
                if (n > 0) requestAnimationFrame(step);
                else resolve();
            };
            requestAnimationFrame(step);
        });
        // 封面是 CSS 背景图，读不到 img.complete：用同 URL 的 Image 探测，命中缓存即代表背景马上能画。
        const coversReady = (): boolean => {
            const urls: string[] = [];
            field.querySelectorAll<HTMLElement>('.lattice-poster').forEach(el => {
                const match = (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
                if (match?.[1]) urls.push(match[1]);
            });
            if (urls.length === 0) return false;
            for (const url of new Set(urls)) {
                let probe = probes.get(url);
                if (!probe) {
                    probe = new Image();
                    probe.src = url;
                    probes.set(url, probe);
                }
                if (!probe.complete) return false;
            }
            return true;
        };
        const finish = () => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (!cancelled) notifyWallFirstScreenReady();
            }));
        };
        const poll = () => {
            if (cancelled) return;
            if (coversReady() || performance.now() - start > INNER_LIMIT_MS) {
                finish();
                return;
            }
            timer = window.setTimeout(poll, 120);
        };
        void waitFrames(2).then(poll);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [measured, instances.length === 0]);

    // World point the viewport is centred on; both the keyboard seed and playback follow need it.
    const getViewportCenter = useCallback(() => {
        const camera = cameraRef.current;
        const viewport = viewportRef.current;
        return {
            x: (viewport.width / 2 - camera.x) / camera.scale,
            y: (viewport.height / 2 - camera.y) / camera.scale,
        };
    }, []);

    const { didDragRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } = useWallPointerPan({
        applyCamera,
        animationRef,
        stopPan,
        containerRef,
        reducedMotion,
        overscan,
        // 性能优先时的相机行程上限（拖动 / 滚轮 / 惯性）；键盘与播放跟随不走这条路。
        clampCamera: clampFiniteCamera,
        bounds,
        cameraRef,
        getWorldBounds,
        viewportRef,
        // 滑动海报墙期间临时压低动画帧率，让 GPU 优先跟手（播放时歌词/可视化不再抢帧）；松手惯性结束自动恢复。
        onGestureStart: () => setWallGestureThrottle(true),
        onGestureEnd: () => setWallGestureThrottle(false),
    });

    // Only the block holding the open card is re-geared; every other poster keeps its base rect.
    const layout = useMemo(() => (
        activePoster
            ? layoutExpandedBlock(geometry, tiles.length, activePoster.instance, METRICS)
            : new Map<string, { x: number; y: number; width: number; height: number }>()
    ), [activePoster, geometry, tiles.length]);

    useEffect(() => {
        const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
        const isTracking = measured && Boolean(currentSongKey);
        const rect = activePoster && activePoster.tile.id === currentSongKey
            ? layout.get(activePoster.instance.instanceId) ?? activePoster.instance
            : null;
        trackedCurrentPosterRef.current = { enabled: isTracking, rect };
        publishCurrentPosterVisibility(cameraRef.current);
    }, [activePoster, currentSong, layout, measured, publishCurrentPosterVisibility]);

    useEffect(() => () => {
        currentPosterVisibleRef.current = true;
        setLatticeCurrentSongPosterVisible(true);
    }, []);

    const { focused, setFocused, handleKeyDown, handleFocusCapture, handleBlurCapture } = useWallKeyboardFocus({
        activePoster,
        containerRef,
        geometry,
        getViewportCenter,
        instances,
        metrics: METRICS,
        panTo,
        rendered: layout,
        setActivePoster,
        tiles,
        worldRef,
        onBack,
    });

    // Permanent identities for the two handlers every poster receives. An arrow per poster is
    // re-created on each wall render, which alone would defeat LatticePoster's memo and put all
    // 50+ poster bodies back on the critical path of every unrelated App re-render.
    const latestWall = useRef({ geometry, instances, tiles });
    latestWall.current = { geometry, instances, tiles };
    const expandPoster = useCallback((instanceId: string) => {
        const { geometry: currentGeometry, instances: currentInstances, tiles: currentTiles } = latestWall.current;
        const instance = currentInstances.find(item => item.instanceId === instanceId);
        const tile = instance ? currentTiles[instance.queueIndex] : undefined;
        if (!instance || !tile) return;
        setFocused(instance);
        setActivePoster({ instance, tile });
        // Expansion reflows both the position and size of the selected slot.
        const expandedRect = layoutExpandedBlock(currentGeometry, currentTiles.length, instance, METRICS).get(instanceId);
        if (expandedRect) panTo(expandedRect);
    }, [panTo, setActivePoster, setFocused]);
    const collapsePoster = useCallback(() => setActivePoster(null), [setActivePoster]);

    useLatticePlaybackFocus({
        currentSong,
        ready: measured,
        tiles,
        activePoster,
        renderedInstanceIds,
        geometry,
        metrics: METRICS,
        getViewportCenter,
        setActivePoster,
        setFocused,
        panTo,
    });
    const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    const handoff = useLatticeWallHandoff({
        containerRef,
        cameraRef,
        applyCamera,
        measured,
        metrics: METRICS,
        activePoster,
        layout,
        focused,
        waitingForFocus: autoFocusOnSongChange && !activePoster && currentSongKey !== null
            && tiles.some(tile => tile.id === currentSongKey),
    });
    return (
        <div
            ref={containerRef}
            className="lattice-field"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            onFocusCapture={handleFocusCapture}
            onBlurCapture={handleBlurCapture}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={event => {
                // Touch transfers implicit capture from the poster to the field when dragging.
                if (event.target === event.currentTarget) onPointerCancel(event);
            }}
            onClickCapture={onClickCapture}
        >
            <div ref={worldRef} className="lattice-world">
                {instances.map(instance => {
                    const tile = tiles[instance.queueIndex];
                    if (!tile) return null;
                    const expanded = activePoster?.instance.instanceId === instance.instanceId;
                    const rect = layout.get(instance.instanceId) ?? instance;
                    return (
                        <LatticePoster
                            key={instance.instanceId}
                            instanceId={instance.instanceId}
                            isFocused={focused?.instanceId === instance.instanceId}
                            tile={tile}
                            rect={rect}
                            gap={METRICS.gap}
                            pixelScale={pixelScale}
                            expandedSize={EXPANDED_SIZE}
                            entranceDelay={getEntranceDelay(rect)}
                            getExitDelay={getExitDelay}
                            handoff={handoff.getPosterHandoff(instance.instanceId, rect)}
                            expanded={expanded}
                            reducedMotion={reducedMotion}
                            didDragRef={didDragRef}
                            onExpand={expandPoster}
                            onPlay={onPlay}
                            onTogglePlayback={onTogglePlayback}
                            onSeek={onSeek}
                            onOpenPlayer={onOpenPlayer}
                        />
                    );
                })}
            </div>

        </div>
    );
}
