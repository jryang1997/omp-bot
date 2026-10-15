// NotificationIntents.kt — 通知点击回应用哪个界面的哪些参数。
//
// PendingIntent 的相等性只看 request code 加 Intent.filterEquals 字段（action、data、
// 类型、包、组件、categories），**不含 extras**。所以身份放在 data URI 上：两条不同的
// 通知不会因为 botId/runId 只存在于 extras 而共用一个 PendingIntent。

package org.ompbot.companion.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.ompbot.companion.MainActivity
import org.ompbot.companion.platform.NavigationTarget

fun Intent.notificationTarget(): NavigationTarget = NavigationTarget(
    botId = getStringExtra(LocalNotificationPoster.EXTRA_BOT_ID),
    runId = getStringExtra(LocalNotificationPoster.EXTRA_RUN_ID),
)

object NotificationIntents {
    const val ACTION_OPEN = "org.ompbot.companion.OPEN_NOTIFICATION"

    /** (botId, runId) 的稳定身份串，不做哈希。 */
    fun contentIdentity(botId: String?, runId: String?): String =
        "ompbot://notification/${Uri.encode(botId.orEmpty())}/${Uri.encode(runId.orEmpty())}"

    fun contentUri(botId: String?, runId: String?): Uri = Uri.parse(contentIdentity(botId, runId))

    fun contentIntent(context: Context, spec: NotificationSpec): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            data = contentUri(spec.botId, spec.runId)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(LocalNotificationPoster.EXTRA_BOT_ID, spec.botId)
            putExtra(LocalNotificationPoster.EXTRA_RUN_ID, spec.runId)
        }

    fun pendingIntent(context: Context, spec: NotificationSpec): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            contentIntent(context, spec),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
