// ConnectionPreferences.kt — 连接与事件游标的持久化。
//
// 存的是 [StoredState] 的 JSON（一条 Preferences 记录）：连接、当前连接、已消费的
// 事件序号、设备显示名、常驻连接开关。这里**不含 token**，token 在加密存储里。
//
// 读改写全部在 DataStore 的 edit 事务里做：两个并发的游标写入不会互相覆盖。

package org.ompbot.companion.storage

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import org.ompbot.companion.core.CompanionJson
import org.ompbot.companion.core.ConnectionStore
import org.ompbot.companion.core.StoredState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

private val Context.companionDataStore: DataStore<Preferences> by preferencesDataStore(name = "companion")

class ConnectionPreferences(
    private val context: Context,
    scope: CoroutineScope,
) : ConnectionStore {
    private val stored: Flow<StoredState> = context.companionDataStore.data
        .catch { emit(emptyPreferences()) }
        .map { preferences -> decode(preferences[STATE_KEY]) }

    override val state: StateFlow<StoredState> = stored.stateIn(scope, SharingStarted.Eagerly, StoredState())

    /**
     * DataStore 的首次读取跑在它自己的 IO 作用域里，冷启动时 [state] 还停在占位值。
     * 恢复会话要的是磁盘上真实的那一条，所以这里等第一口 `stored`。
     */
    override suspend fun read(): StoredState = stored.first()

    override suspend fun update(transform: (StoredState) -> StoredState) {
        context.companionDataStore.edit { preferences ->
            val current = decode(preferences[STATE_KEY])
            val next = transform(current)
            preferences[STATE_KEY] = CompanionJson.encodeToString(StoredState.serializer(), next)
        }
    }

    private fun decode(raw: String?): StoredState {
        if (raw.isNullOrBlank()) return StoredState()
        return runCatching { CompanionJson.decodeFromString(StoredState.serializer(), raw) }.getOrElse { StoredState() }
    }

    companion object {
        private val STATE_KEY = stringPreferencesKey("state")
    }
}
