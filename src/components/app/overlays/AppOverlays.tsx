import React from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import NowPlayingToast from './NowPlayingToast';
import BottomCommandPaletteButton from './BottomCommandPaletteButton';
// 性能：搜索工作区、调试覆盖层、内存监视器都是按需打开的重型面板，懒加载，不进入首屏闭包。
const SearchWorkspace = React.lazy(() => import('../search/SearchWorkspace'));
const DevDebugOverlay = React.lazy(() => import('../../DevDebugOverlay'));
const MemoryMonitorWindow = React.lazy(() => import('../../debug/MemoryMonitorWindow'));
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    const {
        searchOverlay,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
    } = model;

    return (
        <>
            {searchOverlay && (
                <React.Suspense fallback={null}>
                    <SearchWorkspace {...searchOverlay} />
                </React.Suspense>
            )}

            {debugOverlay && (
                <React.Suspense fallback={null}>
                    <DevDebugOverlay {...debugOverlay} />
                </React.Suspense>
            )}

            {memoryMonitor && (
                <React.Suspense fallback={null}>
                    <MemoryMonitorWindow {...memoryMonitor} />
                </React.Suspense>
            )}

            {floatingControls
                && (floatingControls.currentView !== 'lattice' || !isCurrentSongPosterVisible)
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}

            {/* 桌面版有 Ctrl+K，触屏设备需要这个按钮才能打开命令面板。 */}
            {typeof window !== 'undefined' && !(window as unknown as { electron?: unknown }).electron && (
                <BottomCommandPaletteButton />
            )}
        </>
    );
};

export default React.memo(AppOverlays);
