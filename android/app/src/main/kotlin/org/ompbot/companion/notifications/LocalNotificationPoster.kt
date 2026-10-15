// LocalNotificationPoster.kt — 通知的 Android 侧胶水（通道、权限、去重、撤销）。
//
// 没有推送服务，也没有假装的推送：这里的每一条通知都由正在连接的事件流触发。
// 用户关掉常驻连接时，界面会如实说明「提醒只在应用连着的时候有效」。

package org.ompbot.companion.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import org.ompbot.companion.R
import org.ompbot.companion.core.SessionNotice
import org.ompbot.companion.platform.CompanionPermissions

class LocalNotificationPoster(private val context: Context) {
    private val manager: NotificationManager? get() = context.getSystemService()

    fun post(notice: SessionNotice, canApprove: Boolean, botName: String? = null) {
        if (notice is SessionNotice.ApprovalSettled) {
            cancelApproval(notice.approvalId)
            return
        }
        val spec = NotificationPolicy.spec(notice, canApprove, botName) ?: return
        if (!mayPost()) return
        ensureChannels()
        val notification = NotificationCompat.Builder(context, spec.channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(spec.title)
            .setContentText(NotificationPolicy.redact(spec.text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(NotificationPolicy.redact(spec.text)))
            .setContentIntent(NotificationIntents.pendingIntent(context, spec))
            .setAutoCancel(true)
            .setCategory(
                if (spec.channelId == NotificationPolicy.CHANNEL_APPROVAL) {
                    NotificationCompat.CATEGORY_REMINDER
                } else {
                    NotificationCompat.CATEGORY_STATUS
                },
            )
            .setPriority(
                if (spec.channelId == NotificationPolicy.CHANNEL_APPROVAL) {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .build()
        runCatching { manager?.notify(spec.dedupeId, RUN_NOTIFICATION_ID, notification) }
    }

    /** 审批已经应答/过期：把那条通知撤掉，别留一个点开会说不清的提醒。 */
    fun cancelApproval(approvalId: String) {
        runCatching { manager?.cancel(NotificationPolicy.approvalDedupeId(approvalId), RUN_NOTIFICATION_ID) }
    }

    fun cancelAllRunNotifications() {
        runCatching { manager?.cancelAll() }
    }

    private fun mayPost(): Boolean = manager != null && CompanionPermissions.hasNotifications(context)

    private fun ensureChannels() {
        val manager = manager ?: return
        val channels = listOf(
            NotificationChannel(
                NotificationPolicy.CHANNEL_APPROVAL,
                context.getString(R.string.notification_channel_approval),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.notification_channel_approval_desc) },
            NotificationChannel(
                NotificationPolicy.CHANNEL_RUNS,
                context.getString(R.string.notification_channel_runs),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.notification_channel_runs_desc) },
        )
        manager.createNotificationChannels(channels)
    }

    companion object {
        // 通知的 tag 承担去重，这个 id 只是通道内的编号，故意固定。
        const val RUN_NOTIFICATION_ID = 7

        const val EXTRA_BOT_ID = "org.ompbot.companion.extra.BOT_ID"
        const val EXTRA_RUN_ID = "org.ompbot.companion.extra.RUN_ID"

        fun ensureAlwaysOnChannel(context: Context, manager: NotificationManager) {
            val channel = NotificationChannel(
                NotificationPolicy.CHANNEL_ALWAYS_ON,
                context.getString(R.string.notification_channel_always_on),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.notification_channel_always_on_desc)
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
