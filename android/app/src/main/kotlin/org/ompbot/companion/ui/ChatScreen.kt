// ChatScreen.kt — 与单个 Bot 的私聊：历史、实时进度、派活/补充/停止、审批、附件。
//
// 一条运行有两种文字来源，都保留：服务端落库的聊天历史（权威，重新打开还在）与
// 事件流里的原生帧（实时，看得见过程）。运行结束时手机重新拉一次历史，所以流里的
// 文字不会变成第二份真相。
//
// 派活按钮是唯一的写入口：没有活跃回合时 POST /api/runs（一次，不自动重发），
// 有活跃回合时按用户的选择发 steer 或 follow_up —— 两种语义不同，界面也不合并成
// 一个「发送」。

package org.ompbot.companion.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.core.Approval
import org.ompbot.companion.core.Attachment
import org.ompbot.companion.core.ChatMessage
import org.ompbot.companion.core.ConnectionStatus
import org.ompbot.companion.core.Run
import org.ompbot.companion.core.RunView
import org.ompbot.companion.core.RunStream
import org.ompbot.companion.core.StreamPart
import org.ompbot.companion.core.formatBytes
import org.ompbot.companion.core.formatClock
import org.ompbot.companion.platform.AttachmentPicker
import org.ompbot.companion.platform.PickResult
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(
    app: OmpBotApp,
    botId: String,
    onBack: () -> Unit,
    onOpenFiles: () -> Unit,
) {
    val session = app.session
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val bots by session.state.bots.collectAsStateWithLifecycle()
    val messages by session.state.messages.collectAsStateWithLifecycle()
    val runs by session.state.runs.collectAsStateWithLifecycle()
    val streams by session.state.streams.collectAsStateWithLifecycle()
    val approvals by session.state.approvals.collectAsStateWithLifecycle()
    val artifacts by session.state.artifacts.collectAsStateWithLifecycle()
    val connection by session.connection.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()

    val bot = bots.firstOrNull { it.id == botId }
    val canRun = connection?.device?.canRun == true
    val canApprove = connection?.device?.canApprove == true

    var draft by rememberSaveable(botId) { mutableStateOf("") }
    var pending by remember(botId) { mutableStateOf<List<Attachment>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val history = messages[botId].orEmpty()
    val views = runs.values.filter { it.botId == botId && it.kind != "delegation" }
        .sortedByDescending { it.createdAt }
        .map { run -> RunView(run, streams[run.id] ?: RunStream(), approvals.values.filter { it.runId == run.id && it.isPending }) }
    val activeRun = views.firstOrNull { it.run.isActive }?.run
    val pendingApprovals = approvals.values.filter { it.botId == botId && it.isPending }.sortedBy { it.createdAt }
    val looseApprovals = pendingApprovals.filter { approval -> views.none { view -> view.run.id == approval.runId } }

    LaunchedEffect(botId, status) {
        if (status is ConnectionStatus.Live) {
            runCatching { session.loadHistory(botId) }
        }
    }

    val documentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val picked = AttachmentPicker.read(context, uri)) {
                is PickResult.Ready -> upload(session, botId, picked, onError = { error = it }) { attachment ->
                    pending = pending + attachment
                }
                is PickResult.Rejected -> error = picked.message
            }
        }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val picked = AttachmentPicker.read(context, uri)) {
                is PickResult.Ready -> upload(session, botId, picked, onError = { error = it }) { attachment ->
                    pending = pending + attachment
                }
                is PickResult.Rejected -> error = picked.message
            }
        }
    }

    Column(modifier = Modifier.fillMaxWidth().imePadding()) {
        ScreenHeader(
            title = bot?.name ?: "对话",
            subtitle = bot?.role?.takeIf { it.isNotBlank() } ?: "私有会话",
            onBack = onBack,
            actions = { TextButton(onClick = onOpenFiles) { Text("文件") } },
        )
        StatusPillRow(status = status, onRetry = { session.connect() })

        error?.let {
            NoticeBar(text = it, tone = MaterialTheme.colorScheme.error)
            Row(modifier = Modifier.padding(horizontal = Sizes.gutter)) {
                TextButton(onClick = { error = null }) { Text("知道了") }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(horizontal = Sizes.gutter, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (history.isEmpty() && views.isEmpty()) {
                item { EmptyState("还没有对话", "在下面输入任务，Bot 会在这台电脑上执行，进度与结果都回到这里。") }
            }

            items(history, key = { "msg-${it.at}-${it.text.hashCode()}" }) { message ->
                MessageBubble(message)
            }

            items(views, key = { "run-${it.run.id}" }) { view ->
                RunBlock(
                    view = view,
                    canApprove = canApprove,
                    artifacts = artifacts.values.filter { it.runId == view.run.id }.toList(),
                    onAnswer = { approval, answer ->
                        scope.launch {
                            runCatching { session.respondApproval(approval.id, answer) }
                                .onFailure { error = it.message }
                        }
                    },
                    onOpenFiles = onOpenFiles,
                    onCancel = {
                        scope.launch {
                            runCatching { session.cancelRun(view.run.id) }.onFailure { error = it.message }
                        }
                    },
                )
            }

            items(looseApprovals, key = { "approval-${it.id}" }) { approval ->
                ApprovalCard(
                    approval = approval,
                    canApprove = canApprove,
                    busy = false,
                    onSubmit = { answer ->
                        scope.launch {
                            runCatching { session.respondApproval(approval.id, answer) }.onFailure { error = it.message }
                        }
                    },
                )
            }
        }

        Composer(
            draft = draft,
            onDraftChange = { draft = it },
            attachments = pending,
            onRemoveAttachment = { attachment -> pending = pending.filterNot { it.id == attachment.id } },
            canRun = canRun,
            activeRun = activeRun,
            busy = busy,
            onPickDocument = { documentPicker.launch(AttachmentPicker.MIME_TYPES) },
            onPickImage = { imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            onSend = { behavior ->
                val text = draft.trim()
                if (text.isEmpty() && (activeRun != null || pending.isEmpty())) return@Composer
                busy = true
                scope.launch {
                    val result = runCatching {
                        if (activeRun != null) {
                            session.steerRun(activeRun.id, text, behavior)
                        } else {
                            session.startRun(botId, text, pending.map { it.id })
                        }
                    }
                    result.onSuccess {
                        draft = ""
                        if (activeRun == null) pending = emptyList()
                        error = null
                    }.onFailure { failure ->
                        // 派活不自动重发：报错让用户决定，避免出现第二个任务。
                        error = failure.message ?: "发送失败"
                    }
                    busy = false
                }
            },
        )
    }
}

@Composable
private fun StatusPillRow(status: ConnectionStatus, onRetry: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Sizes.gutter, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusPill(status)
        val detail = when (status) {
            is ConnectionStatus.Offline -> status.reason
            is ConnectionStatus.Unauthorized -> status.reason
            else -> "提醒只在连接期间有效"
        }
        Text(
            detail,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 2,
        )
        if (status is ConnectionStatus.Offline) TextButton(onClick = onRetry) { Text("重连") }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.isUser
    val background = if (isUser) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
    } else {
        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
    }
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = if (isUser) Alignment.End else Alignment.Start) {
        Column(
            modifier = Modifier
                .fillMaxWidth(if (isUser) 0.88f else 0.94f)
                .background(background, RoundedCornerShape(Sizes.corner))
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = message.displayName,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(message.text, style = MaterialTheme.typography.bodyMedium)
            Text(formatClock(message.at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun RunBlock(
    view: RunView,
    canApprove: Boolean,
    artifacts: List<org.ompbot.companion.core.Artifact>,
    onAnswer: (Approval, org.ompbot.companion.core.ApprovalAnswer) -> Unit,
    onOpenFiles: () -> Unit,
    onCancel: () -> Unit,
) {
    val run = view.run
    var toolsExpanded by remember(run.id) { mutableStateOf(false) }
    val stream = view.stream
    val finalReply = run.reply?.takeIf { run.isTerminal && it.isNotBlank() }

    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        run.text.takeIf { it.isNotBlank() }?.let { request ->
            Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth(0.88f)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.14f), RoundedCornerShape(Sizes.corner))
                        .padding(10.dp),
                ) {
                    Text("你", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(request, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(run.stateLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            run.error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, maxLines = 2) }
            if (run.isActive) {
                TextButton(onClick = onCancel) { Text("停止") }
            }
        }

        stream.parts.forEach { part ->
            when (part) {
                is StreamPart.Text -> if (finalReply == null) RunTextBubble(part.text)
                is StreamPart.Thinking -> ThinkingBlock(part.text)
                is StreamPart.Note -> if (part.text.isNotBlank()) NoticeBar(part.text)
            }
        }

        stream.goal?.takeIf { it.isNotBlank() }?.let { goal ->
            NoticeBar("目标：$goal")
        }

        if (stream.todos.isNotEmpty()) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("任务清单", style = MaterialTheme.typography.labelMedium)
                    stream.todos.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
            }
        }

        if (stream.tools.isNotEmpty()) {
            TextButton(onClick = { toolsExpanded = !toolsExpanded }) {
                Text(if (toolsExpanded) "收起工具步骤（${stream.tools.size}）" else "展开工具步骤（${stream.tools.size}）")
            }
            if (toolsExpanded) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        stream.tools.forEach { tool ->
                            val state = when {
                                tool.isError -> "失败"
                                tool.phase == "end" -> "完成"
                                else -> "进行中"
                            }
                            Column {
                                Text("${tool.name.ifBlank { "工具" }} · $state", style = MaterialTheme.typography.bodySmall)
                                tool.detail?.takeIf { it.isNotBlank() }?.let {
                                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 6)
                                }
                            }
                        }
                    }
                }
            }
        }

        stream.children.forEach { child ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "${child.label} ${child.status ?: "进行中"}",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                    )
                    child.detail?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 4)
                    }
                }
            }
        }

        finalReply?.let { RunTextBubble(it) }

        artifacts.forEach { artifact ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("成果：${artifact.name}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onOpenFiles) { Text("打开") }
            }
        }

        view.approvals.forEach { approval ->
            ApprovalCard(
                approval = approval,
                canApprove = canApprove,
                busy = false,
                onSubmit = { answer -> onAnswer(approval, answer) },
            )
        }
    }
}

