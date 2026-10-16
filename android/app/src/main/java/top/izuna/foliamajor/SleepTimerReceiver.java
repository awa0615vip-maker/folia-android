package top.izuna.foliamajor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 睡眠定时器（定时暂停）到期接收器。
 *
 * 由 {@link android.app.AlarmManager} 的精确闹钟在设定时间唤起，即使 App 切到后台、
 * 屏幕关闭或进入 Doze 也能触发。WebView 自带的 JavaScript setInterval 在页面不可见时
 * 会被系统节流，因此“到期暂停”这一动作必须放在原生层才可靠。
 */
public class SleepTimerReceiver extends BroadcastReceiver {
    public static final String ACTION_SLEEP_TIMER_FIRED = "top.izuna.foliamajor.SLEEP_TIMER_FIRED";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_SLEEP_TIMER_FIRED.equals(intent.getAction())) {
            return;
        }
        // 暂停播放并通知 Web 层复位定时器状态。
        FoliaNativePlugin.emitSleepTimerExpired();
    }
}
