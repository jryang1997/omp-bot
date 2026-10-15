package org.ompbot.companion.platform

import org.ompbot.companion.core.Artifact
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ArtifactFilesTest {
    private fun artifact(name: String, mime: String, previewType: String? = null) =
        Artifact(id = "art_1", botId = "bot_1", name = name, mime = mime, previewType = previewType)

    @Test
    fun `a saved file keeps a usable name and never a path`() {
        assertEquals("report.md", ArtifactFiles.sanitizeName("report.md"))
        assertEquals("report.md", ArtifactFiles.sanitizeName("C:\\Users\\Jerry\\report.md"))
        assertEquals("report.md", ArtifactFiles.sanitizeName("../../report.md"))
        assertEquals("成果", ArtifactFiles.sanitizeName("   "))
        assertTrue(ArtifactFiles.sanitizeName("x".repeat(300)).length <= 100)
    }

    @Test
    fun `a nameless artifact still saves under a readable name`() {
        assertEquals("art_1", ArtifactFiles.defaultFileName(artifact("", "application/pdf")))
        assertEquals("周报.xlsx", ArtifactFiles.defaultFileName(artifact("周报.xlsx", "application/vnd.ms-excel")))
    }

    @Test
    fun `the content type comes from the response, then the record, then a safe default`() {
        assertEquals("image/png", ArtifactFiles.mimeFor(artifact("a.png", "image/png"), "image/png; charset=binary"))
        assertEquals("application/pdf", ArtifactFiles.mimeFor(artifact("a.pdf", "application/pdf"), null))
        assertEquals("application/octet-stream", ArtifactFiles.mimeFor(artifact("a", ""), null))
    }

    @Test
    fun `preview only opens what it can actually draw`() {
        assertEquals(PreviewKind.IMAGE, ArtifactFiles.previewKind("image/jpeg", "image"))
        assertEquals(PreviewKind.TEXT, ArtifactFiles.previewKind("text/markdown", null))
        assertEquals(PreviewKind.TEXT, ArtifactFiles.previewKind("application/json", null))
        assertEquals(PreviewKind.NONE, ArtifactFiles.previewKind("application/pdf", "pdf"))
        assertEquals(PreviewKind.NONE, ArtifactFiles.previewKind("application/octet-stream", null))
    }
}
