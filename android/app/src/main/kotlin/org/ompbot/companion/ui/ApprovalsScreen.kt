// ApprovalsScreen.kt — 所有待办审批的一个地方。
//
// 审批只在连接期间才收得到（没有推送服务），所以这一页顶部如实写明当前连接状态：
// 离线时列表是「上次连上时看到的待办」，不是电脑的实时状态。

package org.ompbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import kotlinx.coroutines.launch

@Composable
fun ApprovalsScreen(app: OmpBotApp, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val session = app.session
    val scope = rememberCoroutineScope()
    val approvals by session.state.approvals.collectAsStateWithLifecycle()
    val bots by session.state.bots.collectAsStateWithLifecycle()
    val connection by session.connection.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    var error by remember { mutableStateOf<String?>(null) }
    val canApprove = connection?.device?.canApprove == true
    val pending = approvals.values.filter { it.isPending }.sortedBy { it.createdAt }

    Column(modifier = Modifier.fillMaxWidth()) {
        ScreenHeader(title = "待审批", subtitle = "来自原生执行的审批与提问", onBack = onBack)
        StatusPill(status)
        if (status !is org.ompbot.companion.core.ConnectionStatus.Live) {
            NoticeBar("当前没有连接，下面是上次收到的待办；电脑上的真实状态以重连后为准。")
        }
        error?.let { NoticeBar(text = it, tone = MaterialTheme.colorScheme.error) }

        if (pending.isEmpty()) {
            EmptyState("没有待处理的审批", "需要你决定的时候，这里和通知都会出现。")
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(pending, key = { it.id }) { approval ->
                    val botName = bots.firstOrNull { it.id == approval.botId }?.name
                    Column(modifier = Modifier.fillMaxWidth()) {
                        if (botName != null) {
                            TextButton(onClick = { onOpenChat(approval.botId) }) { Text(botName) }
                        }
                        ApprovalCard(
                            approval = approval,
                            canApprove = canApprove,
                            busy = false,
                            onSubmit = { answer ->
                                scope.launch {
                                    runCatching { session.respondApproval(approval.id, answer) }
                                        .onFailure { error = it.message }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}
