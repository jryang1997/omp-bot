// SessionLingerController.kt — 离开界面后的 25 秒连接宽限。
//
// 结构移植自 OpenMausBot 的 app/.../lifecycle/SessionLingerController.kt（Apache-2.0，
// 见 android/PROVENANCE.md）：Android 没有 iOS 的 beginBackgroundTask，所以用「普通
// started service 把进程锚出 cached 类 + 一个可取消的计时协程」换这个窗口。
//
// **两个平台都不保证这个窗口**。系统可能提前回收锚服务，也可能直接杀进程；那样窗口
// 就结束了，恢复回落成正常的前台重连。这里的 25 秒是平台生命周期策略，不是协议的一部分：
// [CompanionSession.disconnect] 本身只是取消事件流。
//
// 主线程受限：生命周期回调、onAnchorLost（来自 Service.onDestroy）与计时协程都在同一个
// Dispatchers.Main.immediate 上，所以下面的代号记账不需要锁。

package org.ompbot.companion.lifecycle

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import org.ompbot.companion.core.CompanionSession
import org.ompbot.companion.core.ConnectionStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SessionLingerController(
    private val session: CompanionSession,
    private val scope: CoroutineScope,
    private val anchor: ProcessAnchor,
    private val alwaysOn: () -> Boolean = { false },
) : DefaultLifecycleObserver {

    /** 让进程在窗口期内不算 cached 进程的东西。生产实现是 [SessionLingerService]。 */
    interface ProcessAnchor {
        fun attach(controller: SessionLingerController)

        /** @return false 表示锚没拿到 —— 那就没有窗口。 */
        fun start(token: Long): Boolean

        fun stop(token: Long)
    }

    /**
     * 标识当前这一次退到后台。计时器或一次迟到的 onDestroy 只能对它自己那次生效 ——
     * 只比较「有没有任务在跑」不足以区分两次快速切换。
     */
    private var openToken: Long? = null
    private var nextToken = 1L
    private var timer: Job? = null
    private var foreground = false

    val openWindow: Long? get() = openToken

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
        // 先让旧窗口失效，再停锚：那次 onDestroy 就不能断掉我们正要保留的流。
        val closing = openToken
        openToken = null
        timer?.cancel()
        timer = null
        if (closing != null) anchor.stop(closing)
        session.connect()
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
        // 常驻连接服务已经在替用户保持进程：这个窗口要么多余（服务活着），要么过早
        //（服务正在 onDestroy 与重启之间），一律跳过，不去跟它抢。
        if (alwaysOn()) return
        if (openToken != null) return
        if (!worthHolding()) {
            session.disconnect()
            return
        }
        val token = nextToken++
        openToken = token
        if (!anchor.start(token)) {
            openToken = null
            session.disconnect()
            return
        }
        timer = scope.launch {
            delay(WINDOW_MILLIS)
            if (openToken != token || foreground) return@launch
            session.disconnect()
            openToken = null
            timer = null
            anchor.stop(token)
        }
    }

    /** 系统在到期前回收了锚服务。只有仍是当前那一次窗口的 token 才能结束窗口。 */
    fun onAnchorLost(token: Long) {
        if (openToken != token) return
        openToken = null
        timer?.cancel()
        timer = null
        if (foreground) return
        session.disconnect()
    }

    /**
     * [AlwaysOnConnectionService] 刚接管了「保持进程」。开关被打开与退到后台可能快过
     * onStartCommand 的执行，于是这里可能已经开了一个窗口；放着不管，它的计时器会在
     * 25 秒后从服务脚下把连接断掉。所以立刻拆掉窗口，但不碰会话（从这里开始归服务管）。
     */
    fun onAlwaysOnStarted() {
        val token = openToken ?: return
        openToken = null
        timer?.cancel()
        timer = null
        anchor.stop(token)
    }

    /**
     * 这次退到后台还有没有可能收到帧。
     *
     * 只看状态不够：刚配对成功时客户端已经在了但状态还可能是 Unpaired；未配对的连接
     * 则完全没有理由拿锚（也就不用为配对界面保住多播锁之类的东西）。
     */
    private fun worthHolding(): Boolean {
        if (session.status.value is ConnectionStatus.Unauthorized) return false
        return session.connection.value != null
    }

    companion object {
        const val WINDOW_MILLIS = 25_000L
    }
}

/** 生产里唯一的装配：建控制器、告诉锚「锚被回收时报给谁」、把控制器挂到进程生命周期上。 */
fun installSessionLinger(
    lifecycle: Lifecycle,
    session: CompanionSession,
    scope: CoroutineScope,
    anchor: SessionLingerController.ProcessAnchor,
    alwaysOn: () -> Boolean = { false },
): SessionLingerController {
    val controller = SessionLingerController(session, scope, anchor, alwaysOn)
    anchor.attach(controller)
    lifecycle.addObserver(controller)
    return controller
}
