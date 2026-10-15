// PairingScreen.kt — 配对流程：扫码或手输 → **先确认目标** → 兑换 → 记住连接。
//
// 二维码或深链可以替用户预填目标，但不能替用户授权：链接里只有一次性配对码，
// 手机在兑换前一定先把「哪台电脑、什么地址」摆出来让用户点确认。

package org.ompbot.companion.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.core.MOBILE_PROTOCOL
import org.ompbot.companion.core.PairOutcome
import org.ompbot.companion.core.PairingInvite
import org.ompbot.companion.core.PairingLinkResult
import org.ompbot.companion.core.PairingLinks
import org.ompbot.companion.core.ServerAddress
import kotlinx.coroutines.launch

private enum class PairingStep { CHOOSE, SCANNING, MANUAL, CONFIRM }

/** 兑换前先看这个地址上有没有 OMP Bot 的设备入口：有就继续说，没有就别把码浪费掉。 */
private sealed interface ProbeOutcome {
    data object Checking : ProbeOutcome
    data class Ready(val name: String) : ProbeOutcome
    data class WrongProtocol(val protocol: String) : ProbeOutcome
    data class Unreachable(val message: String) : ProbeOutcome
}

@Composable
fun PairingScreen(
    app: OmpBotApp,
    incoming: PairingLinkResult?,
    onDismissIncoming: () -> Unit,
) {
    val session = app.session
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(PairingStep.CHOOSE) }
    var invite by remember { mutableStateOf<PairingInvite?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var deviceName by remember { mutableStateOf("") }
    var probe by remember { mutableStateOf<ProbeOutcome>(ProbeOutcome.Checking) }
    var probeAttempt by remember { mutableStateOf(0) }

    // 确认页一出现就先探一次目标：这一步不兑换、不发送任何凭据。
    LaunchedEffect(step, invite?.address?.baseUrl, probeAttempt) {
        val pending = invite ?: return@LaunchedEffect
        if (step != PairingStep.CONFIRM) return@LaunchedEffect
        probe = ProbeOutcome.Checking
        probe = runCatching { session.probe(pending.address) }.fold(
            onSuccess = { health ->
                if (health.protocol == MOBILE_PROTOCOL) {
                    ProbeOutcome.Ready(health.name)
                } else {
                    ProbeOutcome.WrongProtocol(health.protocol.ifEmpty { "未知" })
                }
            },
            onFailure = { ProbeOutcome.Unreachable(it.message ?: "无法访问这个地址") },
        )
    }

    // 深链/扫码进来的一条邀请：解析成功就直接到确认页，失败就如实说明为什么。
    LaunchedEffect(incoming) {
        when (incoming) {
            is PairingLinkResult.Parsed -> {
                invite = incoming.invite
                error = null
                step = PairingStep.CONFIRM
            }
            is PairingLinkResult.Rejected -> {
                error = incoming.message
                step = PairingStep.CHOOSE
            }
            null -> Unit
        }
    }

    // 邀请里带了电脑侧的备注名时先填进设备名：兑换会把这个名字带回去（清空则不带，
    // 由电脑保留它自己的备注）。
    LaunchedEffect(invite?.code) {
        val pending = invite ?: return@LaunchedEffect
        if (deviceName.isBlank()) deviceName = pending.name.orEmpty()
    }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "连接电脑",
            subtitle = "手机只跟电脑上的 OMP Bot 设备入口说话",
            actions = {
                if (step != PairingStep.CHOOSE) {
                    TextButton(onClick = {
                        step = PairingStep.CHOOSE
                        invite = null
                        error = null
                        onDismissIncoming()
                    }) { Text("取消") }
                }
            },
        )

        Column(
            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            error?.let { NoticeBar(text = it, tone = MaterialTheme.colorScheme.error) }

            when (step) {
                PairingStep.SCANNING -> QrScannerScreen(
                    onCancel = { step = PairingStep.MANUAL },
                    onPayload = { payload ->
                        val result = PairingLinks.parse(payload)
                        when (result) {
                            is PairingLinkResult.Parsed -> {
                                invite = result.invite
                                error = null
                                step = PairingStep.CONFIRM
                                null
                            }
                            is PairingLinkResult.Rejected -> result.message
                        }
                    },
                )

                PairingStep.MANUAL -> ManualEntry(
                    onContinue = { addressText, codeText ->
                        val address = ServerAddress.parseManual(addressText)
                        if (address == null) {
                            error = "地址看不懂。填 IP:端口（如 192.168.1.20:3100）或完整的 http(s) 地址。"
                            return@ManualEntry
                        }
                        if (!address.transportAllowed) {
                            error = "明文 HTTP 只支持本机或局域网地址；远程地址请用 HTTPS。"
                            return@ManualEntry
                        }
                        val code = codeText.trim()
                        if (code.length < 16) {
                            error = "配对码看起来不完整（应为电脑上生成的那一长串）。"
                            return@ManualEntry
                        }
                        error = null
                        invite = PairingInvite(address = address, code = code, name = null)
                        step = PairingStep.CONFIRM
                    },
                )

                PairingStep.CONFIRM -> {
                    val pending = invite
                    if (pending == null) {
                        step = PairingStep.CHOOSE
                    } else {
                        ConfirmStep(
                            invite = pending,
                            deviceName = deviceName,
                            busy = busy,
                            probe = probe,
                            onRetryProbe = { probeAttempt += 1 },
                            onDeviceNameChange = { deviceName = it },
                            onConfirm = {
                                busy = true
                                error = null
                                scope.launch {
                                    when (val outcome = session.pair(pending, deviceName)) {
                                        is PairOutcome.Paired -> {
                                            onDismissIncoming()
                                            error = null
                                        }
                                        is PairOutcome.Failed -> {
                                            error = outcome.message
                                            step = PairingStep.CHOOSE
                                        }
                                    }
                                    busy = false
                                }
                            },
                            onBack = {
                                invite = null
                                step = PairingStep.CHOOSE
                                onDismissIncoming()
                            },
                        )
                    }
                }

                PairingStep.CHOOSE -> ChooseStep(
                    onScan = {
                        error = null
                        step = PairingStep.SCANNING
                    },
                    onManual = {
                        error = null
                        step = PairingStep.MANUAL
                    },
                )
            }
        }
    }
}

