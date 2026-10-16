import type { CommandPaletteSurface } from './types';
import type { SleepTimerMode } from '../../../stores/useSleepTimerStore';
import { describeSleepTimerQuery, parseSleepTimerQuery } from '../sleepTimerQuery';

// src/components/command-palette/surfaces/sleepTimerSurface.ts

export const sleepTimerSurface: CommandPaletteSurface = {
    load: () => import('./SleepTimerSurfaceView'),
    useLiveQuery: true,
    mapProps: ({ context, query, setQuery, isDaylight, theme }) => {
        const configuredTotalMinutes = context.settings.sleepTimerHours * 60 + context.settings.sleepTimerMinutes;
        const queryResult = query.trim()
            ? parseSleepTimerQuery(query, configuredTotalMinutes)
            : null;
        const previewTotalMinutes = queryResult?.ok && queryResult.action === 'enable'
            ? queryResult.totalMinutes
            : null;
        return {
            isDaylight,
            theme,
            enabled: context.settings.sleepTimerEnabled,
            hours: previewTotalMinutes === null
                ? context.settings.sleepTimerHours
                : Math.floor(previewTotalMinutes / 60),
            minutes: previewTotalMinutes === null
                ? context.settings.sleepTimerMinutes
                : previewTotalMinutes % 60,
            mode: context.settings.sleepTimerMode,
            deadlineMs: context.settings.sleepTimerDeadlineMs,
            currentTrackName: context.shared.currentSong?.name ?? null,
            queryFeedback: queryResult
                ? describeSleepTimerQuery(queryResult, context.shared.t)
                : null,
            onEnabledChange: (enabled: boolean) => {
                if (enabled && previewTotalMinutes !== null) {
                    context.settings.setSleepTimerHours(Math.floor(previewTotalMinutes / 60));
                    context.settings.setSleepTimerMinutes(previewTotalMinutes % 60);
                }
                setQuery('');
                context.settings.setSleepTimerEnabled(enabled);
            },
            onHoursChange: (hours: number) => {
                setQuery('');
                context.settings.setSleepTimerHours(hours);
            },
            onMinutesChange: (minutes: number) => {
                setQuery('');
                context.settings.setSleepTimerMinutes(minutes);
            },
            onModeChange: (nextMode: SleepTimerMode) => {
                setQuery('');
                context.settings.setSleepTimerMode(nextMode);
            },
            onPresetSelect: (totalMinutes: number) => {
                setQuery('');
                context.settings.setSleepTimerHours(Math.floor(totalMinutes / 60));
                context.settings.setSleepTimerMinutes(totalMinutes % 60);
                // 每次选择预设都重新开启一个全新倒计时（即使时长没变）。
                context.settings.setSleepTimerEnabled(true);
            },
            onExtend: (extraMinutes: number) => {
                setQuery('');
                context.settings.setSleepTimerExtend(extraMinutes);
            },
        };
    },
};
