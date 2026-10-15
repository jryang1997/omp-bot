// ApprovalAnswer.kt — 原生审批的形状与应答载荷。
//
// 形状来自 src/orchestrator.mjs 的 _onUiRequest 与 validateUiResponse：只有
// select/confirm/input/editor/ask 是可作答的；secret 这类必须到电脑上处理，
// 这里如实标成「不可代答」，不做假控件。

package org.ompbot.companion.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

enum class ApprovalShape {
    /** 单选（含「允许工具」这种固定两项）。 */
    OPTIONS,

    /** 是/否。 */
    CONFIRM,

    /** 单行或多行文本。 */
    TEXT,

    /** 多问题表单。 */
    FORM,

    /** 只展示，无需作答。 */
    MESSAGE,

    /** 需要电脑上的专用流程，手机不代答。 */
    UNSUPPORTED,
}

data class FormAnswer(val header: String, val value: FormValue)

sealed interface FormValue {
    data class Single(val text: String) : FormValue
    data class Many(val values: List<String>) : FormValue
}

sealed interface ApprovalAnswer {
    data class Value(val value: String) : ApprovalAnswer
    data class Confirmed(val confirmed: Boolean) : ApprovalAnswer
    data class Form(val answers: List<FormAnswer>) : ApprovalAnswer
    data object Cancelled : ApprovalAnswer

    /** 服务端只接受这几种键（POST /api/approvals/:id/respond）。 */
    fun toJson(): JsonObject = when (this) {
        is Value -> buildJsonObject { put("value", JsonPrimitive(value)) }
        is Confirmed -> buildJsonObject { put("confirmed", JsonPrimitive(confirmed)) }
        is Cancelled -> buildJsonObject { put("cancelled", JsonPrimitive(true)) }
        is Form -> buildJsonObject {
            put(
                "answers",
                JsonArray(
                    answers.map { answer ->
                        buildJsonObject {
                            put("header", JsonPrimitive(answer.header))
                            when (val value = answer.value) {
                                is FormValue.Single -> put("value", JsonPrimitive(value.text))
                                is FormValue.Many -> put(
                                    "value",
                                    JsonArray(value.values.map { JsonPrimitive(it) }),
                                )
                            }
                        }
                    },
                ),
            )
        }
    }
}

object ApprovalShapes {
    private val UNANSWERABLE = setOf("secret")

    fun shape(approval: Approval): ApprovalShape {
        val method = approval.method ?: return ApprovalShape.UNSUPPORTED
        if (method in UNANSWERABLE) return ApprovalShape.UNSUPPORTED
        return when (method) {
            "select" -> if (approval.optionValues.isEmpty()) ApprovalShape.UNSUPPORTED else ApprovalShape.OPTIONS
            "confirm" -> ApprovalShape.CONFIRM
            "input" -> ApprovalShape.TEXT
            "editor" -> ApprovalShape.TEXT
            "ask" -> if (approval.questions.orEmpty().isEmpty()) ApprovalShape.UNSUPPORTED else ApprovalShape.FORM
            else -> ApprovalShape.MESSAGE
        }
    }

    /**
     * 表单答案是否可提交：每个问题都要有真实回答（有选项的必须选中，无选项的必须填字）。
     * 服务端不会替用户挑默认值，所以这里也不补。
     */
    fun formComplete(answers: List<FormAnswer>, approval: Approval): Boolean {
        val questions = approval.questions.orEmpty()
        if (answers.size != questions.size) return false
        return answers.zip(questions).all { (answer, question) ->
            if (question.multiSelect) {
                (answer.value as? FormValue.Many)?.values?.isNotEmpty() == true
            } else {
                val text = (answer.value as? FormValue.Single)?.text.orEmpty().trim()
                text.isNotEmpty()
            }
        }
    }

    /** 选项类问题的候选项，与 web 端同一读取顺序（label 优先，其次 value）。 */
    fun questionOptions(question: ApprovalQuestion): List<ApprovalOption> =
        question.options.orEmpty().map { element ->
            val obj = element as? JsonObject
            val value = obj?.string("value") ?: obj?.string("label") ?: element.displayText().orEmpty()
            val label = obj?.string("label") ?: value
            val description = obj?.string("description") ?: obj?.string("detail") ?: ""
            ApprovalOption(value = value.ifBlank { label }, label = label.ifBlank { value }, description = description)
        }
}