@Composable
private fun RunTextBubble(text: String) {
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.94f)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(Sizes.corner))
                .padding(10.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ThinkingBlock(text: String) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth()) {
        TextButton(onClick = { expanded = !expanded }) {
            Text(if (expanded) "收起思考过程" else "思考过程")
        }
        if (expanded) {
            Text(
                text,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    attachments: List<Attachment>,
    onRemoveAttachment: (Attachment) -> Unit,
    canRun: Boolean,
    activeRun: Run?,
    busy: Boolean,
    onPickDocument: () -> Unit,
    onPickImage: () -> Unit,
    onSend: (String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = Sizes.gutter, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (attachments.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                attachments.forEach { attachment ->
                    TextButton(onClick = { onRemoveAttachment(attachment) }) {
                        Text("${attachment.filename} · ${formatBytes(attachment.size)} ✕")
                    }
                }
            }
            if (activeRun != null) {
                Text("附件保留给下一次派活，补充指令只发送文字。", style = MaterialTheme.typography.labelSmall)
            }
        }
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = canRun,
            label = { Text(if (activeRun != null) "补充指令" else "派个活") },
            maxLines = 4,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onPickDocument, enabled = canRun && !busy && activeRun == null) { Text("文件") }
            TextButton(onClick = onPickImage, enabled = canRun && !busy && activeRun == null) { Text("图片") }
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            if (activeRun != null) {
                TextButton(onClick = { onSend(FOLLOW_UP) }, enabled = canRun && !busy) { Text("追加任务") }
                Button(onClick = { onSend(STEER) }, enabled = canRun && !busy) { Text("补充") }
            } else {
                Button(onClick = { onSend(STEER) }, enabled = canRun && !busy) { Text("派活") }
            }
        }
        if (!canRun) {
            Text(
                "这个设备没有派活权限（配对时未勾选 run），只能看历史与结果。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private const val STEER = "steer"
private const val FOLLOW_UP = "follow_up"

private suspend fun upload(
    session: org.ompbot.companion.core.CompanionSession,
    botId: String,
    picked: PickResult.Ready,
    onError: (String) -> Unit,
    onUploaded: (Attachment) -> Unit,
) {
    runCatching { session.uploadAttachment(botId, picked.file.filename, picked.file.mime, picked.file.bytes) }
        .onSuccess(onUploaded)
        .onFailure { onError(it.message ?: "上传失败") }
}
