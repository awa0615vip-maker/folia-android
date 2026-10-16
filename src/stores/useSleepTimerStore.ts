// src/stores/useSleepTimerStore.ts
// The sleep timer: the configured duration plus the armed deadline.
//
// Split out of useSettingsUiStore. The deadline and activation id are runtime state rather than
// settings, which is precisely why they no longer sit in the settings snapshot.

import { create } from 'zustand';
import i18n from '../i18n/config';
import { setStatusMessage } from './useStatusMessageStore';

export const SLEEP_TIMER_HOURS_STORAGE_KEY = 'sleep_timer_hours';

export const SLEEP_TIMER_MINUTES_STORAGE_KEY = 'sleep_timer_minutes';

const readStoredSleepTimerPart = (key: string, max: number): number => {
    if (typeof window === 'undefined') {
        return 0;
    }

    const saved = Number(localStorage.getItem(key));
    return Number.isInteger(saved) && saved >= 0 && saved <= max ? saved : 0;
};

const readStoredSleepTimerHours = () => readStoredSleepTimerPart(SLEEP_TIMER_HOURS_STORAGE_KEY, 999);

const readStoredSleepTimerMinutes = () => readStoredSleepTimerPart(SLEEP_TIMER_MINUTES_STORAGE_KEY, 59);

export type SleepTimerMode = 'duration' | 'trackEnd';

export type SleepTimerState = {
    sleepTimerEnabled: boolean;
    sleepTimerHours: number;
    sleepTimerMinutes: number;
    sleepTimerDeadlineMs: number | null;
    sleepTimerActivationId: number;
    /** 暂停方式：duration＝倒计时到点暂停；trackEnd＝当前这首播完后暂停。 */
    sleepTimerMode: SleepTimerMode;
    /** 运行时追加的时长（毫秒），来自「延长 N 分钟」，不写进持久化时长。 */
    sleepTimerExtensionMs: number;
    handleToggleSleepTimer: (enable: boolean) => void;
    handleSetSleepTimerHours: (hours: number) => void;
    handleSetSleepTimerMinutes: (minutes: number) => void;
    handleSetSleepTimerMode: (mode: SleepTimerMode) => void;
    /** 倒计时进行中再延长若干分钟（保留已走过的时间），并立即重新布防。 */
    handleExtendSleepTimer: (minutes: number) => void;
};

export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
    // A sleep timer is a one-shot action. Persist its preferred duration, never an armed state.
    sleepTimerEnabled: false,
    sleepTimerHours: readStoredSleepTimerHours(),
    sleepTimerMinutes: readStoredSleepTimerMinutes(),
    sleepTimerDeadlineMs: null,
    sleepTimerActivationId: 0,
    sleepTimerMode: 'duration',
    sleepTimerExtensionMs: 0,
    handleToggleSleepTimer: (enable) => {
        const needsDuration = get().sleepTimerMode === 'duration';
        if (enable && needsDuration && get().sleepTimerHours === 0 && get().sleepTimerMinutes === 0) {
            setStatusMessage({
                type: 'error',
                text: i18n.t('commandPalette.sleepTimerDurationRequired'),
            });
            return;
        }
        set(state => ({
            sleepTimerEnabled: enable,
            // 每次新的激活都清空上一次的「延长」，从设定时长重新开始。
            sleepTimerExtensionMs: enable ? 0 : state.sleepTimerExtensionMs,
            // Every explicit activation starts a fresh countdown, even when its duration is unchanged.
            sleepTimerActivationId: enable
                ? state.sleepTimerActivationId + 1
                : state.sleepTimerActivationId,
        }));
        setStatusMessage({
            type: 'info',
            text: i18n.t('notifications.' + (enable ? 'sleepTimerOn' : 'sleepTimerOff')),
        });
    },
    handleSetSleepTimerMode: (mode) => {
        set(state => ({
            sleepTimerMode: mode,
            // 切换模式后重新布防（已开启时），否则上一模式的倒计时/监听仍在跑。
            sleepTimerExtensionMs: 0,
            sleepTimerDeadlineMs: null,
            sleepTimerActivationId: state.sleepTimerEnabled
                ? state.sleepTimerActivationId + 1
                : state.sleepTimerActivationId,
        }));
    },
    handleExtendSleepTimer: (minutes) => {
        const extra = Math.floor(minutes) * 60 * 1000;
        if (!(extra > 0)) return;
        set(state => ({
            // 延长即重新布防：在当前剩余基础上再追加时长。
            sleepTimerExtensionMs: state.sleepTimerExtensionMs + extra,
            sleepTimerActivationId: state.sleepTimerActivationId + 1,
            sleepTimerEnabled: true,
        }));
        setStatusMessage({
            type: 'info',
            text: i18n.t('commandPalette.sleepTimerExtended', { minutes }),
        });
    },
    handleSetSleepTimerHours: (hours) => {
        const clamped = Math.min(999, Math.max(0, Math.floor(hours) || 0));
        if (typeof window !== 'undefined') {
            localStorage.setItem(SLEEP_TIMER_HOURS_STORAGE_KEY, String(clamped));
        }
        set(state => ({
            sleepTimerHours: clamped,
            sleepTimerEnabled: clamped === 0 && state.sleepTimerMinutes === 0
                ? false
                : state.sleepTimerEnabled,
        }));
    },
    handleSetSleepTimerMinutes: (minutes) => {
        const clamped = Math.min(59, Math.max(0, Math.floor(minutes) || 0));
        if (typeof window !== 'undefined') {
            localStorage.setItem(SLEEP_TIMER_MINUTES_STORAGE_KEY, String(clamped));
        }
        set(state => ({
            sleepTimerMinutes: clamped,
            sleepTimerEnabled: state.sleepTimerHours === 0 && clamped === 0
                ? false
                : state.sleepTimerEnabled,
        }));
    },
}));

/**
 * The SleepTimer half of the former settings snapshot, for the surfaces that
 * legitimately edit this whole domain at once. Ordinary consumers select one field instead.
 */
export const selectSleepTimerSnapshot = (state: SleepTimerState) => ({
    sleepTimerEnabled: state.sleepTimerEnabled,
    sleepTimerHours: state.sleepTimerHours,
    sleepTimerMinutes: state.sleepTimerMinutes,
    sleepTimerDeadlineMs: state.sleepTimerDeadlineMs,
    sleepTimerActivationId: state.sleepTimerActivationId,
    sleepTimerMode: state.sleepTimerMode,
    sleepTimerExtensionMs: state.sleepTimerExtensionMs,
    handleToggleSleepTimer: state.handleToggleSleepTimer,
    handleSetSleepTimerHours: state.handleSetSleepTimerHours,
    handleSetSleepTimerMinutes: state.handleSetSleepTimerMinutes,
    handleSetSleepTimerMode: state.handleSetSleepTimerMode,
    handleExtendSleepTimer: state.handleExtendSleepTimer,
});
