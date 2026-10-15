// SessionLingerService.kt — 一个宽限窗口的锚。
//
// 它是一个普通 started service，唯一作用是让这个进程在窗口期内不算 cached 进程。
// 它不承载任何东西：没有第二个会话、没有 socket、没有线程、没有 binder、没有通知。
// 它保护的那条流本来就跑在这个进程里。
//
// 刻意**不是**前台服务：没有 startForeground、没有 foregroundServiceType、没有 FGS 权限。
// START_NOT_STICKY 是承重的：进程在窗口里死掉时，socket 与内存游标一起没了，
// 为了一个旧计时器重建进程既恢复不了流，也没有意义。

package org.ompbot.companion.lifecycle

import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.util.concurrent.atomic.AtomicReference

class SessionLingerService : Service() {
    private var token = NO_TOKEN

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val supplied = intent?.getLongExtra(EXTRA_TOKEN, NO_TOKEN) ?: NO_TOKEN
        if (supplied != NO_TOKEN) token = supplied
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val destroyed = token
        token = NO_TOKEN
        super.onDestroy()
        if (destroyed != NO_TOKEN) watcher.get()?.onAnchorDestroyed(destroyed)
    }

    /** 服务消失时（无论是控制器叫停还是系统回收）都会被告知；控制器用 token 分辨两者。 */
    fun interface Watcher {
        fun onAnchorDestroyed(token: Long)
    }

    companion object {
        const val EXTRA_TOKEN = "org.ompbot.companion.linger.TOKEN"
        const val NO_TOKEN = 0L

        // Service 由系统构造，所以交接只能走进程静态；它持有的是应用级控制器，本就活得比窗口久。
        private val watcher = AtomicReference<Watcher?>(null)

        fun watch(watcher: Watcher?) {
            this.watcher.set(watcher)
        }
    }
}
