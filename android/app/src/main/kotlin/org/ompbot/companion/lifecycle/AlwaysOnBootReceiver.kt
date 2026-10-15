// AlwaysOnBootReceiver.kt — 重启后按用户的选择拉起常驻连接。
//
// Android 不会自己把前台服务带过重启：没有这个接收器，「常驻连接」每次重启都会静默失效，
// 直到用户下次打开应用才发现。开关关着时什么都不做。

package org.ompbot.companion.lifecycle

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.ompbot.companion.storage.AlwaysOnPreferences

class AlwaysOnBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (AlwaysOnPreferences(context).enabled) {
            AlwaysOnConnectionService.start(context)
        }
    }
}
