// MainActivity.kt — 唯一的界面宿主。
//
// 一个 Activity、一个 Compose 树：状态全部来自 [OmpBotApp].session，界面不自己发
// 网络请求。通知点击与深链都只往 [PendingNavigation] 放一个意图，由这里消费掉。

package org.ompbot.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import org.ompbot.companion.core.PairingLinks
import org.ompbot.companion.notifications.NotificationIntents
import org.ompbot.companion.notifications.notificationTarget
import org.ompbot.companion.platform.PendingNavigation
import org.ompbot.companion.ui.CompanionTheme
import org.ompbot.companion.ui.RootScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as OmpBotApp
        setContent {
            CompanionTheme {
                RootScreen(app = app)
            }
        }
        consume(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consume(intent)
    }

    private fun consume(intent: Intent?) {
        if (intent == null) return
        if (intent.action == NotificationIntents.ACTION_OPEN) {
            val target = intent.notificationTarget()
            if (target.botId != null || target.runId != null) PendingNavigation.postTarget(target)
            return
        }
        val data = intent.data?.toString() ?: return
        if (data.startsWith("${PairingLinks.SCHEME}://")) {
            PendingNavigation.postInvite(PairingLinks.parse(data))
        }
    }
}
