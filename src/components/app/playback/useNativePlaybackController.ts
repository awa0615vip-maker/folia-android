import { useEffect, useRef, type RefObject } from 'react';
import { PlayerState } from '../../../types';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { useAndroidPlaybackEngineStore } from '../../../stores/useAndroidPlaybackEngineStore';
import {
    isIgnoringBatteryOptimizations,
    onNativeEngineError,
    pauseNativeEnginePlayback,
    requestIgnoreBatteryOptimizations,
    resumeNativeEnginePlayback,
    seekNativeEnginePlayback,
    startNativeEnginePlayback,
    stopNativeEnginePlayback,
} from '../../../services/nativeEngineBridge';

// src/components/app/playback/useNativePlaybackController.ts
// 原生播放器（MediaPlayer）方案的接线：UI/队列/歌词/进度全部沿用原版（audio 元素静音保活，
// 事件流照常驱动 automix、自动切歌、进度条），真正的声音改由原生 MediaPlayer 输出——
// 绕开安卓 WebView 的 WebAudio 图，消除卡顿/杂音/电音。均衡器与频谱可视化在原生模式下
// 不作用于声音（设置里已注明）；automix 过渡在关闭混音时不受影响。
//
// 本地 / 已缓存（blob URL）歌曲无法交给 MediaPlayer，自动回退原版 WebView 播放（本地不卡）。
const PROMPT_STORAGE_KEY = 'folia_battery_prompt_at';
const PROMPT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 未豁免时每 3 天提醒一次，避免每次启动弹窗

const maybePromptBatteryOptimization = (): void => {
    if (!IS_ANDROID_WEBVIEW) return;
    void isIgnoringBatteryOptimizations().then((ignoring) => {
        if (ignoring) return;
        try {
            const last = Number(localStorage.getItem(PROMPT_STORAGE_KEY) ?? 0);
            if (Date.now() - last < PROMPT_INTERVAL_MS) return;
            localStorage.setItem(PROMPT_STORAGE_KEY, String(Date.now()));
        } catch {
            // 存储不可用时不阻止请求。
        }
        void requestIgnoreBatteryOptimizations().catch(() => undefined);
    }).catch(() => undefined);
};

export const useNativePlaybackController = (audioRef: RefObject<HTMLAudioElement | null>): void => {
    const engine = useAndroidPlaybackEngineStore((state) => state.playbackEngine);
    const audioSrc = usePlaybackStore((state) => state.audioSrc);
    const playerState = usePlaybackStore((state) => state.playerState);
    // The remote URL currently handed to the native player; null while nothing is native.
    const nativeUrlRef = useRef<string | null>(null);
    const nativeActiveRef = useRef(false);

    // A remote (http/https) URL is eligible for native playback; blob URLs (local / cached
    // tracks) stay on the WebView path, which plays local bytes without stutter.
    const nativeEligible = Boolean(
        IS_ANDROID_WEBVIEW
        && engine === 'native'
        && audioSrc
        && /^https?:/i.test(audioSrc)
    );

    // Drives the native player from the app's playback state.
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        const element = audioRef.current;

        if (nativeEligible) {
            if (playerState === PlayerState.PLAYING) {
                if (nativeUrlRef.current !== audioSrc) {
                    nativeUrlRef.current = audioSrc;
                    nativeActiveRef.current = true;
                    if (element) element.muted = true;
                    if (audioSrc) void startNativeEnginePlayback(audioSrc, 0);
                } else if (nativeActiveRef.current) {
                    if (element) element.muted = true;
                    void resumeNativeEnginePlayback();
                }
            } else {
                if (nativeActiveRef.current) void pauseNativeEnginePlayback();
                // The muted WebView element is parked; the transport's own pause handles it.
            }
        } else if (nativeActiveRef.current || nativeUrlRef.current !== null) {
            nativeActiveRef.current = false;
            nativeUrlRef.current = null;
            void stopNativeEnginePlayback();
            if (element) element.muted = false;
        }
    }, [audioSrc, playerState, nativeEligible, audioRef]);

    // A seek on the muted WebView element is mirrored into the native player.
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        const element = audioRef.current;
        if (!element) return;
        const onSeeked = () => {
            if (nativeActiveRef.current) {
                void seekNativeEnginePlayback(Math.round(element.currentTime * 1000));
            }
        };
        element.addEventListener('seeked', onSeeked);
        return () => element.removeEventListener('seeked', onSeeked);
    }, [audioRef]);

    // Native playback failure: fall back to the WebView element so the song still plays.
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        return onNativeEngineError(() => {
            const element = audioRef.current;
            if (element) element.muted = false;
            if (nativeActiveRef.current) {
                nativeActiveRef.current = false;
                nativeUrlRef.current = null;
                void stopNativeEnginePlayback().catch(() => undefined);
            }
        });
    }, [audioRef]);

    // One-time battery-optimization prompt (user asked: ask for unrestricted background on launch).
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        maybePromptBatteryOptimization();
    }, []);
};
