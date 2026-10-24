import { create } from 'zustand';

// src/stores/useAndroidPlaybackEngineStore.ts
// 播放方案选择：WebView 内置（默认原版，功能全，但安卓 WebView 音频易卡顿/炸音）
// 或原生播放器（MediaPlayer 硬解码，流畅干净；均衡器/频谱可视化不生效，仅在线歌曲）。
// 默认原生：装上即流畅，设置里可一键切回原版。

export type PlaybackEngine = 'webview' | 'native';

const ENGINE_STORAGE_KEY = 'folia_android_playback_engine';

type AndroidPlaybackEngineState = {
    playbackEngine: PlaybackEngine;
    setPlaybackEngine: (engine: PlaybackEngine) => void;
};

const readStoredEngine = (): PlaybackEngine => {
    if (typeof window === 'undefined') return 'native';
    try {
        const saved = localStorage.getItem(ENGINE_STORAGE_KEY);
        return saved === 'webview' ? 'webview' : 'native';
    } catch {
        return 'native';
    }
};

const writeStoredEngine = (engine: PlaybackEngine): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ENGINE_STORAGE_KEY, engine);
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

export const useAndroidPlaybackEngineStore = create<AndroidPlaybackEngineState>((set) => ({
    playbackEngine: readStoredEngine(),
    setPlaybackEngine: (engine) => {
        writeStoredEngine(engine);
        set({ playbackEngine: engine });
    },
}));