@Composable
private fun ChooseStep(onScan: () -> Unit, onManual: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(Sizes.gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("在电脑上打开 OMP Bot，进入「手机连接」，打开入口并生成二维码或配对码。", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("扫描二维码") }
        TextButton(onClick = onManual, modifier = Modifier.fillMaxWidth()) { Text("手动输入地址与配对码") }
        Text(
            "配对码一次性有效；兑换成功后手机会记住这台电脑，直到你在电脑上撤销这个设备。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ManualEntry(onContinue: (String, String) -> Unit) {
    var address by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxWidth().padding(Sizes.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("服务器地址") },
            placeholder = { Text("192.168.1.20:3100") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            label = { Text("配对码（也可改粘贴完整配对链接）") },
            singleLine = false,
            maxLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                val text = code.trim()
                if (text.startsWith("${PairingLinks.SCHEME}://")) {
                    // 粘贴的是整条链接时按链接解析，地址栏填什么都无所谓。
                    val result = PairingLinks.parse(text)
                    when (result) {
                        is PairingLinkResult.Parsed -> onContinue(result.invite.address.baseUrl, result.invite.code)
                        is PairingLinkResult.Rejected -> onContinue(address, text)
                    }
                } else {
                    onContinue(address, text)
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("继续") }
        Text(
            "地址就是电脑「手机连接」里显示的那个（默认端口 3100）。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ConfirmStep(
    invite: PairingInvite,
    deviceName: String,
    busy: Boolean,
    probe: ProbeOutcome,
    onRetryProbe: () -> Unit,
    onDeviceNameChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onBack: () -> Unit,
) {
    val blocked = probe is ProbeOutcome.WrongProtocol || probe is ProbeOutcome.Checking
    Column(modifier = Modifier.fillMaxWidth().padding(Sizes.gutter), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("确认要连接的电脑", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        when (probe) {
            ProbeOutcome.Checking -> NoticeBar("正在确认这个地址上是不是 OMP Bot 的设备入口…")
            is ProbeOutcome.Ready -> NoticeBar("已确认：${probe.name.ifBlank { "omp-bot" }} 的设备入口可达。")
            is ProbeOutcome.WrongProtocol -> NoticeBar(
                "这个地址不是 OMP Bot 的设备入口（协议 ${probe.protocol}），兑换会被拒绝。",
                tone = MaterialTheme.colorScheme.error,
            )
            is ProbeOutcome.Unreachable -> Column {
                NoticeBar(
                    "暂时连不上这个地址：${probe.message}。确认手机和电脑在同一网络，或检查入口是否已打开。",
                    tone = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = onRetryProbe) { Text("重新检测") }
            }
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("地址", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(invite.address.baseUrl, style = MaterialTheme.typography.bodyMedium)
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("电脑上的备注", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                invite.name ?: "（电脑未提供）",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("配对码", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("…${invite.code.takeLast(6)}（一次性）", style = MaterialTheme.typography.bodyMedium)
        }
        OutlinedTextField(
            value = deviceName,
            onValueChange = onDeviceNameChange,
            label = { Text("这台手机在电脑上的名字（可留空）") },
            placeholder = { Text(defaultDeviceName()) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "留空就用电脑上配对码的备注名；填了就按这个名字显示（之后可以在电脑上改）。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "权限（读取/派活/审批）由电脑上生成配对码时决定，手机端不能自行扩大；计算机上的「执行档」与「审批档」也仍然由电脑侧把关。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onBack, enabled = !busy) { Text("重新选择") }
            Button(onClick = onConfirm, enabled = !busy && !blocked) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp), strokeWidth = 2.dp)
                    Text("正在兑换…")
                } else {
                    Text("确认配对")
                }
            }
        }
    }
}

private fun defaultDeviceName(): String {
    val model = Build.MODEL?.trim().orEmpty()
    return if (model.isEmpty()) "Android 手机" else model
}
