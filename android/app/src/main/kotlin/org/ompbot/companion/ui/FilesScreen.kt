// FilesScreen.kt — 一个 Bot 的资料与成果：上传、预览、保存到 SAF、系统分享。
//
// 两条方向都是「原生带凭证的 HTTP」：
// - 上传：附件字节经设备 Bearer 送到电脑，落盘位置由服务端决定；
// - 取回：成果字节由手机下载后交给系统（另存为或分享），从不把带 token 的地址交给浏览器。

package org.ompbot.companion.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.core.Artifact
import org.ompbot.companion.core.Attachment
import org.ompbot.companion.core.formatBytes
import org.ompbot.companion.core.formatClock
import org.ompbot.companion.platform.ArtifactFiles
import org.ompbot.companion.platform.AttachmentPicker
import org.ompbot.companion.platform.PickResult
import org.ompbot.companion.platform.PreviewKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TEXT_PREVIEW_LIMIT = 256 * 1024

private sealed interface PreviewState {
    data class Loading(val title: String) : PreviewState
    data class Text(val title: String, val body: String) : PreviewState
    data class Image(val title: String, val bitmap: ImageBitmap) : PreviewState
    data class Failed(val title: String, val message: String) : PreviewState
}

@Composable
fun FilesScreen(app: OmpBotApp, botId: String, onBack: () -> Unit) {
    val session = app.session
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val attachments by session.state.attachments.collectAsStateWithLifecycle()
    val artifacts by session.state.artifacts.collectAsStateWithLifecycle()
    val connection by session.connection.collectAsStateWithLifecycle()
    val canRun = connection?.device?.canRun == true

    var showArtifacts by remember { mutableStateOf(true) }
    var preview by remember { mutableStateOf<PreviewState?>(null) }
    var pendingSave by remember { mutableStateOf<Artifact?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }

    val botAttachments = attachments.values.filter { it.botId == botId }.sortedByDescending { it.createdAt }
    val botArtifacts = artifacts.values.filter { it.botId == botId }.sortedByDescending { it.createdAt }

    // CreateDocument 的 mime 在构造时固定，所以用通配类型 + 真实文件名：
    // 扩展名足够让系统与接收方判断类型，用户仍可改名。
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val artifact = pendingSave
        pendingSave = null
        if (uri == null || artifact == null) return@rememberLauncherForActivityResult
        saved = false
        scope.launch {
            runCatching {
                val bytes = session.artifactBytes(artifact)
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                        ?: error("无法写入所选位置")
                }
                saved = true
            }.onFailure { error = it.message ?: "保存失败" }
        }
    }

    val documentPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val picked = AttachmentPicker.read(context, uri)) {
                is PickResult.Ready -> runCatching {
                    session.uploadAttachment(botId, picked.file.filename, picked.file.mime, picked.file.bytes)
                    session.loadAttachments(botId)
                }.onFailure { error = it.message ?: "上传失败" }
                is PickResult.Rejected -> error = picked.message
            }
        }
    }

    LaunchedEffect(botId) {
        runCatching {
            session.loadAttachments(botId)
            session.loadArtifacts(botId)
        }.onFailure { error = it.message }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        ScreenHeader(
            title = "资料与成果",
            subtitle = if (showArtifacts) "任务产出的文件" else "你上传的原始资料",
            onBack = onBack,
            actions = {
                TextButton(onClick = { showArtifacts = !showArtifacts }) {
                    Text(if (showArtifacts) "看资料" else "看成果")
                }
            },
        )

        if (saved) NoticeBar("已保存到手机")
        error?.let {
            NoticeBar(text = it, tone = MaterialTheme.colorScheme.error)
            Row(modifier = Modifier.padding(horizontal = Sizes.gutter)) {
                TextButton(onClick = { error = null }) { Text("知道了") }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Sizes.gutter, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(onClick = { documentPicker.launch(AttachmentPicker.MIME_TYPES) }, enabled = canRun) { Text("上传文件") }
        }
        if (!canRun) {
            NoticeBar("这个设备没有派活权限，上传与派活都不可用；成果仍然可以下载。")
        }

        if (showArtifacts) {
            if (botArtifacts.isEmpty()) {
                EmptyState("还没有成果", "任务跑完后产出的文件会出现在这里，可以保存到手机或分享出去。")
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = Sizes.gutter, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(Sizes.cardGap),
                ) {
                    items(botArtifacts, key = { it.id }) { artifact ->
                        FileCard(
                            title = artifact.name.ifBlank { artifact.id },
                            meta = listOf(artifact.mime, formatBytes(artifact.size), formatClock(artifact.createdAt))
                                .filter { it.isNotBlank() }
                                .joinToString(" · "),
                            onPreview = {
                                preview = PreviewState.Loading(artifact.name)
                                scope.launch {
                                    preview = loadArtifactPreview(session, artifact)
                                }
                            },
                            extra = {
                                TextButton(onClick = {
                                    pendingSave = artifact
                                    saveLauncher.launch(ArtifactFiles.defaultFileName(artifact))
                                }) { Text("保存到手机") }
                                TextButton(onClick = {
                                    scope.launch {
                                        runCatching {
                                            val bytes = session.artifactBytes(artifact)
                                            val uri = withContext(Dispatchers.IO) {
                                                ArtifactFiles.writeForSharing(context, ArtifactFiles.defaultFileName(artifact), bytes)
                                            }
                                            val mime = ArtifactFiles.mimeFor(artifact, null)
                                            context.startActivity(ArtifactFiles.shareIntent(uri, mime, artifact.name))
                                        }.onFailure { error = it.message ?: "分享失败" }
                                    }
                                }) { Text("分享") }
                            },
                        )
                    }
                }
            }
        } else {
            if (botAttachments.isEmpty()) {
                EmptyState("还没有资料", "上传文档或图片，派活时它们会作为原始资料交给 Bot。")
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = Sizes.gutter, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(Sizes.cardGap),
                ) {
                    items(botAttachments, key = { it.id }) { attachment ->
                        FileCard(
                            title = attachment.filename,
                            meta = listOf(attachment.mime, formatBytes(attachment.size), formatClock(attachment.createdAt))
                                .filter { it.isNotBlank() }
                                .joinToString(" · "),
                            onPreview = if (attachment.isImage) {
                                {
                                    preview = PreviewState.Loading(attachment.filename)
                                    scope.launch { preview = loadAttachmentPreview(session, attachment) }
                                }
                            } else {
                                null
                            },
                            extra = {},
                        )
                    }
                }
            }
        }
    }

    preview?.let { state ->
        AlertDialog(
            onDismissRequest = { preview = null },
            title = {
                Text(
                    when (state) {
                        is PreviewState.Loading -> state.title
                        is PreviewState.Text -> state.title
                        is PreviewState.Image -> state.title
                        is PreviewState.Failed -> state.title
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            text = {
                when (state) {
                    is PreviewState.Loading -> Text("正在取回…")
                    is PreviewState.Failed -> Text(state.message)
                    is PreviewState.Text -> Text(
                        state.body,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    )
                    is PreviewState.Image -> Image(
                        bitmap = state.bitmap,
                        contentDescription = state.title,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = { TextButton(onClick = { preview = null }) { Text("关闭") } },
        )
    }
}

@Composable
private fun FileCard(
    title: String,
    meta: String,
    onPreview: (() -> Unit)?,
    extra: @Composable () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2)
            Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (onPreview != null) TextButton(onClick = onPreview) { Text("预览") }
                extra()
            }
        }
    }
}

private suspend fun loadArtifactPreview(
    session: org.ompbot.companion.core.CompanionSession,
    artifact: Artifact,
): PreviewState {
    val kind = ArtifactFiles.previewKind(artifact.mime, artifact.previewType)
    if (kind == PreviewKind.NONE) {
        return PreviewState.Failed(artifact.name, "这种类型不能在这里预览，保存到手机后用合适的应用打开。")
    }
    return runCatching {
        val bytes = session.artifactBytes(artifact, preview = true)
        when (kind) {
            PreviewKind.IMAGE -> decodeImage(artifact.name, bytes)
            PreviewKind.TEXT -> PreviewState.Text(artifact.name, decodeText(bytes))
            PreviewKind.NONE -> PreviewState.Failed(artifact.name, "不支持预览")
        }
    }.getOrElse { PreviewState.Failed(artifact.name, it.message ?: "取回失败") }
}

private suspend fun loadAttachmentPreview(
    session: org.ompbot.companion.core.CompanionSession,
    attachment: Attachment,
): PreviewState = runCatching {
    decodeImage(attachment.filename, session.attachmentPreview(attachment))
}.getOrElse { PreviewState.Failed(attachment.filename, it.message ?: "取回失败") }

private fun decodeImage(title: String, bytes: ByteArray): PreviewState {
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        ?: return PreviewState.Failed(title, "这张图片没能解码")
    return PreviewState.Image(title, bitmap.asImageBitmap())
}

private fun decodeText(bytes: ByteArray): String {
    val trimmed = if (bytes.size > TEXT_PREVIEW_LIMIT) bytes.copyOf(TEXT_PREVIEW_LIMIT) else bytes
    val text = String(trimmed, Charsets.UTF_8)
    return if (bytes.size > TEXT_PREVIEW_LIMIT) "$text\n…（只显示前 ${TEXT_PREVIEW_LIMIT / 1024} KB）" else text
}
