// ServiceProcessAnchor.kt — 宽限窗口的锚在生产里的实现：起停 [SessionLingerService]。
//
// 起不来是正常结果，不是崩溃：API 26 起，应用过了前台宽限期之后系统会拒绝 startService，
// 厂商策略可能更严。控制器把拒绝当成「窗口拿不到」，立刻断开流。

package org.ompbot.companion.lifecycle

import android.content.Context
import android.content.Intent

class ServiceProcessAnchor(context: Context) : SessionLingerController.ProcessAnchor {
    private val appContext = context.applicationContext

    override fun attach(controller: SessionLingerController) {
        SessionLingerService.watch { token -> controller.onAnchorLost(token) }
    }

    override fun start(token: Long): Boolean = try {
        val intent = Intent(appContext, SessionLingerService::class.java)
            .putExtra(SessionLingerService.EXTRA_TOKEN, token)
        appContext.startService(intent) != null
    } catch (_: IllegalStateException) {
        // "Not allowed to start service ...: app is in background"（API 26+）。
        false
    } catch (_: SecurityException) {
        false
    }

    override fun stop(token: Long) {
        try {
            appContext.stopService(Intent(appContext, SessionLingerService::class.java))
        } catch (_: IllegalStateException) {
            // 已经没了；控制器的记账才是真相。
        } catch (_: SecurityException) {
        }
    }
}
