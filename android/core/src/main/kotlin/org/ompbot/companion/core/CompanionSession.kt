// CompanionSession.kt — 设备连接状态机与会话动作。
//
// 五个状态（契约里的 DeviceConnection）：Unpaired / Connecting / Live / Unauthorized / Offline。
//   - 401 一律停下重试并回到 Unauthorized：撤销后的凭证只会一直 401，重试是噪音。
//   - 瞬时断线回到 Offline，按 1s→15s 退避重连，重连先取快照再按游标接事件。
//   - 派活不自动重发（没有幂等键），取消/补充/审批同样只在用户按下时发一次。

package org.ompbot.companion.core

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

const val MOBILE_PROTOCOL = "ompbot-mobile-v1"

sealed interface ConnectionStatus {
    data object Unpaired : ConnectionStatus
    data class Connecting(val address: String) : ConnectionStatus
    data object Live : ConnectionStatus
    data class Unauthorized(val reason: String) : ConnectionStatus
    data class Offline(val reason: String) : ConnectionStatus

    val label: String
        get() = when (this) {
            is Unpaired -> "未配对"
            is Connecting -> "正在连接"
            is Live -> "已连接"
            is Unauthorized -> "需要重新配对"
            is Offline -> "离线"
        }
}

sealed interface SessionNotice {
    data class ApprovalAsked(val approval: Approval) : SessionNotice
    data class ApprovalSettled(val approvalId: String) : SessionNotice
    data class RunSettled(val run: Run) : SessionNotice
    data class Revoked(val reason: String) : SessionNotice
}

sealed interface PairOutcome {
    data class Paired(val connection: RemoteConnection) : PairOutcome
    data class Failed(val message: String) : PairOutcome
}

