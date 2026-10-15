// PendingNavigation.kt — 进程内的两个跳转意图。
//
// 深链与通知点击都经过这里，而不是把带凭据的 Intent 直接交给主界面：
// 链接里的一次性配对码只活在进程内存里，主界面收到的是已经解析好的邀请。

package org.ompbot.companion.platform

import org.ompbot.companion.core.PairingLinkResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class NavigationTarget(val botId: String?, val runId: String?)

object PendingNavigation {
    private val _invite = MutableStateFlow<PairingLinkResult?>(null)
    val invite: StateFlow<PairingLinkResult?> = _invite.asStateFlow()

    private val _target = MutableStateFlow<NavigationTarget?>(null)
    val target: StateFlow<NavigationTarget?> = _target.asStateFlow()

    fun postInvite(result: PairingLinkResult) {
        _invite.value = result
    }

    fun clearInvite() {
        _invite.value = null
    }

    fun postTarget(target: NavigationTarget) {
        _target.value = target
    }

    fun clearTarget() {
        _target.value = null
    }
}
