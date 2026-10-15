// OmpBotApp.kt — 进程内的唯一装配点：会话、存储、通知、后台连接宽限。
//
// 这里没有第二个模型循环、没有第二份网络层：手机只跟电脑的设备入口说话，
// 所有业务动作都通过 [CompanionSession]。

package org.ompbot.companion

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import org.ompbot.companion.core.CompanionSession
import org.ompbot.companion.core.OmpBotApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.ompbot.companion.lifecycle.AlwaysOnConnectionState
import org.ompbot.companion.lifecycle.ServiceProcessAnchor
import org.ompbot.companion.lifecycle.SessionLingerController
import org.ompbot.companion.lifecycle.installSessionLinger
import org.ompbot.companion.notifications.LocalNotificationPoster
import org.ompbot.companion.storage.AlwaysOnPreferences
import org.ompbot.companion.storage.ConnectionPreferences
import org.ompbot.companion.storage.KeystoreTokenStore

class OmpBotApp : Application() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** 主线程受限：生命周期回调、宽限计时器与通知都跑在这个 scope 上。 */
    val appScope: CoroutineScope get() = scope

    lateinit var session: CompanionSession
        private set
    lateinit var connectionPreferences: ConnectionPreferences
        private set
    lateinit var tokenStore: KeystoreTokenStore
        private set
    lateinit var notifications: LocalNotificationPoster
        private set
    lateinit var alwaysOn: AlwaysOnPreferences
        private set
    lateinit var linger: SessionLingerController
        private set

    override fun onCreate() {
        super.onCreate()
        val client = OmpBotApi.defaultClient()
        connectionPreferences = ConnectionPreferences(this, scope)
        tokenStore = KeystoreTokenStore(applicationContext)
        alwaysOn = AlwaysOnPreferences(applicationContext)
        session = CompanionSession(
            scope = scope,
            store = connectionPreferences,
            tokens = tokenStore,
            apiFactory = { address, token -> OmpBotApi(address, token, client) },
        )
        notifications = LocalNotificationPoster(applicationContext)
        scope.launch {
            session.notices.collect { notice ->
                val connection = session.connection.value
                notifications.post(notice, canApprove = connection?.device?.canApprove == true)
            }
        }
        scope.launch { session.restore() }
        linger = installSessionLinger(
            lifecycle = ProcessLifecycleOwner.get().lifecycle,
            session = session,
            scope = scope,
            anchor = ServiceProcessAnchor(this),
            alwaysOn = { AlwaysOnConnectionState.active },
        )
    }
}
