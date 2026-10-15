// CompanionState.kt — 手机端状态归约与事件游标。
//
// 归约是纯逻辑：事件进，状态变，游标按「已消费」推进。三条规则是硬性的：
//   1. seq ≤ 游标 → 重复帧，丢掉（重连时服务端会重放）。
//   2. seq > 游标 → 应用负载并把游标推到该 seq。**不许把跳号当断档**：设备的事件流是按
//      授权 bot 过滤过的（src/server.mjs pushFrame 里 `client.scope.has(evt.botId)`），
//      序号跳号只说明中间那些帧属于别的 bot。把它当断档会让 /api/events/history 永远补不齐
//      （它同样按 bot 过滤），于是每次跳号都退化成一趟快照，而快照只有活跃 Run 与待办审批 ——
//      区间里的 run_finished/artifact_added 就真丢了。
//   3. 快照只替换负载（花名册 / 活跃 Run / 待办审批），**不动游标**：快照里没有终态 Run、
//      没有成果、也不产生提醒，跳过区间等于让手机停在旧状态。游标只由真正消费到的事件推进；
//      服务端显式宣告「保留窗口不足」（gap 帧）时由 CompanionSession 推边界。

package org.ompbot.companion.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class CursorOutcome {
    /** 已应用并推进。 */
    APPLIED,

    /** 重复帧，未改动。 */
    DUPLICATE,
}

class CompanionState(initialCursor: Long = 0) {
    private val _bots = MutableStateFlow<List<Bot>>(emptyList())
    private val _runs = MutableStateFlow<Map<String, Run>>(emptyMap())
    private val _approvals = MutableStateFlow<Map<String, Approval>>(emptyMap())
    private val _artifacts = MutableStateFlow<Map<String, Artifact>>(emptyMap())
    private val _attachments = MutableStateFlow<Map<String, Attachment>>(emptyMap())
    private val _streams = MutableStateFlow<Map<String, RunStream>>(emptyMap())
    private val _messages = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    private val _cursor = MutableStateFlow(initialCursor)

    val bots: StateFlow<List<Bot>> = _bots.asStateFlow()
    val runs: StateFlow<Map<String, Run>> = _runs.asStateFlow()
    val approvals: StateFlow<Map<String, Approval>> = _approvals.asStateFlow()
    val artifacts: StateFlow<Map<String, Artifact>> = _artifacts.asStateFlow()
    val attachments: StateFlow<Map<String, Attachment>> = _attachments.asStateFlow()
    val streams: StateFlow<Map<String, RunStream>> = _streams.asStateFlow()
    val messages: StateFlow<Map<String, List<ChatMessage>>> = _messages.asStateFlow()
    val cursor: StateFlow<Long> = _cursor.asStateFlow()

    fun reset(cursor: Long = 0) {
        _bots.value = emptyList()
        _runs.value = emptyMap()
        _approvals.value = emptyMap()
        _artifacts.value = emptyMap()
        _attachments.value = emptyMap()
        _streams.value = emptyMap()
        _messages.value = emptyMap()
        _cursor.value = cursor
    }

    /**
     * 快照是权威：花名册整体替换，活跃 Run 与待办审批覆盖同名记录。
     * 但它**不推进游标**：快照里只有活跃 Run 与待办审批，没有终态 Run、没有成果、没有提醒，
     * 而它宣告的 lastSeq 只是「以下已包含在列表里」的边界，不覆盖事件的全部效果。
     * 游标停在已消费处，之后的事件仍由 SSE 按 since 重放，一条都不会被跳过。
     */
    fun applySnapshot(snapshot: Snapshot) {
        _bots.value = snapshot.bots
        val runs = _runs.value.toMutableMap()
        snapshot.activeRuns.forEach { runs[it.id] = it }
        _runs.value = runs
        _approvals.value = snapshot.pendingApprovals.associateBy { it.id }
    }

    fun applyEvent(event: RuntimeEvent): CursorOutcome {
        val seq = event.seq
        if (seq > 0 && seq <= _cursor.value) return CursorOutcome.DUPLICATE
        applyPayload(event)
        if (seq > _cursor.value) _cursor.value = seq
        return CursorOutcome.APPLIED
    }

    /**
     * 把游标推到 [seq]：调用方已确认这之前的序号要么真的消费过、要么已经不可能再重放
     * （服务端 gap 帧宣告的裁剪边界，配合一次快照对齐）。只向前。
     */
    fun advanceTo(seq: Long) {
        if (seq > _cursor.value) _cursor.value = seq
    }

    fun putRun(run: Run) {
        _runs.value = _runs.value + (run.id to run)
    }

    fun putApproval(approval: Approval) {
        _approvals.value = _approvals.value + (approval.id to approval)
    }

    fun setPendingApprovals(approvals: List<Approval>) {
        _approvals.value = approvals.associateBy { it.id }
    }

    fun mergeArtifacts(artifacts: List<Artifact>) {
        if (artifacts.isEmpty()) return
        _artifacts.value = _artifacts.value + artifacts.associateBy { it.id }
    }

    fun mergeAttachments(attachments: List<Attachment>) {
        if (attachments.isEmpty()) return
        _attachments.value = _attachments.value + attachments.associateBy { it.id }
    }

    fun setMessages(botId: String, messages: List<ChatMessage>) {
        _messages.value = _messages.value + (botId to messages)
    }

    fun stream(runId: String): RunStream? = _streams.value[runId]

    fun setStream(runId: String, stream: RunStream) {
        _streams.value = _streams.value + (runId to stream)
    }

    fun ingestNativeFrame(runId: String, element: kotlinx.serialization.json.JsonElement?) {
        val frame = NativeFrames.parse(element) ?: return
        val stream = _streams.value[runId] ?: RunStream()
        _streams.value = _streams.value + (runId to stream.fold(frame))
    }

    fun runsFor(botId: String): List<Run> = _runs.value.values
        .filter { it.botId == botId && it.kind != "delegation" }
        .sortedByDescending { it.createdAt }

    fun activeRunsFor(botId: String): List<Run> = runsFor(botId).filter { it.isActive }

    fun pendingApprovalsFor(botId: String): List<Approval> =
        _approvals.value.values.filter { it.botId == botId && it.isPending }.sortedBy { it.createdAt }

    fun pendingApprovals(): List<Approval> =
        _approvals.value.values.filter { it.isPending }.sortedBy { it.createdAt }

    fun artifactsFor(botId: String): List<Artifact> =
        _artifacts.value.values.filter { it.botId == botId }.sortedByDescending { it.createdAt }

    private fun applyPayload(event: RuntimeEvent) {
        when (event.type) {
            "run_created", "run_updated", "run_finished" -> event.run?.let(::putRun)
            "ui_request", "ui_resolved" -> event.approval?.let(::putApproval)
            "artifact_added" -> event.artifact?.let { artifact ->
                mergeArtifacts(listOf(artifact))
                val run = artifact.runId?.let { _runs.value[it] }
                if (run != null && !run.artifactIds.contains(artifact.id)) {
                    putRun(run.copy(artifactIds = run.artifactIds + artifact.id))
                }
            }
            "attachment_added" -> event.attachment?.let { mergeAttachments(listOf(it)) }
            "native_event" -> event.runId?.let { runId -> ingestNativeFrame(runId, event.event) }
            else -> Unit
        }
    }
}
