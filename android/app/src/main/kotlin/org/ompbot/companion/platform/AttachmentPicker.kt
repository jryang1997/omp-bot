// AttachmentPicker.kt — 从系统选择器拿到文件并读成字节。
//
// 用户选的是「文档」，不是权限：走 SAF 的 OpenDocument（图片走图片选择器），拿到的是
// 一个 content:// URI，读之前先按 [AttachmentGuard] 校验，不合格就在这里说清楚，
// 不把 12 MiB 传上去再收一个 400。

package org.ompbot.companion.platform

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.ompbot.companion.core.AttachmentCheck
import org.ompbot.companion.core.AttachmentGuard
import org.ompbot.companion.core.readBoundedBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class PickedFile(val filename: String, val mime: String, val bytes: ByteArray) {
    val size: Long get() = bytes.size.toLong()
}

sealed interface PickResult {
    data class Ready(val file: PickedFile) : PickResult
    data class Rejected(val message: String) : PickResult
}

object AttachmentPicker {
    /** 图片选择器与文档选择器都用同一套类型过滤，避免选到服务端不收的东西。 */
    val MIME_TYPES: Array<String> = AttachmentGuard.PICKER_MIME_TYPES

    suspend fun read(context: Context, uri: Uri): PickResult = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val (name, declaredMime, size) = describe(resolver, uri)
        if (size != null && size > AttachmentGuard.MAX_BYTES) {
            return@withContext PickResult.Rejected("文件超过上限 ${AttachmentGuard.MAX_BYTES / (1024 * 1024)} MB")
        }
        val bytes = try {
            resolver.openInputStream(uri)?.use { it.readBoundedBytes(AttachmentGuard.MAX_BYTES) }
        } catch (error: Exception) {
            null
        } ?: return@withContext PickResult.Rejected("读不到这个文件（可能已被移动或没有权限）")
        if (bytes.size > AttachmentGuard.MAX_BYTES) {
            return@withContext PickResult.Rejected("文件超过上限 ${AttachmentGuard.MAX_BYTES / (1024 * 1024)} MB")
        }
        return@withContext when (val check = AttachmentGuard.check(name, declaredMime, bytes)) {
            is AttachmentCheck.Ok -> PickResult.Ready(PickedFile(check.filename, check.mime, bytes))
            is AttachmentCheck.Rejected -> PickResult.Rejected(check.message)
        }
    }

    private fun describe(resolver: ContentResolver, uri: Uri): Triple<String, String?, Long?> {
        val mime = resolver.getType(uri)
        val metadata = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null
                val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex).takeIf { it >= 0 } else null
                name to size
            }
        }.getOrNull()
        return Triple(metadata?.first ?: uri.lastPathSegment ?: "附件", mime, metadata?.second)
    }
}
