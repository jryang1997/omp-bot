// AlwaysOnConnectionState.kt — 常驻连接服务是不是当前保持流打开的原因。
//
// [SessionLingerController.onStop] 会先读它：服务已经在替用户保持进程时，25 秒宽限
// 窗口就完全多余（服务还活着）或过早（服务刚要重启），所以直接跳过。
//
// 写（服务 onCreate/onDestroy）与读（挂在 ProcessLifecycleOwner 上的控制器）都在主线程。

package org.ompbot.companion.lifecycle

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

object AlwaysOnConnectionState {
    var active: Boolean = false
        internal set
    private val _failure = MutableStateFlow<String?>(null)
    val failure = _failure.asStateFlow()

    internal fun reportFailure(error: RuntimeException?) {
        _failure.value = error?.let { "常驻连接启动失败：${it.message ?: it.javaClass.simpleName}" }
    }
}
