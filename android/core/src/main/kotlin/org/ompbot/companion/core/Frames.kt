// Frames.kt — 两条协议边界：SSE 信封（服务端 → 手机）与原生帧（runtime → 代办投影）。
//
// SSE 帧的形状见 src/server.mjs 的 frame()：`id: <seq>` 行加 `data: <json>`，JSON 里
// 有 v/seq/at/type 与各类型自己的负载。首帧是 hello{lastSeq}，事件被裁剪时补一个
// gap{from,to,lastSeq}。未知类型必须安全降级，坏 JSON 只丢一帧。

package org.ompbot.companion.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class RuntimeEvent(
    val v: Int = 1,
    val seq: Long = 0,
    val at: Long = 0,
    val type: String,
    val runId: String? = null,
    val botId: String? = null,
    val roomId: String? = null,
    val run: Run? = null,
    val approval: Approval? = null,
    val artifact: Artifact? = null,
    val attachment: Attachment? = null,
    /** native_event 的原生帧，原样保留由 NativeFrames 解析。 */
    val event: JsonElement? = null,
)

sealed interface StreamFrame {
    /** 服务端当前最大 seq；resumed=false 时游标之后的历史已经被裁剪。 */
    data class Hello(val lastSeq: Long, val resumed: Boolean = true) : StreamFrame

    /**
     * 保留窗口不足：`to` 是服务端这次重放的起点，`to` 之前的序号不会再推来。
     * 处理见 CompanionSession.resync：先尽量用 /api/events/history 补齐，补不齐才取快照
     * 对齐负载并把游标推到 `to`。
     */
    data class Gap(val from: Long, val to: Long, val lastSeq: Long) : StreamFrame

    data class Event(val payload: RuntimeEvent) : StreamFrame

    /** 未知帧类型：保留 seq 推进的可能，但内容不认识。 */
    data class Unknown(val type: String, val seq: Long) : StreamFrame
}

object StreamFrames {
    fun decode(text: String): StreamFrame? {
        val element = runCatching { CompanionJson.parseToJsonElement(text) }.getOrNull() ?: return null
        val obj = element as? JsonObject ?: return null
        return when (val type = obj.string("type")) {
            null -> null
            "hello" -> StreamFrame.Hello(lastSeq = obj.long("lastSeq") ?: 0, resumed = obj.bool("resumed") ?: true)
            "gap" -> StreamFrame.Gap(
                from = obj.long("from") ?: 0,
                to = obj.long("to") ?: 0,
                lastSeq = obj.long("lastSeq") ?: 0,
            )
            else -> {
                val payload = runCatching {
                    CompanionJson.decodeFromJsonElement(RuntimeEvent.serializer(), element)
                }.getOrNull()
                if (payload != null) StreamFrame.Event(payload) else StreamFrame.Unknown(type, obj.long("seq") ?: 0)
            }
        }
    }
}

// ---- 原生帧（OMP rpc-ui 帧 → 手机能画的部件）----

data class ChildTask(
    val id: String?,
    val label: String?,
    val agent: String?,
    val status: String?,
    val progress: Double?,
    val detail: String?,
)

sealed interface NativeFrame {
    data class Text(val text: String) : NativeFrame
    data class Thinking(val text: String) : NativeFrame
    /** 一个文本/思考块结束；下一次同种增量开启新块。 */
    data class BlockEnd(val block: String) : NativeFrame

    data class Tool(
        val phase: String,
        val id: String?,
        val name: String?,
        val isError: Boolean,
        val error: String?,
        val result: String?,
        val children: List<ChildTask>,
    ) : NativeFrame

    data class Subagent(
        val phase: String,
        val id: String?,
        val name: String?,
        val status: String?,
        val detail: String?,
    ) : NativeFrame

    data class Todo(val cleared: Boolean, val items: List<String>) : NativeFrame
    data class Goal(val text: String?) : NativeFrame
}

/**
 * 原生帧解析，移植自 web/workbench-native.js 的 parseNativeFrame：同一条原生流在电脑
 * 与手机上是同一套规则，未知帧一律 null（不是错误，只是没有可画的东西）。
 */
object NativeFrames {
    private val LIVE_TYPES = setOf(
        "text_delta", "thinking_delta", "toolcall_delta",
        "text_end", "thinking_end", "toolcall_end",
        "text_start", "thinking_start", "start",
    )

    fun parse(element: JsonElement?): NativeFrame? {
        val frame = element as? JsonObject ?: return null
        val type = frame.string("type") ?: return null
        return when {
            type == "message_update" -> messageUpdate(frame)
            type.startsWith("tool_execution_") || type == "tool_stream_update" -> tool(frame, type)
            type.startsWith("subagent_") -> subagent(frame, type)
            type == "todo_reminder" || type == "todo_auto_clear" -> todo(frame, type)
            type == "goal_updated" -> goal(frame)
            else -> null
        }
    }

