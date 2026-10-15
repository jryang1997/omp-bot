// RootScreen.kt — 界面路由：未配对 → 配对流程，已配对 → 花名册/会话/文件/设置。
//
// 通知点击与深链在这里落地：深链把邀请交给配对界面（必须先确认目标再兑换），
// 通知点击直接打开对应 Bot 的会话。

package org.ompbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.platform.PendingNavigation

@Composable
fun RootScreen(app: OmpBotApp) {
    val session = app.session
    val status by session.status.collectAsStateWithLifecycle()
    val connection by session.connection.collectAsStateWithLifecycle()
    val invite by PendingNavigation.invite.collectAsStateWithLifecycle()
    val target by PendingNavigation.target.collectAsStateWithLifecycle()

    var route by rememberSaveable { mutableStateOf(ROUTE_ROSTER) }
    var routeBotId by rememberSaveable { mutableStateOf<String?>(null) }

    // 通知点击：直接进那个 Bot 的会话，然后消费掉这个意图（旋转重建不会再跳一次）。
    LaunchedEffect(target) {
        val pending = target ?: return@LaunchedEffect
        val botId = pending.botId
        if (botId != null && connection != null) {
            route = ROUTE_CHAT
            routeBotId = botId
        }
        PendingNavigation.clearTarget()
    }

    BackHandler(enabled = route != ROUTE_ROSTER) {
        route = ROUTE_ROSTER
        routeBotId = null
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
            val pendingInvite = invite
            if (connection == null || pendingInvite != null) {
                PairingScreen(
                    app = app,
                    incoming = pendingInvite,
                    onDismissIncoming = { PendingNavigation.clearInvite() },
                )
                return@Column
            }
            when (route) {
                ROUTE_CHAT -> ChatScreen(
                    app = app,
                    botId = routeBotId.orEmpty(),
                    onBack = {
                        route = ROUTE_ROSTER
                        routeBotId = null
                    },
                    onOpenFiles = { route = ROUTE_FILES },
                )
                ROUTE_FILES -> FilesScreen(
                    app = app,
                    botId = routeBotId.orEmpty(),
                    onBack = { route = ROUTE_CHAT },
                )
                ROUTE_SETTINGS -> SettingsScreen(
                    app = app,
                    onBack = { route = ROUTE_ROSTER },
                )
                ROUTE_APPROVALS -> ApprovalsScreen(
                    app = app,
                    onBack = { route = ROUTE_ROSTER },
                    onOpenChat = { botId ->
                        route = ROUTE_CHAT
                        routeBotId = botId
                    },
                )
                else -> RosterScreen(
                    app = app,
                    status = status,
                    onOpenChat = { botId ->
                        route = ROUTE_CHAT
                        routeBotId = botId
                    },
                    onOpenSettings = { route = ROUTE_SETTINGS },
                    onOpenApprovals = { route = ROUTE_APPROVALS },
                )
            }
        }
    }
}

private const val ROUTE_ROSTER = "roster"
private const val ROUTE_CHAT = "chat"
private const val ROUTE_FILES = "files"
private const val ROUTE_SETTINGS = "settings"
private const val ROUTE_APPROVALS = "approvals"
