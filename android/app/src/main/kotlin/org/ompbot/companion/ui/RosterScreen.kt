
package org.ompbot.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.core.Bot
import org.ompbot.companion.core.ConnectionStatus
import org.ompbot.companion.platform.CompanionPermissions
import kotlinx.coroutines.launch

@Composable
fun RosterScreen(
    app: OmpBotApp,
    status: ConnectionStatus,
    onOpenChat: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenApprovals: () -> Unit,
) {
    val session = app.session
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val bots by session.state.bots.collectAsStateWithLifecycle()
    val runs by session.state.runs.collectAsStateWithLifecycle()
    val approvals by session.state.approvals.collectAsStateWithLifecycle()
    val connection by session.connection.collectAsStateWithLifecycle()
    var error by remember { mutableStateOf<String?>(null) }
    var notificationsEnabled by remember { mutableStateOf(CompanionPermissions.hasNotifications(context)) }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        notificationsEnabled = CompanionPermissions.hasNotifications(context)
    }

    LaunchedEffect(status) {
        if (status is ConnectionStatus.Live) {
            error = runCatching { session.refreshApprovals() }.exceptionOrNull()?.message
        }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        ScreenHeader(
            title = "我的 Bot",
            subtitle = connection?.displayName ?: "还没有连接",
            actions = {
                val pending = approvals.values.count { it.isPending }
                if (pending > 0) {
                    TextButton(onClick = onOpenApprovals) { Text("审批 $pending") }
                }
                TextButton(onClick = onOpenSettings) { Text("设置") }
            },
        )

        StatusStrip(status = status, onRetry = { session.connect() })

        if (!notificationsEnabled && CompanionPermissions.needsNotificationPermission()) {
            NoticeBar("开启通知后，应用在后台（或开着常驻连接）时也能收到审批与任务提醒。")
            Row(modifier = Modifier.padding(horizontal = Sizes.gutter)) {
                Button(onClick = { permissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS) }) {
                    Text("允许通知")
                }
            }
        }

        error?.let { NoticeBar(text = it, tone = MaterialTheme.colorScheme.error) }

        if (bots.isEmpty()) {
            EmptyState(
                title = "还没有可用的 Bot",
                description = "电脑端生成配对码时勾选了哪些 Bot，这里面就只会出现哪些。也可以在设置里重新配对。",
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Sizes.gutter, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(Sizes.cardGap),
            ) {
                items(bots, key = { it.id }) { bot ->
                    val botRuns = runs.values.filter { it.botId == bot.id && it.isActive }
                    val botApprovals = approvals.values.count { it.botId == bot.id && it.isPending }
                    BotCard(
                        bot = bot,
                        activeRuns = botRuns.size,
                        activeLabel = botRuns.firstOrNull()?.stateLabel,
                        pendingApprovals = botApprovals,
                        onClick = { onOpenChat(bot.id) },
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusStrip(status: ConnectionStatus, onRetry: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Sizes.gutter, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusPill(status)
        val detail = when (status) {
            is ConnectionStatus.Offline -> status.reason
            is ConnectionStatus.Unauthorized -> status.reason
            is ConnectionStatus.Connecting -> status.address
            else -> ""
        }
        if (detail.isNotBlank()) {
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
        } else {
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
        }
        if (status is ConnectionStatus.Offline) {
            TextButton(onClick = onRetry) { Text("重试") }
        }
    }
}

@Composable
private fun BotCard(
    bot: Bot,
    activeRuns: Int,
    activeLabel: String?,
    pendingApprovals: Int,
    onClick: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(bot.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                if (bot.isMain) Text("主", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                if (pendingApprovals > 0) {
                    Text("待审批 $pendingApprovals", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                } else if (activeRuns > 0) {
                    Text(activeLabel ?: "执行中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            if (bot.role.isNotBlank()) {
                Text(bot.role, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            bot.model?.takeIf { it.isNotBlank() }?.let {
                Text("模型 $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
