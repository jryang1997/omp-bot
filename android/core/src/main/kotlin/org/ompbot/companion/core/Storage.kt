// Storage.kt — 会话存储边界。
//
// 两个存储、两种性质：设备 token 进 Android Keystore 加密存储（:app 的
// KeystoreTokenStore），连接与事件游标进普通 DataStore（可备份，不含秘密）。
// 接口放在 core，是为了让会话状态机能在纯 JVM 里被测试驱动。

package org.ompbot.companion.core

import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

/** 已配对的连接：地址 + 设备视图（不含 token）。 */
@Serializable
data class RemoteConnection(
    val id: String,
    val name: String,
    val address: ServerAddress,
    val device: DeviceView,
    val pairedAt: Long = 0,
) {
    val displayName: String get() = name.ifBlank { address.displayAddress }
}

sealed interface TokenReadResult {
    data class Found(val token: String) : TokenReadResult
    data object Missing : TokenReadResult
    data class Unavailable(val message: String, val locked: Boolean = false) : TokenReadResult
}

/** 设备 token 存储。写入必须先落盘再返回（进程被杀也不能留下「配对在、token 不在」）。 */
interface TokenStore {
    suspend fun save(connectionId: String, token: String)
    suspend fun read(connectionId: String): TokenReadResult
    suspend fun remove(connectionId: String)
}

/** 可备份的连接状态：连接、当前连接与已消费的事件序号。 */
@Serializable
data class StoredState(
    val connections: List<RemoteConnection> = emptyList(),
    val activeId: String? = null,
    val cursor: Long = 0,
    val deviceName: String = "",
    val alwaysOn: Boolean = false,
) {
    val active: RemoteConnection? get() = connections.firstOrNull { it.id == activeId }

    fun withConnection(connection: RemoteConnection): StoredState = copy(
        connections = connections.filterNot { it.id == connection.id } + connection,
        activeId = connection.id,
    )
}

interface ConnectionStore {
    /**
     * 观察用流。**冷启动时可能还只是占位值**（DataStore 的首次读取是异步的），
     * 任何「据此下判断」的地方必须先 [read]。
     */
    val state: StateFlow<StoredState>

    /**
     * 读当前的真实记录，返回前必须已经完成首次持久化读取。
     * 与 [state] 的区别就在这里：观察可以晚一点，判断不行。
     */
    suspend fun read(): StoredState

    /** 读改写；实现必须串行化（DataStore 的 edit 天然如此）。 */
    suspend fun update(transform: (StoredState) -> StoredState)

    /**
     * 只持久化**已消费**的序号：写进来的值必须已经真正应用到内存状态。
     */
    suspend fun saveCursor(seq: Long) {
        update { current -> if (seq > current.cursor) current.copy(cursor = seq) else current }
    }
}

/** 测试与预览用的内存实现；真实实现是 :app 里的 DataStore 版本。 */
class InMemoryConnectionStore(initial: StoredState = StoredState()) : ConnectionStore {
    private val flow = kotlinx.coroutines.flow.MutableStateFlow(initial)
    override val state: StateFlow<StoredState> = flow

    override suspend fun read(): StoredState = flow.value

    override suspend fun update(transform: (StoredState) -> StoredState) {
        flow.value = transform(flow.value)
    }
}

/** 内存 token 存储：只用于测试与进程内临时状态。 */
class InMemoryTokenStore : TokenStore {
    private val tokens = mutableMapOf<String, String>()

    override suspend fun save(connectionId: String, token: String) {
        tokens[connectionId] = token
    }

    override suspend fun read(connectionId: String): TokenReadResult =
        tokens[connectionId]?.let { TokenReadResult.Found(it) } ?: TokenReadResult.Missing

    override suspend fun remove(connectionId: String) {
        tokens.remove(connectionId)
    }
}
