// AttachmentGuard.kt — 上传前的本地校验。
//
// 与 src/features/attachments.mjs 同一套规则（魔数嗅探、mime 与扩展名自洽、12 MiB 上限），
// 目的是让手机在**上传前**就说清楚为什么不行，而不是把 12 MiB 传上去再收一个 400。
// 服务端仍然会再校验一次；这里不是信任边界，是体验边界。

package org.ompbot.companion.core

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets

sealed interface AttachmentCheck {
    data class Ok(val filename: String, val mime: String) : AttachmentCheck
    data class Rejected(val message: String) : AttachmentCheck
}

object AttachmentGuard {
    const val MAX_BYTES = 12 * 1024 * 1024

    /** 与服务端 MIME_EXT 同一张表。 */
    private val MIME_EXT = linkedMapOf(
        "image/png" to listOf(".png"),
        "image/jpeg" to listOf(".jpg", ".jpeg"),
        "image/gif" to listOf(".gif"),
        "image/webp" to listOf(".webp"),
        "application/pdf" to listOf(".pdf"),
        "text/plain" to listOf(".txt", ".log", ".md"),
        "text/markdown" to listOf(".md", ".markdown"),
        "text/csv" to listOf(".csv"),
        "application/json" to listOf(".json"),
        "application/zip" to listOf(".zip"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to listOf(".docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to listOf(".xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" to listOf(".pptx"),
    )

    private val TEXT_MIMES = setOf("text/plain", "text/markdown", "text/csv", "application/json")
    private val ZIP_CONTAINERS = setOf(
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )

    /** 可选的文件选择器 mime 过滤：只放服务端真的收的类型。 */
    val PICKER_MIME_TYPES: Array<String> = MIME_EXT.keys.toTypedArray()

    fun sniffMime(bytes: ByteArray): String? {
        if (bytes.size >= 8 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() &&
            bytes[2] == 'N'.code.toByte() && bytes[3] == 'G'.code.toByte()
        ) return "image/png"
        if (bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()) {
            return "image/jpeg"
        }
        if (bytes.size >= 6) {
            val header = String(bytes, 0, 6, StandardCharsets.ISO_8859_1)
            if (header == "GIF87a" || header == "GIF89a") return "image/gif"
        }
        if (bytes.size >= 12) {
            val riff = String(bytes, 0, 4, StandardCharsets.ISO_8859_1)
            val webp = String(bytes, 8, 4, StandardCharsets.ISO_8859_1)
            if (riff == "RIFF" && webp == "WEBP") return "image/webp"
        }
        if (bytes.size >= 5 && String(bytes, 0, 5, StandardCharsets.ISO_8859_1) == "%PDF-") return "application/pdf"
        if (bytes.size >= 4 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4B.toByte() &&
            bytes[2] == 0x03.toByte() && bytes[3] == 0x04.toByte()
        ) return "application/zip"
        return null
    }

    /** 文件名规范化：取基名、去控制字符、限长；空名给一个可读兜底。 */
    fun canonicalFilename(raw: String?, fallbackExt: String = ""): String {
        val base = raw.orEmpty().replace('\\', '/').substringAfterLast('/')
        val clean = base.filter { it.code >= 32 && it.code != 127 }.trim().trim('.', ' ')
        val safe = clean.ifEmpty { "附件${fallbackExt}" }
        return if (safe.length <= 120) safe else safe.take(100) + "." + safe.substringAfterLast('.', "bin")
    }

    private fun extensionOf(name: String): String {
        val dot = name.lastIndexOf('.')
        if (dot < 0) return ""
        return name.substring(dot).lowercase()
    }

    private fun looksLikeUtf8Text(bytes: ByteArray): Boolean {
        if (bytes.any { it == 0.toByte() }) return false
        return runCatching { String(bytes, StandardCharsets.UTF_8) }.isSuccess &&
            String(bytes, StandardCharsets.UTF_8).toByteArray(StandardCharsets.UTF_8).size == bytes.size
    }

    /**
     * 上传前的完整检查：大小、mime 支持、扩展名自洽、内容与声明一致。
     * @param declaredMime 内容解析器给的 mime；未知时按文件名推断，再兜底 octet-stream 由调用方报错。
     */
    fun check(filename: String?, declaredMime: String?, bytes: ByteArray): AttachmentCheck {
        if (bytes.isEmpty()) return AttachmentCheck.Rejected("文件内容为空")
        if (bytes.size > MAX_BYTES) {
            return AttachmentCheck.Rejected("文件 ${formatBytes(bytes.size.toLong())} 超过上限 ${formatBytes(MAX_BYTES.toLong())}")
        }
        val name = canonicalFilename(filename)
        val mime = declaredMime?.trim()?.lowercase().orEmpty().ifEmpty { mimeFromExtension(name) }
        if (!MIME_EXT.containsKey(mime)) {
            return AttachmentCheck.Rejected("不支持的类型 $mime，可上传图片、PDF、文本、Office 与 zip")
        }
        val ext = extensionOf(name)
        if (ext.isNotEmpty() && MIME_EXT[mime]?.contains(ext) != true) {
            return AttachmentCheck.Rejected("扩展名 $ext 与类型 $mime 不一致")
        }
        val sniffed = sniffMime(bytes)
        if (sniffed == null) {
            if (mime !in TEXT_MIMES) return AttachmentCheck.Rejected("文件内容不像声明的 $mime")
            if (!looksLikeUtf8Text(bytes)) return AttachmentCheck.Rejected("声明为文本，但内容不是合法 UTF-8")
            return AttachmentCheck.Ok(name, mime)
        }
        if (sniffed == "application/zip") {
            return if (mime in ZIP_CONTAINERS) AttachmentCheck.Ok(name, mime)
            else AttachmentCheck.Rejected("文件是 zip 容器，与类型 $mime 不一致")
        }
        if (sniffed != mime) return AttachmentCheck.Rejected("文件其实是 $sniffed，与声明的 $mime 不一致")
        return AttachmentCheck.Ok(name, mime)
    }

    fun mimeFromExtension(filename: String): String {
        val ext = extensionOf(filename)
        return MIME_EXT.entries.firstOrNull { it.value.contains(ext) }?.key ?: "application/octet-stream"
    }
}

private const val READ_CHUNK_BYTES = 64 * 1024

/** Reads at most maxBytes + 1; the extra byte signals overflow. Uses APIs available on Android 8.0. */
fun InputStream.readBoundedBytes(maxBytes: Int): ByteArray {
    require(maxBytes >= 0) { "maxBytes 不能为负：$maxBytes" }
    val limit = maxBytes.toLong() + 1
    val buffer = ByteArray(READ_CHUNK_BYTES)
    val out = ByteArrayOutputStream(minOf(limit, READ_CHUNK_BYTES.toLong()).toInt())
    var total = 0L
    while (total < limit) {
        val want = minOf(buffer.size.toLong(), limit - total).toInt()
        val read = read(buffer, 0, want)
        if (read < 0) break
        if (read == 0) {
            val next = read()
            if (next < 0) break
            out.write(next)
            total += 1
            continue
        }
        out.write(buffer, 0, read)
        total += read
    }
    return out.toByteArray()
}
