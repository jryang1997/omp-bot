package org.ompbot.companion.core

import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AttachmentGuardTest {
    private val png = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
    private val zip = byteArrayOf(0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4)
    private val pdf = "%PDF-1.7\nbody".toByteArray(StandardCharsets.US_ASCII)

    private fun ok(result: AttachmentCheck): AttachmentCheck.Ok {
        assertTrue(result is AttachmentCheck.Ok, "应通过：$result")
        return result as AttachmentCheck.Ok
    }

    private fun rejected(result: AttachmentCheck): String {
        assertTrue(result is AttachmentCheck.Rejected, "应拒绝：$result")
        return (result as AttachmentCheck.Rejected).message
    }

    @Test
    fun `a photo picked from the gallery goes through`() {
        val result = ok(AttachmentGuard.check("IMG_0042.png", "image/png", png))
        assertEquals("IMG_0042.png", result.filename)
        assertEquals("image/png", result.mime)
    }

    @Test
    fun `a rename cannot smuggle another format past the mime`() {
        val exe = byteArrayOf('M'.code.toByte(), 'Z'.code.toByte(), 0x90.toByte(), 0, 3, 0, 0, 0)
        assertTrue(rejected(AttachmentGuard.check("payload.png", "image/png", exe)).contains("不像"))
        assertTrue(rejected(AttachmentGuard.check("payload.png", "application/octet-stream", exe)).contains("不支持"))
    }

    @Test
    fun `an extension that contradicts the declared mime is refused before upload`() {
        assertTrue(rejected(AttachmentGuard.check("photo.pdf", "image/png", png)).contains("扩展名"))
    }

    @Test
    fun `office documents are accepted as zip containers`() {
        val result = ok(
            AttachmentGuard.check(
                "报表.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                zip,
            ),
        )
        assertEquals("报表.xlsx", result.filename)
        rejected(AttachmentGuard.check("报表.xlsx", "application/pdf", zip))
    }

    @Test
    fun `pdf magic must match the declared type`() {
        ok(AttachmentGuard.check("说明.pdf", "application/pdf", pdf))
        rejected(AttachmentGuard.check("说明.pdf", "text/plain", pdf))
    }

    @Test
    fun `text uploads must be real utf8 without NUL bytes`() {
        ok(AttachmentGuard.check("notes.md", "text/markdown", "# 你好".toByteArray(StandardCharsets.UTF_8)))
        assertTrue(
            rejected(AttachmentGuard.check("notes.txt", "text/plain", byteArrayOf(0x41, 0, 0x42)))
                .contains("UTF-8"),
        )
        // 非法 UTF-8 的二进制伪装成文本也要被拒。
        assertTrue(
            rejected(AttachmentGuard.check("notes.txt", "text/plain", byteArrayOf(0xC3.toByte(), 0x28, 0x41)))
                .contains("UTF-8"),
        )
    }

    @Test
    fun `empty and oversized files are refused locally`() {
        assertTrue(rejected(AttachmentGuard.check("empty.txt", "text/plain", ByteArray(0))).contains("为空"))
        val big = ByteArray(AttachmentGuard.MAX_BYTES + 1) { 0x41 }
        assertTrue(rejected(AttachmentGuard.check("big.txt", "text/plain", big)).contains("超过上限"))
    }

    @Test
    fun `a mime is inferred from the extension when the picker gives none`() {
        ok(AttachmentGuard.check("photo.png", null, png))
        ok(AttachmentGuard.check("photo.PNG", "", png))
        assertTrue(rejected(AttachmentGuard.check("photo.bin", null, png)).contains("不支持"))
    }

    @Test
    fun `filenames lose any path the picker may have carried`() {
        assertEquals("photo.png", AttachmentGuard.canonicalFilename("../../etc/photo.png"))
        assertEquals("photo.png", AttachmentGuard.canonicalFilename("C:\\Users\\Jerry\\photo.png"))
        assertEquals("附件", AttachmentGuard.canonicalFilename("   "))
        assertTrue(AttachmentGuard.canonicalFilename("x".repeat(400)).length <= 120)
    }

}
