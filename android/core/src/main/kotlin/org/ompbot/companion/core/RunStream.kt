// RunStream.kt — 一次运行的流式展示状态。
//
// 纯数据 + 纯折叠：原生帧进，可画的部件出。没有 Android、没有 IO，所以它能被
// JVM 单测直接驱动（tests: RunStreamTest）。

package org.ompbot.companion.core

sealed interface StreamPart {
    data class Text(val text: String) : StreamPart
    data class Thinking(val text: String) : StreamPart
    data class Note(val text: String) : StreamPart
}

data class ToolEntry(
    val key: String,
    val name: String,
    val phase: String,
    val isError: Boolean,
    val detail: String?,
)

data class ChildEntry(
    val key: String,
    val label: String,
    val agent: String?,
    val status: String?,
    val progress: Double?,
    val detail: String?,
)

data class RunStream(
    val parts: List<StreamPart> = emptyList(),
    val tools: List<ToolEntry> = emptyList(),
    val children: List<ChildEntry> = emptyList(),
    val todos: List<String> = emptyList(),
    val goal: String? = null,
    /** 当前仍可继续追加的块的种类（"text"/"thinking"），null 表示下一个增量另起一块。 */
    val openBlock: String? = null,
) {
    /** 已流出的助手正文，用于历史还没落库时先把回复留在屏幕上。 */
    val text: String
        get() = parts.filterIsInstance<StreamPart.Text>().joinToString("\n\n") { it.text }.trim()

    val thinking: String
        get() = parts.filterIsInstance<StreamPart.Thinking>().joinToString("\n\n") { it.text }.trim()

    val isEmpty: Boolean
        get() = parts.isEmpty() && tools.isEmpty() && children.isEmpty() && todos.isEmpty() && goal == null

    /**
     * 折叠一帧。
     *
     * 同种增量落在同一个块里；[NativeFrame.BlockEnd] 关掉当前块，下一次增量另起一块。
     * 与 web 端 LiveRun.part/endPart 同一语义，同一段原生流在电脑与手机上画法一致。
     */
    fun fold(frame: NativeFrame): RunStream = when (frame) {
        is NativeFrame.Text -> append("text", StreamPart.Text(frame.text))
        is NativeFrame.Thinking -> append("thinking", StreamPart.Thinking(frame.text))
        is NativeFrame.BlockEnd -> if (openBlock == frame.block) copy(openBlock = null) else this
        is NativeFrame.Tool -> foldTool(frame)
        is NativeFrame.Todo -> copy(todos = if (frame.cleared) emptyList() else frame.items)
        is NativeFrame.Goal -> copy(goal = frame.text)
        is NativeFrame.Subagent -> foldChild(frame)
    }

    /** 本地提示（用户发言、取消等），关掉当前块，避免后续增量并进提示里。 */
    fun note(text: String): RunStream = copy(parts = parts + StreamPart.Note(text), openBlock = null)

    private fun append(kind: String, part: StreamPart): RunStream {
        val last = parts.lastOrNull()
        val mergeable = openBlock == kind && last != null && last::class == part::class
        if (!mergeable) return copy(parts = parts + part, openBlock = kind)
        val merged = when {
            part is StreamPart.Text && last is StreamPart.Text -> StreamPart.Text(last.text + part.text)
            part is StreamPart.Thinking && last is StreamPart.Thinking -> StreamPart.Thinking(last.text + part.text)
            else -> part
        }
        return copy(parts = parts.dropLast(1) + merged, openBlock = kind)
    }

    private fun foldTool(frame: NativeFrame.Tool): RunStream {
        val pendingKey = "pending:${frame.name.orEmpty()}"
        val key = frame.id ?: tools.firstOrNull { it.key == pendingKey }?.key ?: pendingKey
        val previous = tools.firstOrNull { it.key == key || it.key == pendingKey }
        val entry = ToolEntry(
            key = key,
            name = frame.name ?: previous?.name.orEmpty(),
            phase = frame.phase,
            isError = frame.isError,
            detail = frame.error ?: frame.result ?: previous?.detail,
        )
        val next = tools.filterNot { it.key == key || it.key == pendingKey } + entry
        return copy(tools = next, children = mergeChildren(frame.children), openBlock = null)
    }

    private fun mergeChildren(incoming: List<ChildTask>): List<ChildEntry> {
        if (incoming.isEmpty()) return children
        var updated = children
        for (child in incoming) {
            val key = child.id ?: child.label ?: continue
            val previous = updated.firstOrNull { it.key == key }
            updated = updated.filterNot { it.key == key } + ChildEntry(
                key = key,
                label = child.label ?: previous?.label ?: key,
                agent = child.agent ?: previous?.agent,
                status = child.status ?: previous?.status,
                progress = child.progress ?: previous?.progress,
                detail = child.detail ?: previous?.detail,
            )
        }
        return updated
    }

    private fun foldChild(frame: NativeFrame.Subagent): RunStream {
        val key = frame.id ?: frame.name ?: return this
        val previous = children.firstOrNull { it.key == key }
        val entry = ChildEntry(
            key = key,
            label = frame.name ?: previous?.label ?: key,
            agent = previous?.agent,
            status = frame.status ?: previous?.status,
            progress = previous?.progress,
            detail = frame.detail ?: previous?.detail,
        )
        return copy(children = children.filterNot { it.key == key } + entry)
    }
}

/**
 * 把一段事件历史折成流式状态：重连后用它把活跃 Run 的正文补回来
 * （GET /api/events/history?since=0&runId=…）。只认 native_event。
 */
fun replayRunStream(events: List<RuntimeEvent>, runId: String): RunStream {
    var stream = RunStream()
    for (event in events) {
        if (event.type != "native_event" || event.runId != runId) continue
        val frame = NativeFrames.parse(event.event) ?: continue
        stream = stream.fold(frame)
    }
    return stream
}
