package org.ompbot.companion.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CompanionSessionTest {
    private fun device(id: String = "dev_1") = DeviceView(
        id = id,
        botIds = listOf("bot_1"),
        permissions = listOf("read", "run", "approve"),
        label = "Pixel 8",
    )

    private fun connection(id: String = "dev_1") = RemoteConnection(
        id = id,
        name = "Jerry PC",
        address = ServerAddress("http", "127.0.0.1", 3100),
        device = device(id),
        pairedAt = 5,
    )

    @Test
    fun `pairing persists the token before the connection becomes restorable`() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"name":"omp-bot","protocol":"ompbot-mobile-v1"}"""))
            server.enqueue(
                MockResponse().setResponseCode(201).setBody(
                    """{"token":"ompd_secret","device":{"id":"dev_1","botIds":["bot_1"],""" +
                        """"permissions":["read","run","approve"],"label":"Pixel 8"}}""",
                ),
            )
            val store = InMemoryConnectionStore()
            val tokens = InMemoryTokenStore()
            val session = CompanionSession(scope = this, store = store, tokens = tokens, clock = { 99 })

            val outcome = session.pair(
                PairingInvite(ServerAddress("http", "127.0.0.1", server.port), "ompcode_invite", "Jerry PC"),
                deviceName = "Pixel 8",
            )
            session.disconnect()
            assertTrue(outcome is PairOutcome.Paired, "应配对成功：$outcome")

            val found = tokens.read("dev_1")
            assertTrue(found is TokenReadResult.Found)
            assertEquals("ompd_secret", (found as TokenReadResult.Found).token)
            val stored = store.state.value
            assertEquals("dev_1", stored.activeId)
            assertEquals("Jerry PC", stored.active?.name)
            assertEquals(listOf("bot_1"), stored.active?.device?.botIds)
            assertEquals("Pixel 8", stored.deviceName)

            // 名字原样回到兑换请求里：电脑上这条设备记录显示的就是它。
            assertEquals("/api/health", server.takeRequest().path)
            val redeemRequest = server.takeRequest()
            assertEquals("/api/pairing/redeem", redeemRequest.path)
            val redeemBody = CompanionJson.parseToJsonElement(redeemRequest.body.readUtf8()) as kotlinx.serialization.json.JsonObject
            assertEquals("Pixel 8", (redeemBody["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `pairing refuses a server that is not the device entrance`() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"name":"omp-bot","protocol":"something-else"}"""))
            val store = InMemoryConnectionStore()
            val session = CompanionSession(scope = this, store = store, tokens = InMemoryTokenStore())
            val outcome = session.pair(
                PairingInvite(ServerAddress("http", "127.0.0.1", server.port), "ompcode_invite", null),
                deviceName = "Pixel",
            )
            session.disconnect()
            assertTrue(outcome is PairOutcome.Failed)
            assertTrue((outcome as PairOutcome.Failed).message.contains("设备入口"))
            assertNull(store.state.value.activeId)
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a phone with no name of its own leaves the label to the desktop`() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody("""{"name":"omp-bot","protocol":"ompbot-mobile-v1"}"""))
            server.enqueue(
                MockResponse().setResponseCode(201).setBody(
                    """{"token":"ompd_secret","device":{"id":"dev_3","botIds":["bot_1"],"permissions":["read"]}}""",
                ),
            )
            val store = InMemoryConnectionStore()
            val session = CompanionSession(scope = this, store = store, tokens = InMemoryTokenStore())
            val outcome = session.pair(
                PairingInvite(ServerAddress("http", "127.0.0.1", server.port), "ompcode_invite", "Jerry PC"),
                deviceName = "   ",
            )
            session.disconnect()
            assertTrue(outcome is PairOutcome.Paired, "应配对成功：$outcome")
            assertEquals("/api/health", server.takeRequest().path)
            val redeemBody = server.takeRequest()
            assertEquals("/api/pairing/redeem", redeemBody.path)
            val payload = CompanionJson.parseToJsonElement(redeemBody.body.readUtf8()) as kotlinx.serialization.json.JsonObject
            assertNull(payload["name"])
            assertEquals("", store.state.value.deviceName)
            assertEquals("Jerry PC", store.state.value.active?.name)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `a remembered connection restores its cursor before anything else runs`() = runTest {
        val store = InMemoryConnectionStore(
            StoredState(connections = listOf(connection()), activeId = "dev_1", cursor = 77, deviceName = "Pixel 8"),
        )
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = this, store = store, tokens = tokens)
        session.restore()
        session.disconnect()
        assertEquals("dev_1", session.connection.value?.id)
        assertEquals(77L, session.state.cursor.value)
    }

    @Test
    fun `a connection whose token is gone asks for pairing again`() = runTest {
        val store = InMemoryConnectionStore(
            StoredState(connections = listOf(connection()), activeId = "dev_1", cursor = 12),
        )
        val session = CompanionSession(scope = this, store = store, tokens = InMemoryTokenStore())
        session.restore()
        assertEquals(ConnectionStatus.Unpaired, session.status.value)
        assertNull(session.connection.value)
    }

    @Test
    fun `forgetting the connection erases the device token with it`() = runTest {
        val store = InMemoryConnectionStore(
            StoredState(connections = listOf(connection()), activeId = "dev_1", cursor = 12),
        )
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = this, store = store, tokens = tokens)
        session.restore()
        session.forgetActive()
        assertTrue(tokens.read("dev_1") is TokenReadResult.Missing)
        assertNull(store.state.value.activeId)
        assertTrue(store.state.value.connections.isEmpty())
        assertEquals(0, store.state.value.cursor)
        assertEquals(ConnectionStatus.Unpaired, session.status.value)
    }

    /** 模拟真实 DataStore：观察流先是占位值，真实记录要等首次读取才拿得到。 */
    private class DeferredConnectionStore(private val loaded: StoredState) : ConnectionStore {
        private val flow = MutableStateFlow(StoredState())
        override val state: StateFlow<StoredState> = flow
        var reads = 0
            private set

        override suspend fun read(): StoredState {
            reads += 1
            delay(5)
            flow.value = loaded
            return loaded
        }

        override suspend fun update(transform: (StoredState) -> StoredState) {
            flow.value = transform(flow.value)
        }
    }

    @Test
    fun `a cold start waits for the stored record instead of reading the placeholder`() = runTest {
        val store = DeferredConnectionStore(
            StoredState(connections = listOf(connection()), activeId = "dev_1", cursor = 77, deviceName = "Pixel 8"),
        )
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = this, store = store, tokens = tokens)
        session.restore()
        session.disconnect()
        // 占位值里没有任何连接：只有真的等了首次读取，这两条才成立。
        assertEquals("dev_1", session.connection.value?.id)
        assertEquals(77L, session.state.cursor.value)
        assertEquals(1, store.reads)
    }

    @Test
    fun `an address that cannot become a url fails the pair instead of crashing it`() = runTest {
        val session = CompanionSession(scope = this, store = InMemoryConnectionStore(), tokens = InMemoryTokenStore())
        val outcome = session.pair(
            PairingInvite(ServerAddress("https", "exa mple.com", null), "ompcode_invite", null),
            deviceName = "",
        )
        assertTrue(outcome is PairOutcome.Failed, "应返回失败：$outcome")
        assertTrue((outcome as PairOutcome.Failed).message.contains("地址不合法"), "应说明地址问题：${outcome.message}")
    }

    /**
     * gap 帧说的是「保留窗口不足」。补历史能取到的事件必须真的被应用（而不是直接跳到最新序号），
     * 否则区间里的 run_finished / 审批事件就永远看不到。这里用真实 IO 与真实时间跑一遍
     * 事件循环，所以用 runBlocking 而不是 runTest 的虚拟时间。
     */
    @Test
    fun `a gap frame refills what the ledger still has instead of jumping to the newest sequence`() = runBlocking {
        val server = MockWebServer()
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val store = InMemoryConnectionStore(
            StoredState(connections = listOf(connection().copy(address = ServerAddress("http", "127.0.0.1", server.port))), activeId = "dev_1", cursor = 10),
        )
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = scope, store = store, tokens = tokens)
        val approval = """{"id":"ui_55","botId":"bot_1","method":"confirm","status":"pending"}"""
        try {
            // 1) 快照：lastSeq 已经到 60，但列表里没有这条审批。
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody("""{"bots":[],"activeRuns":[],"pendingApprovals":[],"lastSeq":60}"""),
            )
            // 2) 事件流：服务端宣告从 50 之后才重放。
            server.enqueue(
                MockResponse()
                    .setHeader("Content-Type", "text/event-stream")
                    .setBody(
                        "data: {\"v\":1,\"type\":\"hello\",\"lastSeq\":60}\n\n" +
                            "data: {\"v\":1,\"type\":\"gap\",\"from\":10,\"to\":50,\"lastSeq\":60}\n\n" +
                            "id: 55\ndata: {\"v\":1,\"seq\":55,\"type\":\"ui_request\",\"botId\":\"bot_1\",\"approval\":$approval}\n\n",
                    ),
            )
            // 3) 补历史：账本还留着 55，客户端必须应用它。
            server.enqueue(
                MockResponse().setResponseCode(200).setBody(
                    """{"events":[{"v":1,"seq":55,"type":"ui_request","botId":"bot_1","approval":$approval}],"lastSeq":60}""",
                ),
            )

            session.restore()
            withTimeout(10_000) { while (session.state.cursor.value < 55) delay(25) }
            assertEquals("ui_55", session.state.pendingApprovals().single().id)
            withTimeout(10_000) { while (store.state.value.cursor < 55) delay(25) }
            assertEquals(55L, store.state.value.cursor)
        } finally {
            scope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `trimmed replay restores a run that finished while the phone was offline`() = runBlocking {
        val server = MockWebServer()
        var snapshots = 0
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/state" -> {
                    snapshots += 1
                    val runs = if (snapshots == 1) """[{"id":"run_1","botId":"bot_1","state":"running"}]""" else "[]"
                    MockResponse().setBody("""{"bots":[],"activeRuns":$runs,"pendingApprovals":[],"lastSeq":60}""")
                }
                request.path?.startsWith("/api/events/history") == true -> MockResponse().setBody("""{"events":[],"lastSeq":60}""")
                request.path?.startsWith("/api/events?") == true -> MockResponse()
                    .setHeader("Content-Type", "text/event-stream")
                    .setBody("data: {\"v\":1,\"type\":\"gap\",\"from\":10,\"to\":50,\"lastSeq\":60}\n\n")
                request.path == "/api/runs" -> MockResponse().setBody("""{"runs":[{"id":"run_1","botId":"bot_1","state":"completed","reply":"OFFLINE_RESULT"}]}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val remembered = connection().copy(address = ServerAddress("http", "127.0.0.1", server.port))
        val store = InMemoryConnectionStore(StoredState(connections = listOf(remembered), activeId = "dev_1", cursor = 10))
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = scope, store = store, tokens = tokens)
        try {
            session.restore()
            withTimeout(10_000) { while (session.state.runs.value["run_1"]?.state != "completed") delay(25) }
            assertEquals("OFFLINE_RESULT", session.state.runs.value["run_1"]?.reply)
            withTimeout(10_000) { while (store.state.value.cursor < 50) delay(25) }
            assertEquals(50L, store.state.value.cursor)
        } finally {
            scope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `a restored ledger behind the phone cursor still delivers new runs`() = runBlocking {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/state" -> MockResponse().setBody("""{"bots":[],"activeRuns":[],"pendingApprovals":[],"lastSeq":0}""")
                request.path?.startsWith("/api/events?") == true -> MockResponse()
                    .setHeader("Content-Type", "text/event-stream")
                    .setBody("data: {\"v\":1,\"type\":\"hello\",\"lastSeq\":0}\n\nid: 1\ndata: {\"v\":1,\"seq\":1,\"type\":\"run_updated\",\"botId\":\"bot_1\",\"run\":{\"id\":\"new_run\",\"botId\":\"bot_1\",\"state\":\"completed\",\"reply\":\"RESTORED_LEDGER\"}}\n\n")
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val remembered = connection().copy(address = ServerAddress("http", "127.0.0.1", server.port))
        val store = InMemoryConnectionStore(StoredState(connections = listOf(remembered), activeId = "dev_1", cursor = 500))
        val tokens = InMemoryTokenStore().apply { save("dev_1", "ompd_secret") }
        val session = CompanionSession(scope = scope, store = store, tokens = tokens)
        try {
            session.restore()
            withTimeout(10_000) { while (session.state.runs.value["new_run"]?.reply != "RESTORED_LEDGER") delay(25) }
            withTimeout(10_000) { while (store.state.value.cursor != 1L) delay(25) }
            assertEquals(1L, session.state.cursor.value)
            assertEquals("completed", session.state.runs.value["new_run"]?.state)
        } finally {
            scope.cancel()
            server.shutdown()
        }
    }

    @Test
    fun `the stored cursor never moves backwards and follows filtered jumps`() = runTest {
        val store = InMemoryConnectionStore(StoredState(cursor = 4))
        val state = CompanionState(initialCursor = 4)
        fun event(seq: Long) = RuntimeEvent(seq = seq, type = "bot_updated")

        assertEquals(CursorOutcome.APPLIED, state.applyEvent(event(5)))
        store.saveCursor(state.cursor.value)
        assertEquals(5L, store.state.value.cursor)

        // 设备的事件流按 bot 过滤：6..8 属于别的 bot，不会推给这台设备。
        // 游标必须跟着 9 走 —— 停在 5 只会让每次跳号都退化成一次快照。
        assertEquals(CursorOutcome.APPLIED, state.applyEvent(event(9)))
        store.saveCursor(state.cursor.value)
        assertEquals(9L, store.state.value.cursor)

        // 迟到的旧帧不能把游标拉回去。
        store.saveCursor(3)
        assertEquals(9L, store.state.value.cursor)
    }
}
