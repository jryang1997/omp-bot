package org.ompbot.companion.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApprovalShapesTest {
    private fun approval(
        method: String?,
        options: List<String> = emptyList(),
        title: String? = null,
        questions: List<ApprovalQuestion>? = null,
    ) = Approval(
        id = "ui_1",
        botId = "bot_1",
        method = method,
        title = title,
        options = options.map { JsonPrimitive(it) },
        questions = questions,
    )

    @Test
    fun `each native method maps to one shape`() {
        assertEquals(ApprovalShape.OPTIONS, ApprovalShapes.shape(approval("select", listOf("Approve", "Deny"))))
        assertEquals(ApprovalShape.CONFIRM, ApprovalShapes.shape(approval("confirm")))
        assertEquals(ApprovalShape.TEXT, ApprovalShapes.shape(approval("input")))
        assertEquals(ApprovalShape.TEXT, ApprovalShapes.shape(approval("editor")))
        assertEquals(
            ApprovalShape.FORM,
            ApprovalShapes.shape(approval("ask", questions = listOf(ApprovalQuestion(header = "目标？")))),
        )
        assertEquals(ApprovalShape.MESSAGE, ApprovalShapes.shape(approval("show_message")))
        assertEquals(ApprovalShape.UNSUPPORTED, ApprovalShapes.shape(approval("secret")))
        assertEquals(ApprovalShape.UNSUPPORTED, ApprovalShapes.shape(approval("select")))
        assertEquals(ApprovalShape.UNSUPPORTED, ApprovalShapes.shape(approval(null)))
    }

    @Test
    fun `submits exactly what the server validates`() {
        assertEquals(
            """{"value":"Approve"}""",
            ApprovalAnswer.Value("Approve").toJson().toString(),
        )
        assertEquals(
            """{"confirmed":false}""",
            ApprovalAnswer.Confirmed(false).toJson().toString(),
        )
        assertEquals(
            """{"cancelled":true}""",
            ApprovalAnswer.Cancelled.toJson().toString(),
        )
        val form = ApprovalAnswer.Form(
            listOf(
                FormAnswer("目标目录？", FormValue.Single("/tmp/out")),
                FormAnswer("要改哪些？", FormValue.Many(listOf("a.kt", "b.kt"))),
            ),
        ).toJson()
        val answers = form["answers"] as JsonArray
        assertEquals(2, answers.size)
        assertEquals("目标目录？", (answers[0] as JsonObject)["header"]?.let { (it as JsonPrimitive).content })
        assertEquals("/tmp/out", (answers[0] as JsonObject)["value"]?.let { (it as JsonPrimitive).content })
        val multi = (answers[1] as JsonObject)["value"] as JsonArray
        assertEquals(listOf("a.kt", "b.kt"), multi.map { (it as JsonPrimitive).content })
    }

    @Test
    fun `a form is only submittable once every question is really answered`() {
        val form = approval(
            "ask",
            questions = listOf(
                ApprovalQuestion(header = "单选", options = listOf(JsonPrimitive("甲"), JsonPrimitive("乙"))),
                ApprovalQuestion(header = "手填"),
            ),
        )
        assertTrue(
            !ApprovalShapes.formComplete(
                listOf(FormAnswer("单选", FormValue.Single("")), FormAnswer("手填", FormValue.Single("写")),
                ),
                form,
            ),
        )
        assertTrue(
            ApprovalShapes.formComplete(
                listOf(FormAnswer("单选", FormValue.Single("甲")), FormAnswer("手填", FormValue.Single(" 写 "))),
                form,
            ),
        )
        // 问题数量对不上（漏答或多答）不能通过。
        assertTrue(!ApprovalShapes.formComplete(listOf(FormAnswer("单选", FormValue.Single("甲"))), form))
    }

    @Test
    fun `question options read label then value like the desktop does`() {
        val question = ApprovalQuestion(
            header = "选一个",
            multi = true,
            options = listOf(
                JsonPrimitive("plain"),
                JsonObject(
                    mapOf(
                        "value" to JsonPrimitive("v"),
                        "label" to JsonPrimitive("标签"),
                        "description" to JsonPrimitive("说明"),
                    ),
                ),
            ),
        )
        val options = ApprovalShapes.questionOptions(question)
        assertEquals("plain", options[0].value)
        assertEquals("标签", options[1].label)
        assertEquals("说明", options[1].description)
        assertTrue(question.multiSelect)
    }

    @Test
    fun `an expired approval is not pending and cannot be answered`() {
        val expired = approval("confirm").copy(expiresAt = 1_000)
        assertTrue(expired.isExpired(now = 2_000))
        assertTrue(!expired.isExpired(now = 500))
        assertTrue(!approval("confirm").copy(status = "answered", expiresAt = 1_000).isExpired(now = 2_000))
    }

}
