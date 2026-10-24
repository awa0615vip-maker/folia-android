import { useEffect, useRef, type RefObject } from 'react';
import { PlayerState } from '../../../types';
import { IS_ANDROID_WEBVIEW } from '../../../utils/platform';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { currentTime } from '../../../stores/motionSignals';
import { useAndroidPlaybackEngineStore } from '../../../stores/useAndroidPlaybackEngineStore';
import {
    isIgnoringBatteryOptimizations,
    onNativeEngineEnded,
    onNativeEngineError,
    onNativeEngineProgress,
    pauseNativeEnginePlayback,
    requestIgnoreBatteryOptimizations,
    resumeNativeEnginePlayback,
    seekNativeEnginePlayback,
    startNativeEnginePlayback,
    stopNativeEnginePlayback,
} from '../../../services/nativeEngineBridge';

// src/components/app/playback/useNativePlaybackController.ts
// 原生播放器（MediaPlayer）方案的接线。声音由原生 MediaPlayer 硬解码直出，绕开 WebView 的
// WebAudio 图，消除卡顿/杂音/电音；UI 侧的歌词/进度/自动切歌由两个来源共同驱动：
//   - 前台：audio 元素静音保活（事件流照常驱动 automix、自动切歌、进度条）；
//   - 兜底：原生进度事件 nativeProgress 覆盖驱动时钟（后台/锁屏时 WebView 时钟可能冻结），
//     nativeEnded 兜底触发下一首（单曲循环则重播当前曲）。
// 本地 / 已缓存（blob URL）歌曲无法交给 MediaPlayer，自动回退原版 WebView 播放（本地不卡）。
const PROMPT_STORAGE_KEY = 'folia_battery_prompt_at';
const PROMPT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 未豁免时每 3 天提醒一次，避免每次启动弹窗

type NativePlaybackControllerOptions = {
    /** 原生播放器一首播完（且非单曲循环）时调用，驱动自动切歌。 */
    onEnded?: () => void;
};

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

export const useNativePlaybackController = (
    audioRef: RefObject<HTMLAudioElement | null>,
    options: NativePlaybackControllerOptions = {},
): void => {
    const engine = useAndroidPlaybackEngineStore((state) => state.playbackEngine);
    const audioSrc = usePlaybackStore((state) => state.audioSrc);
    const playerState = usePlaybackStore((state) => state.playerState);
    const onEnded = useRef(options.onEnded);
    onEnded.current = options.onEnded;
    // The remote URL currently handed to the native player; null while nothing is native.
    const nativeUrlRef = useRef<string | null>(null);
    const nativeActiveRef = useRef(false);
    const lastProgressRef = useRef(-1);

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

    // Native progress drives the UI clock as a fallback: in background/lock-screen the WebView
    // element's timeupdate can freeze (muted audio is throttled by Chromium), while the native
    // player keeps reporting. Values are in milliseconds.
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        return onNativeEngineProgress((event) => {
            if (!nativeActiveRef.current) return;
            if (typeof event.position !== 'number' || event.position < 0) return;
            // Only adopt native time when it moves forward from what the WebView clock reported,
            // so a paused native player can never rewind the UI while the element is paused too.
            const seconds = event.position / 1000;
            if (seconds > 0 && Math.abs(seconds - currentTime.get()) > 0.25) {
                currentTime.set(seconds);
            }
            lastProgressRef.current = event.position;
        });
    }, []);

    // Native completion: replay the same track when single-track loop is on (the muted element
    // loops on its own clock in the foreground, but the native player reaches completion
    // independently), otherwise hand control to the queue's next-track handler.
    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) return;
        return onNativeEngineEnded(() => {
            const element = audioRef.current;
            if (!nativeActiveRef.current) return;
            if (element && element.loop && nativeUrlRef.current) {
                void startNativeEnginePlayback(nativeUrlRef.current, 0);
                return;
            }
            nativeActiveRef.current = false;
            nativeUrlRef.current = null;
            onEnded.current?.();
        });
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
