// AlwaysOnConnectionService.kt — 用户打开的「常驻连接」。
//
// 这是 25 秒宽限窗口的常驻对应物：用一个真的前台服务把进程保持在 cached 类之外，
// 这样应用完全退到后台之后到达的审批/完成事件仍然能变成通知。
//
// 它**只**做这件事：不接管模型、不缓存任务、不重放请求。设备连接仍然是
// [org.ompbot.companion.core.CompanionSession] 那一条。
//
// 常驻通知是这个能力的代价，不是需要藏起来的瑕疵。stopWithTask="false"（见清单）
// 是重点：它就该在用户划掉应用之后继续活着。START_STICKY：即便系统还是回收了它，
// 重建时用 null Intent 再跑一遍同样的 setup —— connect() 是幂等的。

package org.ompbot.companion.lifecycle

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.R
import org.ompbot.companion.notifications.LocalNotificationPoster
import org.ompbot.companion.notifications.NotificationPolicy

class AlwaysOnConnectionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService<NotificationManager>()?.let { LocalNotificationPoster.ensureAlwaysOnChannel(this, it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (error: RuntimeException) {
            AlwaysOnConnectionState.reportFailure(error)
            stopSelf()
            return START_NOT_STICKY
        }
        AlwaysOnConnectionState.reportFailure(null)
        AlwaysOnConnectionState.active = true
        val app = application as OmpBotApp
        // 关掉「开关刚打开、应用已经退到后台」的竞态：控制器可能已经开了自己的 25 秒
        // 窗口，那个计时器会把服务正要依赖的连接断掉。
        app.linger.onAlwaysOnStarted()
        app.session.connect()
        return START_STICKY
    }

    override fun onDestroy() {
        AlwaysOnConnectionState.active = false
        super.onDestroy()
    }

    private fun buildNotification() = NotificationCompat.Builder(this, NotificationPolicy.CHANNEL_ALWAYS_ON)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(getString(R.string.always_on_title))
        .setContentText(getString(R.string.always_on_text))
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .build()

    companion object {
        const val NOTIFICATION_ID = 1

        /** 幂等：已经在跑时再调一次是安全的。 */
        fun start(context: Context) {
            AlwaysOnConnectionState.reportFailure(null)
            try {
                ContextCompat.startForegroundService(context, Intent(context, AlwaysOnConnectionService::class.java))
            } catch (error: RuntimeException) {
                AlwaysOnConnectionState.reportFailure(error)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AlwaysOnConnectionService::class.java))
        }
    }
}