    private fun messageUpdate(frame: JsonObject): NativeFrame? {
        val delta = frame["assistantMessageEvent"].objectOrNull() ?: frame
        val kind = delta.string("type") ?: return null
        if (kind !in LIVE_TYPES) return null
        val text = delta.text("delta", "text", "textDelta").orEmpty()
        return when (kind) {
            "text_delta" -> NativeFrame.Text(text)
            "thinking_delta" -> NativeFrame.Thinking(text)
            "text_end" -> NativeFrame.BlockEnd("text")
            "thinking_end" -> NativeFrame.BlockEnd("thinking")
            else -> null
        }
    }

    private fun tool(frame: JsonObject, type: String): NativeFrame {
        val phase = when (type) {
            "tool_execution_start" -> "start"
            "tool_execution_end" -> "end"
            else -> "update"
        }
        val children = childrenOf(frame)
        val result = frame.pick("result", "output", "content")
        val error = frame.string("error", "errorMessage")
        return NativeFrame.Tool(
            phase = phase,
            id = frame.string("toolCallId", "toolCallID", "callId", "id"),
            name = frame.string("toolName", "name", "tool"),
            isError = frame.bool("isError") == true || error != null,
            error = error,
            result = result?.displayText()?.let { truncate(it) },
            children = children,
        )
    }

    private fun subagent(frame: JsonObject, type: String): NativeFrame = NativeFrame.Subagent(
        phase = type.removePrefix("subagent_"),
        id = frame.string("subagentId", "id", "agentId"),
        name = frame.string("subagentName", "name", "agent", "label"),
        status = frame.string("status", "state"),
        detail = frame.text("detail", "message", "text", "summary"),
    )

    private fun todo(frame: JsonObject, type: String): NativeFrame.Todo {
        val raw = frame.pick("todos", "items", "todoPhases")
        val items = (raw as? kotlinx.serialization.json.JsonArray)?.mapNotNull { element ->
            val obj = element as? JsonObject
            val label = obj?.let { it.text("text", "title", "content") } ?: element.displayText()
            val done = obj?.bool("done") == true ||
                obj?.string("status") == "completed" ||
                obj?.bool("checked") == true
            label?.let { if (done) "[x] $it" else "[ ] $it" }
        }.orEmpty()
        return NativeFrame.Todo(cleared = type == "todo_auto_clear", items = items)
    }

    private fun goal(frame: JsonObject): NativeFrame.Goal {
        val goal = frame["goal"].objectOrNull() ?: frame
        val text = goal.text("text", "objective", "title", "description", "content")
            ?: (frame["goal"] as? JsonPrimitive)?.content
        return NativeFrame.Goal(text)
    }

    /**
     * OMP 异步任务没有 subagent_* 帧：子任务进度挂在 tool 帧的
     * partialResult/result.details.progress[]（task）或 details.jobs[]（wait）里。
     */
    private fun childrenOf(frame: JsonObject): List<ChildTask> {
        for (key in listOf("partialResult", "result")) {
            val details = frame[key].objectOrNull()?.get("details").objectOrNull() ?: continue
            val progress = details["progress"] as? kotlinx.serialization.json.JsonArray
            if (progress != null) {
                return progress.mapNotNull { child(it as? JsonObject) }
            }
            val jobs = details["jobs"] as? kotlinx.serialization.json.JsonArray
            if (jobs != null) {
                return jobs.mapNotNull { child(it as? JsonObject) }
            }
        }
        return emptyList()
    }

    private fun child(entry: JsonObject?): ChildTask? {
        if (entry == null) return null
        val id = entry.string("id", "label", "jobId", "agentUrlId")
        val label = entry.string("label", "id", "agentUrlId")
        if (id == null && label == null) return null
        val rawProgress = entry.pick("progress", "percent")?.asPlainString()?.toDoubleOrNull()
        val progress = rawProgress?.let { if (it > 1.0) it / 100.0 else it }
        return ChildTask(
            id = id,
            label = label,
            agent = entry.string("agent", "type", "agentSource"),
            status = entry.string("status", "state"),
            progress = progress,
            detail = entry.text("recentOutput", "recentTools", "detail", "summary"),
        )
    }

    private const val MAX_DETAIL_CHARS = 400

    private fun truncate(text: String): String =
        if (text.length <= MAX_DETAIL_CHARS) text else text.take(MAX_DETAIL_CHARS) + "…"
}
