// Models.kt — 手机端领域模型。
//
// 这些类型是服务端 JSON 的**边界形状**，不是服务端记录的完整投影：设备只看得到
// 授权 Bot 的私有会话、运行、审批、附件与成果。字段名与 src/ledger.mjs、
// src/orchestrator.mjs、src/features/*.mjs 的落库形状逐字对应。

package org.ompbot.companion.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class Bot(
    val id: String,
    val name: String,
    val role: String = "",
    val isMain: Boolean = false,
    val model: String? = null,
)

/** Run 状态取值与 src/constants.mjs 的 RUN_STATES 一致，不在这里另造一套。 */
object RunStates {
    const val QUEUED = "queued"
    const val STARTING = "starting"
    const val RUNNING = "running"
    const val WAITING_INPUT = "waiting_input"
    const val WAITING_APPROVAL = "waiting_approval"
    const val CANCELLING = "cancelling"
    const val COMPLETED = "completed"
    const val FAILED = "failed"
    const val CANCELLED = "cancelled"
    const val INTERRUPTED = "interrupted"
    const val RECONCILIATION_REQUIRED = "reconciliation_required"

    val ACTIVE = setOf(QUEUED, STARTING, RUNNING, WAITING_INPUT, WAITING_APPROVAL, CANCELLING)
    val TERMINAL = setOf(COMPLETED, FAILED, CANCELLED, INTERRUPTED, RECONCILIATION_REQUIRED)

    fun isActive(state: String?): Boolean = state in ACTIVE
    fun isTerminal(state: String?): Boolean = state in TERMINAL

    fun label(state: String?): String = when (state) {
        QUEUED -> "排队中"
        STARTING -> "启动中"
        RUNNING -> "执行中"
        WAITING_INPUT -> "等待输入"
        WAITING_APPROVAL -> "等待审批"
        CANCELLING -> "正在停止"
        COMPLETED -> "已完成"
        FAILED -> "失败"
        CANCELLED -> "已取消"
        INTERRUPTED -> "已中断"
        RECONCILIATION_REQUIRED -> "待人工核对"
        else -> state ?: "未知"
    }
}

@Serializable
data class Run(
    val id: String,
    val kind: String = "chat",
    val botId: String? = null,
    val roomId: String? = null,
    val scope: String = "private",
    val text: String = "",
    val state: String = RunStates.QUEUED,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val parentRunId: String? = null,
    val source: String = "user",
    val attachmentIds: List<String> = emptyList(),
    val approvalIds: List<String> = emptyList(),
    val artifactIds: List<String> = emptyList(),
    val reply: String? = null,
    val error: String? = null,
    val recovery: JsonObject? = null,
    val stats: JsonObject? = null,
) {
    val isActive: Boolean get() = RunStates.isActive(state)
    val isTerminal: Boolean get() = RunStates.isTerminal(state)
    val stateLabel: String get() = RunStates.label(state)
}

@Serializable
data class ApprovalQuestion(
    val header: String? = null,
    val question: String? = null,
    val options: List<JsonElement>? = null,
    val multi: Boolean = false,
) {
    val label: String get() = header?.takeIf { it.isNotBlank() } ?: question.orEmpty().ifBlank { "问题" }
    val multiSelect: Boolean get() = multi
}