class CompanionSession(
    private val scope: CoroutineScope,
    val store: ConnectionStore,
    private val tokens: TokenStore,
    val state: CompanionState = CompanionState(),
    private val apiFactory: (ServerAddress, String?) -> OmpBotApi = { address, token -> OmpBotApi(address, token) },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Unpaired)
    private val _connection = MutableStateFlow<RemoteConnection?>(null)
    private val _notices = MutableSharedFlow<SessionNotice>(extraBufferCapacity = 64)

    val status: StateFlow<ConnectionStatus> = _status.asStateFlow()
    val connection: StateFlow<RemoteConnection?> = _connection.asStateFlow()
    val notices: SharedFlow<SessionNotice> = _notices.asSharedFlow()

    private var streamJob: Job? = null
    private var activeApi: OmpBotApi? = null

    /** 进程启动时调用：有连接就接上，没有就停在未配对。 */
    suspend fun restore() {
        // 必须是 read() 而不是 state.value：DataStore 的首次读取跑在它自己的 IO 作用域里，
        // 冷启动这一刻 state 还只是占位值，读它等于把已保存的配对轻轻丢掉。
        val stored = store.read()
        val active = stored.active
        if (active == null) {
            _connection.value = null
            _status.value = ConnectionStatus.Unpaired
            return
        }
        _connection.value = active
        state.reset(stored.cursor)
        when (val token = tokens.read(active.id)) {
            is TokenReadResult.Found -> connect()
            is TokenReadResult.Missing -> {
                _connection.value = null
                _status.value = ConnectionStatus.Unpaired
            }
            is TokenReadResult.Unavailable ->
                _status.value = ConnectionStatus.Unauthorized(token.message)
        }
    }

    /** 幂等：连接已经在跑时什么都不做。 */
    fun connect() {
        val connection = _connection.value ?: run {
            _status.value = ConnectionStatus.Unpaired
            return
        }
        if (streamJob?.isActive == true) return
        streamJob = scope.launch { runLoop(connection) }
    }

    fun disconnect() {
        streamJob?.cancel()
        streamJob = null
        activeApi = null
    }

    suspend fun forgetActive() {
        disconnect()
        val active = _connection.value
        if (active != null) tokens.remove(active.id)
        store.update { current ->
            StoredState(
                connections = current.connections.filterNot { it.id == active?.id },
                activeId = current.connections.firstOrNull { it.id != active?.id }?.id,
                cursor = 0,
                deviceName = current.deviceName,
                alwaysOn = current.alwaysOn,
            )
        }
        state.reset()
        _connection.value = null
        _status.value = ConnectionStatus.Unpaired
    }

    /**
     * 兑换配对码。顺序是刻意的：先落盘 token，再登记连接 —— 中途崩溃只可能留下
     * 「有 token 没有配对」（无害），不会留下「有配对没有 token」（回到手机说不出为什么连不上）。
     *
     * 设备名留空时不发 name：让电脑自己决定显示什么（配对码上的备注），
     * 而不是用手机猜的通用名字把它覆盖掉。
     */
    suspend fun pair(invite: PairingInvite, deviceName: String): PairOutcome {
        val name = deviceName.trim()
        return try {
            val health = apiFactory(invite.address, null).health()
            if (health.protocol != MOBILE_PROTOCOL) {
                return PairOutcome.Failed("${invite.address.displayAddress} 不是 OMP Bot 的设备入口（协议 ${health.protocol.ifEmpty { "未知" }}）")
            }
            val result = OmpBotApi.redeem(invite.address, invite.code, name.ifEmpty { null })
            val connection = RemoteConnection(
                id = result.device.id,
                name = invite.name ?: result.device.label.ifBlank { invite.address.displayAddress },
                address = invite.address,
                device = result.device,
                pairedAt = clock(),
            )
            tokens.save(connection.id, result.token)
            store.update { current ->
                current.withConnection(connection).copy(cursor = 0, deviceName = name)
            }
            state.reset()
            _connection.value = connection
            connect()
            PairOutcome.Paired(connection)
        } catch (error: ApiError) {
            PairOutcome.Failed(error.message ?: "配对失败")
        }
    }

    /** 只校验目标是不是 OMP Bot 设备入口，不兑换、不弹窗。 */
    suspend fun probe(address: ServerAddress): HealthInfo = apiFactory(address, null).health()

    // ---- 会话动作 ----
    suspend fun refreshSnapshot() {
        // 只对齐负载：游标不动，流里的事件继续按序号推进。
        state.applySnapshot(requireApi().state())
    }

    suspend fun refreshApprovals() {
        state.setPendingApprovals(requireApi().approvals())
    }

    suspend fun loadHistory(botId: String) {
        state.setMessages(botId, requireApi().chat(botId))
    }

    suspend fun loadArtifacts(botId: String) {
        state.mergeArtifacts(requireApi().artifacts(botId))
    }

    suspend fun loadAttachments(botId: String) {
        state.mergeAttachments(requireApi().attachments(botId))
    }

    suspend fun startRun(botId: String, text: String, attachmentIds: List<String> = emptyList()): Run {
        val run = requireApi().startRun(botId, text, attachmentIds)
        state.putRun(run)
        return run
    }

    suspend fun cancelRun(runId: String): Run? {
        val run = requireApi().cancelRun(runId)
        run?.let(state::putRun)
        return run
    }

    suspend fun steerRun(runId: String, text: String, behavior: String = "steer"): Run? {
        val run = requireApi().steerRun(runId, text, behavior)
        run?.let(state::putRun)
        return run
    }

    suspend fun respondApproval(approvalId: String, answer: ApprovalAnswer): Approval? {
        val approval = requireApi().respond(approvalId, answer)
        if (approval != null) {
            state.putApproval(approval)
        } else {
            val known = state.approvals.value[approvalId]
            if (known != null) state.putApproval(known.copy(status = "answered"))
        }
        _notices.tryEmit(SessionNotice.ApprovalSettled(approvalId))
        return approval
    }

    /**
     * 上传一个附件。bytes 已经在本地按服务端规则校验过（AttachmentGuard）。
     * 返回登记后的记录，调用方把它挂到这条消息上。
     */
    suspend fun uploadAttachment(botId: String, filename: String, mime: String, bytes: ByteArray): Attachment {
        val base64 = java.util.Base64.getEncoder().encodeToString(bytes)
        val attachment = requireApi().uploadAttachment(botId, filename, mime, base64)
        state.mergeAttachments(listOf(attachment))
        return attachment
    }

    suspend fun attachmentPreview(attachment: Attachment): ByteArray =
        requireApi().attachmentPreview(attachment.id, attachment.botId).first

    suspend fun artifactBytes(artifact: Artifact, preview: Boolean = false): ByteArray =
        requireApi().artifactBytes(artifact.id, preview = preview).first

    suspend fun refreshRun(runId: String) {
        val api = requireApi()
        val detail = api.run(runId)
        state.putRun(detail.run)
        detail.approvals.forEach(state::putApproval)
        state.mergeArtifacts(detail.artifacts)
        if (state.stream(runId) == null) rebuildStream(api, runId, detail.run)
    }

    private suspend fun requireApi(): OmpBotApi {
        activeApi?.let { return it }
        val connection = _connection.value ?: throw ApiError.Transport("还没有连接到电脑")
        val token = when (val stored = tokens.read(connection.id)) {
            is TokenReadResult.Found -> stored.token
            is TokenReadResult.Missing -> throw ApiError.Status(401, "unauthorized", "本机没有这个连接的设备凭证，请重新配对")
            is TokenReadResult.Unavailable -> throw ApiError.Transport(stored.message)
        }
        return apiFactory(connection.address, token).also { activeApi = it }
    }

    // ---- 连接循环 ----

    private suspend fun runLoop(connection: RemoteConnection) {
        var attempt = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            val token = when (val read = tokens.read(connection.id)) {
                is TokenReadResult.Found -> read.token
                is TokenReadResult.Missing -> {
                    _status.value = ConnectionStatus.Unauthorized("本机没有这个连接的设备凭证，请重新配对")
                    _notices.tryEmit(SessionNotice.Revoked("本机没有这个连接的设备凭证"))
                    return
                }
                is TokenReadResult.Unavailable -> {
                    _status.value = ConnectionStatus.Unauthorized(read.message)
                    return
                }
            }
            val api = apiFactory(connection.address, token)
            activeApi = api
            try {
                _status.value = ConnectionStatus.Connecting(connection.address.displayAddress)
                hydrate(api)
                _status.value = ConnectionStatus.Live
                attempt = 0
                collect(api)
                _status.value = ConnectionStatus.Offline("连接已断开")
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiError.Status) {
                if (error.isUnauthorized) {
                    _status.value = ConnectionStatus.Unauthorized(error.message ?: "设备凭证已失效")
                    _notices.tryEmit(SessionNotice.Revoked(error.message ?: "设备凭证已失效"))
                    return
                }
                _status.value = ConnectionStatus.Offline(error.message ?: "请求被拒绝")
            } catch (error: ApiError) {
                _status.value = ConnectionStatus.Offline(error.message ?: "无法连接到电脑")
            } catch (error: Exception) {
                _status.value = ConnectionStatus.Offline(error.message ?: "连接异常")
            }
            attempt += 1
            delay(backoffMillis(attempt))
        }
    }

    /**
     * 取快照并把活跃 Run 的正文补回来。快照是负载权威，但**不是**游标检查点：
     * 它只带活跃 Run 与待办审批，区间里的 run_finished / artifact_added 不在里面，
     * 所以游标保持不动，之后由 SSE 从 since=游标 把这些事件重放出来。
     */
    private suspend fun hydrate(api: OmpBotApi) {
        val snapshot = api.state()
        state.applySnapshot(snapshot)
        for (run in snapshot.activeRuns) {
            if (state.stream(run.id) == null) rebuildStream(api, run.id, run)
        }
    }

    private suspend fun rebuildStream(api: OmpBotApi, runId: String, run: Run?) {
        val page = try {
            api.history(since = 0, runId = runId)
        } catch (error: ApiError) {
            return
        }
        state.setStream(runId, replayRunStream(page.events, runId))
        run?.let { state.putRun(it) }
    }

    private suspend fun collect(api: OmpBotApi) {
        api.events(state.cursor.value).collect { frame ->
            when (frame) {
                is StreamFrame.Hello -> if (frame.lastSeq < state.cursor.value) {
                    state.reset(frame.lastSeq)
                    store.update { it.copy(cursor = frame.lastSeq) }
                    hydrate(api)
                }
                is StreamFrame.Gap -> resync(api, frame.to)
                is StreamFrame.Event -> applyEvent(frame.payload)
                is StreamFrame.Unknown -> Unit
            }
        }
    }

    /**
     * 服务端宣告保留窗口不足（gap 帧）：[boundary] 之前的序号不会再有帧推来。
     *
     * 先把还能取到的补齐 —— gap 的边界是 SSE 的重放窗口（REPLAY_LIMIT），而账本保留
     * 更多（EVENT_KEEP 5000），所以区间里往往还有能救的事件。补不齐（已被裁剪）才取快照
     * 对齐负载，并把游标推到服务端给的边界：此后 SSE 从边界之后推的每一帧都高于游标，
     * 不会被当成重复帧丢掉，也不会再反复重连取快照。
     */
    private suspend fun resync(api: OmpBotApi, boundary: Long) {
        if (refillTo(api, boundary)) {
            persistCursor()
            return
        }
        hydrate(api)
        api.runs().forEach(state::putRun)
        for (bot in state.bots.value) state.mergeArtifacts(api.artifacts(bot.id))
        state.advanceTo(boundary)
        persistCursor()
    }

    /**
     * 用 /api/events/history 把游标推到 [boundary]，返回是否推到了。
     *
     * 设备的历史接口同样按 bot 过滤（src/server.mjs 的 /api/events/history：先按 limit 取
     * 全局事件、再按 scope 过滤），所以页与页之间必然跳号 —— 终止条件只能看「这一页有没有
     * 让游标前进」，跳号、空页、页数上限都直接收手，绝不空转。返回 false 由调用方改用快照。
     */
    private suspend fun refillTo(api: OmpBotApi, boundary: Long): Boolean {
        var pages = 0
        while (state.cursor.value < boundary && pages < MAX_REFILL_PAGES) {
            val page = try {
                api.history(state.cursor.value)
            } catch (error: ApiError) {
                return false
            }
            if (page.events.isEmpty()) return false
            val before = state.cursor.value
            for (event in page.events) state.applyEvent(event)
            if (state.cursor.value <= before) return false
            pages += 1
        }
        return state.cursor.value >= boundary
    }

    private suspend fun applyEvent(event: RuntimeEvent) {
        when (state.applyEvent(event)) {
            CursorOutcome.APPLIED -> persistCursor()
            CursorOutcome.DUPLICATE -> return
        }
        when (event.type) {
            "ui_request" -> event.approval?.let { _notices.tryEmit(SessionNotice.ApprovalAsked(it)) }
            "ui_resolved" -> event.approval?.let { _notices.tryEmit(SessionNotice.ApprovalSettled(it.id)) }
            "run_finished" -> event.run?.let { run ->
                _notices.tryEmit(SessionNotice.RunSettled(run))
                run.botId?.let { botId ->
                    runCatching { loadHistory(botId) }
                    // 落定后拉一次详情：审批与成果都挂在这条 Run 上，事件流只带来状态。
                    runCatching { refreshRun(run.id) }
                }
            }
            else -> Unit
        }
    }

    private suspend fun persistCursor() {
        store.saveCursor(state.cursor.value)
    }

    private fun backoffMillis(attempt: Int): Long {
        val shift = (attempt - 1).coerceIn(0, 4)
        return (BASE_BACKOFF_MILLIS shl shift).coerceAtMost(MAX_BACKOFF_MILLIS)
    }

    companion object {
        const val BASE_BACKOFF_MILLIS = 1_000L
        const val MAX_BACKOFF_MILLIS = 15_000L
        private const val MAX_REFILL_PAGES = 40
    }
}

/** 给界面用的一条运行视图：运行记录 + 流式正文 + 附件/成果 + 待办审批。 */
data class RunView(
    val run: Run,
    val stream: RunStream,
    val approvals: List<Approval>,
)

