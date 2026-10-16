import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { runSleepTimerExpiryAction } from './sleepTimerExpiry';
import { useSleepTimerStore } from '../stores/useSleepTimerStore';
import type { SleepTimerMode } from '../stores/useSleepTimerStore';
import {
    addNativeSleepTimerExpiredListener,
    armNativeSleepTimer,
    cancelNativeSleepTimer,
    isNativeSleepTimerAvailable,
} from '../services/nativeSleepTimer';

// src/hooks/useSleepTimer.ts

type UseSleepTimerState = {
    enabled: boolean;
    hours: number;
    minutes: number;
    /** 倒计时模式 vs 播完当前这首再停。 */
    mode: SleepTimerMode;
    /** 运行时追加的时长（毫秒）。 */
    extensionMs: number;
    /** 当前正在播放的曲目 id（用于播完本曲模式判断曲目切换）。 */
    currentTrackId: string | null;
    /** 音频元素引用，用于读取 ended / currentTime。 */
    audioRef: MutableRefObject<HTMLAudioElement | null>;
    onExpireFallback: () => void;
};

const TICK_MS = 1000;
const TRACK_END_TICK_MS = 1000;
// 判定“走到结尾”的余量（秒），避免不同设备 duration 抖动导致判定不到。
const TRACK_END_TOLERANCE_SECONDS = 0.5;

export const useSleepTimer = ({
    enabled,
    hours,
    minutes,
    mode,
    extensionMs,
    currentTrackId,
    audioRef,
    onExpireFallback,
}: UseSleepTimerState) => {
    const onExpireFallbackRef = useRef(onExpireFallback);
    const activationId = useSleepTimerStore(state => state.sleepTimerActivationId);
    // Android 上使用原生 AlarmManager 负责到期暂停，后台/锁屏/Doze 都可靠。
    const useNativeTimer = isNativeSleepTimerAvailable();

    useEffect(() => {
        onExpireFallbackRef.current = onExpireFallback;
    }, [onExpireFallback]);

    // 统一的到期处理：复位状态并执行暂停（桌面端可退出）。
    const fireExpiry = () => {
        useSleepTimerStore.setState({
            sleepTimerEnabled: false,
            sleepTimerDeadlineMs: null,
        });
        void runSleepTimerExpiryAction({
            quitApp: window.electron?.quitApp,
            onFallback: () => onExpireFallbackRef.current(),
        });
    };

    const fireExpiryRef = useRef(fireExpiry);
    useEffect(() => {
        fireExpiryRef.current = fireExpiry;
    });

    // 原生定时器到期：原生已通过媒体动作通道暂停播放，这里只需复位开关与倒计时。
    useEffect(() => {
        if (!useNativeTimer) return undefined;
        const removeListener = addNativeSleepTimerExpiredListener(() => {
            useSleepTimerStore.setState({
                sleepTimerEnabled: false,
                sleepTimerDeadlineMs: null,
            });
        });
        return removeListener;
    }, [useNativeTimer]);

    // ===== 模式二：播完当前这首再暂停 =====
    const armedTrackIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!enabled || mode !== 'trackEnd') {
            armedTrackIdRef.current = null;
            return undefined;
        }
        // 记录布防时的曲目；它一旦自然结束（ended 或切到下一首）就暂停。
        armedTrackIdRef.current = currentTrackId;
        const timer = window.setInterval(() => {
            const element = audioRef.current;
            const armedId = armedTrackIdRef.current;
            // 自然结束且没有自动切歌：元素 ended 为 true。
            if (element && element.ended) {
                window.clearInterval(timer);
                fireExpiryRef.current();
                return;
            }
            // 已切到下一首（自然结束自动续播，或用户手动切歌）：立即暂停。
            if (armedId && currentTrackId && currentTrackId !== armedId) {
                window.clearInterval(timer);
                fireExpiryRef.current();
                return;
            }
            // 兜底：位置已到达结尾且元素已暂停（个别设备 ended 标志不可靠）。
            if (
                element &&
                element.duration > 0 &&
                element.currentTime >= element.duration - TRACK_END_TOLERANCE_SECONDS &&
                element.paused
            ) {
                window.clearInterval(timer);
                fireExpiryRef.current();
            }
        }, TRACK_END_TICK_MS);

        return () => {
            window.clearInterval(timer);
            useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
        };
        // 注意：currentTrackId 是不断变化的读取值，这里只在激活/模式变化时重新布防。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activationId, enabled, mode]);

    // ===== 模式一：倒计时到点暂停 =====
    useEffect(() => {
        if (!enabled || mode !== 'duration') {
            return undefined;
        }
        if (hours === 0 && minutes === 0 && extensionMs === 0) {
            useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
            if (useNativeTimer) void cancelNativeSleepTimer();
            return undefined;
        }

        const totalMs = (hours * 3600 + minutes * 60) * 1000 + extensionMs;
        const deadline = Date.now() + totalMs;
        useSleepTimerStore.setState({ sleepTimerDeadlineMs: deadline });

        if (useNativeTimer) {
            // 到期暂停交给原生精确闹钟；Web 端仅保留 deadline 用于界面显示剩余时间。
            armNativeSleepTimer(totalMs)
                .then((nativeDeadline) => {
                    useSleepTimerStore.setState({ sleepTimerDeadlineMs: nativeDeadline });
                })
                .catch(() => undefined);
            return () => {
                void cancelNativeSleepTimer();
                useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
            };
        }

        // Web / 桌面回退：用 setInterval 自检到期。
        const timer = window.setInterval(() => {
            if (Date.now() >= deadline) {
                window.clearInterval(timer);
                fireExpiryRef.current();
            }
        }, TICK_MS);

        return () => {
            window.clearInterval(timer);
            useSleepTimerStore.setState({ sleepTimerDeadlineMs: null });
        };
    }, [activationId, enabled, hours, minutes, mode, extensionMs, useNativeTimer]);
};
