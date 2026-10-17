import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState } from '../types';
import { IS_ANDROID_WEBVIEW } from '../utils/platform';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { subscribeAppLifecycle } from '../services/androidAppLifecycle';

// 回前台音频看门狗：
// 华为/鸿蒙等 ROM 即使应用持有前台服务，切后台后仍可能冻结 WebView 渲染进程，导致其中的
// audio 元素被挂起（paused）或在线流卡死且无声。回到前台时，若播放状态显示“应该播放”，
// 但音频元素已暂停或进度不再前进，就调用与“按播放”完全相同的 resumePlayback() 从断点续播
// （它内部会刷新过期的在线音源并保留进度），而不是让用户看到“又得重新播放”。
//
// 只做“恢复到用户原本的播放意图”，不会在用户已手动暂停时自行播放。

type UseAndroidBackgroundPlaybackGuardOptions = {
    /** 优先取当前真正出声的那块 deck（automix 过渡时与 audioRef 可能不是同一元素）。 */
    getDisplayAudioElement: () => HTMLAudioElement | null;
    audioRef: RefObject<HTMLAudioElement | null>;
    resumePlayback: () => Promise<void>;
};

export const useAndroidBackgroundPlaybackGuard = ({
    getDisplayAudioElement,
    audioRef,
    resumePlayback,
}: UseAndroidBackgroundPlaybackGuardOptions) => {
    const resumeRef = useRef(resumePlayback);
    resumeRef.current = resumePlayback;
    const getElementRef = useRef(getDisplayAudioElement);
    getElementRef.current = getDisplayAudioElement;

    useEffect(() => {
        if (!IS_ANDROID_WEBVIEW) {
            return;
        }

        const wantsPlay = () =>
            selectDisplayPlayerState(usePlaybackStore.getState()) === PlayerState.PLAYING;

        const getAudio = (): HTMLAudioElement | null =>
            getElementRef.current?.() ?? audioRef.current ?? null;

        const restoreIfNeeded = () => {
            if (!wantsPlay()) {
                return;
            }

            // 1) 被系统挂起（paused/ended）：多次尝试，覆盖 WebView 媒体线程恢复较慢的机型。
            const resumeIfStopped = (delayMs: number) => {
                window.setTimeout(() => {
                    if (!wantsPlay()) {
                        return;
                    }
                    const audio = getAudio();
                    if (audio && (audio.paused || audio.ended)) {
                        void resumeRef.current().catch(() => undefined);
                    }
                }, delayMs);
            };
            resumeIfStopped(150);
            resumeIfStopped(600);
            resumeIfStopped(1500);

            // 2) 元素声称仍在播放但进度卡死（在线流被冻结/无声）：采样两次 currentTime，
            //    正常播放不可能在 900ms 内分毫不走；判定卡死则续播（对正在播放的元素 play() 幂等）。
            const first = getAudio();
            if (!first || first.paused || first.ended) {
                return;
            }
            const startTime = first.currentTime;
            window.setTimeout(() => {
                if (!wantsPlay()) {
                    return;
                }
                const audio = getAudio();
                if (!audio || audio.paused || audio.ended) {
                    return;
                }
                if (audio.currentTime === startTime && audio.readyState < 4) {
                    void resumeRef.current().catch(() => undefined);
                }
            }, 900);
        };

        const unsubscribe = subscribeAppLifecycle((state) => {
            if (state === 'foreground') {
                restoreIfNeeded();
            }
        });

        return unsubscribe;
    }, [audioRef]);
};
