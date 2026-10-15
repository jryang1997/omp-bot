// ArtifactFiles.kt — 成果落地：SAF 保存与系统分享。
//
// 两条路径都是「先用带凭证的客户端把字节下下来，再交给系统」：
// - 保存：SAF 的 CreateDocument，用户选位置，字节写进他选的 URI；
// - 分享：写进应用 cache 的 shared-artifacts 目录，用 FileProvider 给出只读 URI。
// 不做「把带 token 的 URL 交给浏览器」这件事。

package org.ompbot.companion.platform

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.ompbot.companion.core.Artifact
import java.io.File

object ArtifactFiles {
    private const val SHARE_DIR = "shared-artifacts"
    private const val AUTHORITY_SUFFIX = ".artifacts"

    /**
     * 落盘用的文件名：去路径、去控制字符、限长，并保证有扩展名（系统分享与另存为
     * 都靠扩展名决定「用什么打开」）。
     */
    fun sanitizeName(raw: String): String {
        val base = raw.replace('\\', '/').substringAfterLast('/')
        val clean = base.filter { it.code >= 32 && it.code != 127 && it !in "/\\" }.trim().trim('.', ' ')
        if (clean.isEmpty()) return "成果"
        return if (clean.length <= 100) clean else clean.take(90) + "." + clean.substringAfterLast('.', "bin")
    }

    fun defaultFileName(artifact: Artifact): String = sanitizeName(artifact.name.ifBlank { artifact.id })

    fun mimeFor(artifact: Artifact, contentType: String?): String =
        contentType?.substringBefore(';')?.trim().takeUnless { it.isNullOrEmpty() }
            ?: artifact.mime.takeUnless { it.isNullOrEmpty() }
            ?: "application/octet-stream"

    /** 每次分享前清空：磁盘上最多留最近导出的一份。 */
    fun writeForSharing(context: Context, name: String, bytes: ByteArray): Uri {
        val dir = File(context.cacheDir, SHARE_DIR)
        if (dir.exists()) dir.listFiles()?.forEach { it.delete() } else dir.mkdirs()
        val file = File(dir, sanitizeName(name))
        file.writeBytes(bytes)
        return FileProvider.getUriForFile(context, context.packageName + AUTHORITY_SUFFIX, file)
    }

    fun shareIntent(uri: Uri, mime: String, title: String): Intent {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, title)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, "分享 $title")
    }

    /** 预览只对看一眼就知道的类型开放；其他类型如实说「请保存后用别的应用打开」。 */
    fun previewKind(mime: String, previewType: String?): PreviewKind = when {
        previewType == "image" || mime.startsWith("image/") -> PreviewKind.IMAGE
        mime.startsWith("text/") || mime == "application/json" -> PreviewKind.TEXT
        else -> PreviewKind.NONE
    }
}

enum class PreviewKind { IMAGE, TEXT, NONE }
