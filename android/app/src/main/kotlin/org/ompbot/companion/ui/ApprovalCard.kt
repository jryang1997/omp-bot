// ApprovalCard.kt — 原生审批的四种可作答形状（选项/确认/文本/多问题表单）。
//
// 这里不是「装饰性控件」：每个控件提交的 JSON 就是 src/orchestrator.mjs 的
// validateUiResponse 会逐字校验的形状（value / confirmed / answers），选项类还要
// 命中审批自己的 options。过期、已应答、设备没有审批权限时只展示，不给假按钮。

package org.ompbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.ompbot.companion.core.Approval
import org.ompbot.companion.core.ApprovalAnswer
import org.ompbot.companion.core.ApprovalShape
import org.ompbot.companion.core.ApprovalShapes
import org.ompbot.companion.core.FormAnswer
import org.ompbot.companion.core.FormValue

@Composable
fun ApprovalCard(
    approval: Approval,
    canApprove: Boolean,
    busy: Boolean,
    onSubmit: (ApprovalAnswer) -> Unit,
) {
    val shape = ApprovalShapes.shape(approval)
    val expired = approval.isExpired()
    val answered = !approval.isPending

    var chosen by remember(approval.id) { mutableStateOf<String?>(null) }
    var text by remember(approval.id) { mutableStateOf("") }
    val singleAnswers = remember(approval.id) { mutableStateMapOf<Int, String>() }
    val multiAnswers = remember(approval.id) { mutableStateMapOf<Int, Set<String>>() }

    fun formAnswers(): List<FormAnswer> = approval.questions.orEmpty().mapIndexed { index, question ->
        val header = question.label
        if (question.multiSelect) {
            FormAnswer(header, FormValue.Many(multiAnswers[index].orEmpty().toList()))
        } else {
            FormAnswer(header, FormValue.Single(singleAnswers[index].orEmpty()))
        }
    }

    val submittable = !expired && !answered && canApprove && !busy && when (shape) {
        ApprovalShape.OPTIONS -> chosen != null
        ApprovalShape.CONFIRM -> true
        ApprovalShape.TEXT -> text.isNotBlank()
        ApprovalShape.FORM -> ApprovalShapes.formComplete(formAnswers(), approval)
        ApprovalShape.MESSAGE, ApprovalShape.UNSUPPORTED -> false
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Sizes.gutter, vertical = 4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), RoundedCornerShape(Sizes.corner))
            .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.35f), RoundedCornerShape(Sizes.corner))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            if (approval.isToolApproval) "这一步需要你允许" else approval.title ?: "需要你回答",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
        )
        if (approval.isToolApproval) {
            Text(approval.toolApprovalText(), style = MaterialTheme.typography.bodySmall)
        }
        approval.message?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
        approval.expiresAt?.takeIf { it > 0 }?.let {
            Text(
                "有效期至 ${org.ompbot.companion.core.formatClock(it)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when {
            expired -> NoticeBar("这条请求已经过期，不能替你作答。", tone = MaterialTheme.colorScheme.error)
            answered -> NoticeBar("已经应答过了。")
            !canApprove -> NoticeBar("这个设备没有审批权限，需要在电脑上回答。", tone = MaterialTheme.colorScheme.error)
        }

        when (shape) {
            ApprovalShape.OPTIONS -> OptionList(approval, chosen, enabled = !expired && !answered && canApprove && !busy) { chosen = it }
            ApprovalShape.CONFIRM -> Unit
            ApprovalShape.TEXT -> OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                enabled = !expired && !answered && canApprove && !busy,
                label = { Text(if (approval.method == "editor") "输入内容" else "回答") },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            )
            ApprovalShape.FORM -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                approval.questions.orEmpty().forEachIndexed { index, question ->
                    val options = ApprovalShapes.questionOptions(question)
                    Text(question.label, style = MaterialTheme.typography.labelLarge)
                    if (options.isEmpty()) {
                        OutlinedTextField(
                            value = singleAnswers[index].orEmpty(),
                            onValueChange = { singleAnswers[index] = it },
                            enabled = !expired && !answered && canApprove && !busy,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            options.forEach { option ->
                                val selected = if (question.multiSelect) {
                                    multiAnswers[index].orEmpty().contains(option.value)
                                } else {
                                    singleAnswers[index] == option.value
                                }
                                ChoiceRow(
                                    label = option.label,
                                    description = option.description,
                                    selected = selected,
                                    enabled = !expired && !answered && canApprove && !busy,
                                ) {
                                    if (question.multiSelect) {
                                        val current = multiAnswers[index].orEmpty()
                                        multiAnswers[index] =
                                            if (current.contains(option.value)) current - option.value else current + option.value
                                    } else {
                                        singleAnswers[index] = option.value
                                    }
                                }
                            }
                        }
                    }
                }
            }
            ApprovalShape.MESSAGE -> Text("这条请求只需要你知道，不用作答。", style = MaterialTheme.typography.bodySmall)
            ApprovalShape.UNSUPPORTED -> Text(
                "这种原生请求（${approval.method ?: "未知"}）需要电脑上的专用流程，手机不代答。",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        if (shape != ApprovalShape.MESSAGE && shape != ApprovalShape.UNSUPPORTED) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = { onSubmit(ApprovalAnswer.Cancelled) },
                    enabled = !expired && !answered && canApprove && !busy,
                ) { Text("取消这一步") }

                if (shape == ApprovalShape.CONFIRM) {
                    TextButton(onClick = { onSubmit(ApprovalAnswer.Confirmed(false)) }, enabled = submittable) { Text("拒绝") }
                    Button(onClick = { onSubmit(ApprovalAnswer.Confirmed(true)) }, enabled = submittable) { Text("确认") }
                } else {
                    Button(
                        onClick = {
                            when (shape) {
                                ApprovalShape.OPTIONS -> chosen?.let { onSubmit(ApprovalAnswer.Value(it)) }
                                ApprovalShape.TEXT -> onSubmit(ApprovalAnswer.Value(text.trim()))
                                ApprovalShape.FORM -> onSubmit(ApprovalAnswer.Form(formAnswers()))
                                else -> Unit
                            }
                        },
                        enabled = submittable,
                    ) { Text(if (shape == ApprovalShape.FORM) "提交回答" else "提交") }
                }
            }
        }
    }
}

@Composable
private fun OptionList(
    approval: Approval,
    chosen: String?,
    enabled: Boolean,
    onChoose: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        approval.optionValues.forEachIndexed { index, value ->
            val option = approval.optionLabel(index)
            ChoiceRow(
                label = option.label,
                description = option.description,
                selected = chosen == value,
                enabled = enabled,
            ) { onChoose(value) }
        }
    }
}

@Composable
private fun ChoiceRow(
    label: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
    val background = if (selected) {
        MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
    } else {
        Color.Transparent
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(background, RoundedCornerShape(10.dp))
            .border(1.dp, border, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (description.isNotBlank()) {
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