@Serializable
data class Approval(
    val id: String,
    val runId: String? = null,
    val botId: String = "",
    val method: String? = null,
    val title: String? = null,
    val message: String? = null,
    val options: List<JsonElement>? = null,
    val optionDetails: List<JsonElement>? = null,
    val questions: List<ApprovalQuestion>? = null,
    val status: String = "pending",
    val createdAt: Long = 0,
    val expiresAt: Long? = null,
    val response: JsonElement? = null,
) {
    val isPending: Boolean get() = status == "pending"

    fun isExpired(now: Long = System.currentTimeMillis()): Boolean =
        isPending && (expiresAt ?: 0L) > 0 && (expiresAt ?: 0L) <= now

    /**
     * 工具批准是原生 select 的一个具体形状（title 以 "Allow tool:" 开头，
     * 选项固定为 Approve/Deny）。识别它只改变呈现，不改变提交的 value。
     */
    val isToolApproval: Boolean
        get() = method == "select" &&
            title.orEmpty().startsWith("Allow tool:") &&
            optionValues == listOf("Approve", "Deny")

    val optionValues: List<String>
        get() = options.orEmpty().map { element ->
            (element as? JsonObject)?.let { obj ->
                obj.string("value") ?: obj.string("label") ?: obj.displayText().orEmpty()
            } ?: element.displayText().orEmpty()
        }

    /** 选项的展示文本与说明；optionDetails 与 options 按下标对应（web 端同一规则）。 */
    fun optionLabel(index: Int): ApprovalOption {
        val value = optionValues.getOrNull(index).orEmpty()
        val detail = optionDetails?.getOrNull(index)
        val objectDetail = detail as? JsonObject
        val label = objectDetail?.string("label") ?: value
        val description = objectDetail?.string("description")
            ?: objectDetail?.string("detail")
            ?: (detail as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.content != value }?.content
        return ApprovalOption(value = value, label = label.ifBlank { value }, description = description.orEmpty())
    }

    fun toolApprovalText(): String = title.orEmpty()
        .removePrefix("Allow tool:")
        .replace("\nCommand:", "\n命令：")
        .replace("\nReason:", "\n原因：")
        .trim()
}

data class ApprovalOption(val value: String, val label: String, val description: String)

@Serializable
data class Attachment(
    val id: String,
    val botId: String,
    val filename: String = "",
    val mime: String = "",
    val kind: String = "",
    val size: Long = 0,
    val hash: String = "",
    val createdAt: Long = 0,
) {
    val isImage: Boolean get() = kind == "image"
}

@Serializable
data class Artifact(
    val id: String,
    val botId: String,
    val runId: String? = null,
    val name: String = "",
    val mime: String = "",
    val previewType: String? = null,
    val size: Long = 0,
    val version: Int = 1,
    val immutable: Boolean = true,
    val createdAt: Long = 0,
)

/**
 * 一条私聊记录。
 *
 * 两种投影都要能解：桌面工作台读的是 {kind,from,fromName,text,at}（聊天日志的原始形状），
 * 设备入口给的是 {role:"user"|"assistant",text,at}。字段全可选、按 author 归类，
 * 形状换名不会让历史静默变空。
 */
@Serializable
data class ChatMessage(
    val role: String? = null,
    val kind: String? = null,
    val from: String = "",
    val fromName: String = "",
    val text: String = "",
    val at: Long = 0,
    val meta: JsonElement? = null,
) {
    /** "user" | "assistant" | "system"（两种投影的统一说法）。 */
    val author: String
        get() = when ((role ?: kind).orEmpty().lowercase()) {
            "user", "me", "human" -> "user"
            "bot", "assistant", "agent" -> "assistant"
            "system" -> "system"
            else -> (role ?: kind).orEmpty().lowercase()
        }

    val isUser: Boolean get() = author == "user"
    val isBot: Boolean get() = author == "assistant"
    val displayName: String get() = fromName.ifBlank { if (isUser) "你" else "Bot" }
}

@Serializable
data class Snapshot(
    val bots: List<Bot> = emptyList(),
    val activeRuns: List<Run> = emptyList(),
    val pendingApprovals: List<Approval> = emptyList(),
    val lastSeq: Long = 0,
)

@Serializable
data class DeviceView(
    val id: String,
    val botIds: List<String> = emptyList(),
    val permissions: List<String> = emptyList(),
    val label: String = "",
    val createdAt: Long = 0,
    val lastUsedAt: Long? = null,
) {
    val canRead: Boolean get() = permissions.contains("read")
    val canRun: Boolean get() = permissions.contains("run")
    val canApprove: Boolean get() = permissions.contains("approve")

    fun describePermissions(): String = permissions.map {
        when (it) {
            "read" -> "读取"
            "run" -> "派活"
            "approve" -> "审批"
            else -> it
        }
    }.joinToString("、").ifBlank { "无" }
}

@Serializable
data class RedeemResult(val token: String, val device: DeviceView)

fun formatBytes(size: Long): String = when {
    size < 1024 -> "$size B"
    size < 1024 * 1024 -> "%.1f KB".format(size / 1024.0)
    else -> "%.1f MB".format(size / (1024.0 * 1024.0))
}

fun formatClock(at: Long): String {
    if (at <= 0) return ""
    val format = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.CHINA)
    return format.format(java.util.Date(at))
}
