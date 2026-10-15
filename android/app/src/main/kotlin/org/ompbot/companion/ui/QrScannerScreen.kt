// QrScannerScreen.kt — 二维码扫描（CameraX 取帧 + ML Kit 内置条码模型）。
//
// 结构与 OpenMausBot 的 app/.../ui/QrScannerScreen.kt 同源（Apache-2.0，见
// android/PROVENANCE.md）：只认 QR，扫到的东西从不自己配对 —— 解析结果交给
// [PairingScreen] 做目标确认，所以一个被操纵的二维码可以让手机预填目标，
// 但不能替用户授权。

package org.ompbot.companion.ui

import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.ompbot.companion.platform.CompanionPermissions
import java.util.concurrent.Executors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull

/**
 * @param onPayload 返回 null 表示接受并收起扫描界面；返回一段文字表示拒绝并继续扫。
 */
@Composable
fun QrScannerScreen(onCancel: () -> Unit, onPayload: (String) -> String?) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(CompanionPermissions.hasCamera(context)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { result ->
        granted = result
    }
    var validationError by remember { mutableStateOf<String?>(null) }
    var cameraFailure by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        if (!granted) permissionLauncher.launch(android.Manifest.permission.CAMERA)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        when {
            cameraFailure != null -> EmptyState(
                title = "相机打不开",
                description = cameraFailure!!,
                action = { Button(onClick = onCancel) { Text("改用手动输入") } },
            )

            !granted -> EmptyState(
                title = "需要相机权限",
                description = "允许相机权限才能扫二维码；不给也完全可以用手动输入地址与配对码。",
                action = {
                    Column {
                        Button(onClick = { permissionLauncher.launch(android.Manifest.permission.CAMERA) }) {
                            Text("允许相机权限")
                        }
                        Button(onClick = onCancel) { Text("改用手动输入") }
                    }
                },
            )

            else -> ScannerSurface(
                validate = onPayload,
                validationError = validationError,
                onValidationError = { validationError = it },
                onCameraFailure = { cameraFailure = it },
            )
        }
    }
}

@Composable
private fun ScannerSurface(
    validate: (String) -> String?,
    validationError: String?,
    onValidationError: (String?) -> Unit,
    onCameraFailure: (String) -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    // 相机在连续很多帧里都报同一个二维码。一次只锁一个载荷，被拒绝的那个等提示
    // 看清之后重新武装。
    val latched = remember { MutableStateFlow<String?>(null) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val currentValidate by rememberUpdatedState(validate)
    val cameraLifecycle = remember { CameraLifecycle() }

    LaunchedEffect(latched) {
        latched.filterNotNull().collect { payload ->
            val problem = currentValidate(payload)
            if (problem == null) return@collect
            onValidationError(problem)
            delay(800)
            latched.value = null
        }
    }

    // 取消与扫码成功都会移除这个 composable，所以一条释放路径覆盖两种情况：
    // 没有它，用例会一直绑在 Activity 生命周期上，配对表单后面 ML Kit 还在解码。
    DisposableEffect(Unit) {
        onDispose {
            cameraLifecycle.release()
            analysisExecutor.shutdown()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val previewView = PreviewView(viewContext)
                val providerFuture = ProcessCameraProvider.getInstance(viewContext)
                providerFuture.addListener(
                    {
                        try {
                            val provider = providerFuture.get()
                            val started = cameraLifecycle.startAnalyzing(
                                createAnalyzer = { QrCodeAnalyzer { payload -> latched.compareAndSet(null, payload) } },
                                releaseAnalyzer = { analyzer ->
                                    runCatching { provider.unbindAll() }
                                    analyzer.close()
                                },
                                bind = { analyzer ->
                                    bindCamera(
                                        provider = provider,
                                        lifecycleOwner = lifecycleOwner,
                                        previewView = previewView,
                                        executor = analysisExecutor,
                                        analyzer = analyzer,
                                    )
                                },
                                onFailure = { error -> Log.w(TAG, "相机绑定失败", error) },
                            )
                            if (!started) onCameraFailure(CAMERA_UNAVAILABLE)
                        } catch (error: Exception) {
                            Log.w(TAG, "相机不可用", error)
                            onCameraFailure(CAMERA_UNAVAILABLE)
                        }
                    },
                    ContextCompat.getMainExecutor(viewContext),
                )
                previewView
            },
        )

        Text(
            text = validationError ?: "把相机对准电脑上的配对二维码",
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(16.dp)
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(18.dp))
                .padding(horizontal = 18.dp, vertical = 14.dp),
        )
    }
}

/**
 * 扫描器持有的东西只释放一次。
 *
 * camera provider 来自一个 future，用户可能在它落地之前就离开：先发生的释放必须
 * 也能拆掉之后才绑上去的东西，否则相机会在空屏幕后面继续开。
 */
internal class CameraLifecycle {
    private var pendingRelease: (() -> Unit)? = null
    private var released = false

    fun bound(release: () -> Unit) {
        if (released) {
            release()
            return
        }
        pendingRelease?.invoke()
        pendingRelease = release
    }

    /** 幂等：第二次调用不会再释放一次。 */
    fun release() {
        released = true
        val pending = pendingRelease
        pendingRelease = null
        pending?.invoke()
    }
}

/**
 * 先建分析器、交给生命周期、**再**绑定。
 *
 * 顺序是重点：绑定可能抛异常（别的应用占着相机、设备没有后置摄像头），而一个建好却
 * 没注册的分析器持有一个永远没人关的 ML Kit 检测器。先注册，所有退出路径（包括抛异常
 * 那条）都会走同一套释放。
 *
 * @return 绑定时返回 false；分析器已经释放过了。
 */
internal fun <A> CameraLifecycle.startAnalyzing(
    createAnalyzer: () -> A,
    releaseAnalyzer: (A) -> Unit,
    bind: (A) -> Unit,
    onFailure: (Exception) -> Unit = {},
): Boolean {
    val analyzer = createAnalyzer()
    bound { releaseAnalyzer(analyzer) }
    return try {
        bind(analyzer)
        true
    } catch (error: Exception) {
        release()
        onFailure(error)
        false
    }
}

private const val TAG = "PairingScanner"

private const val CAMERA_UNAVAILABLE =
    "这台手机的相机没能启动。可以用系统相机读二维码，或者回去手动输入地址与配对码。"

private fun bindCamera(
    provider: ProcessCameraProvider,
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView,
    executor: java.util.concurrent.Executor,
    analyzer: ImageAnalysis.Analyzer,
) {
    val preview = Preview.Builder().build().apply { surfaceProvider = previewView.surfaceProvider }
    val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
    analysis.setAnalyzer(executor, analyzer)
    provider.unbindAll()
    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
}

/** 只认 QR：配对载荷是这个应用从相机读取的唯一东西。 */
private class QrCodeAnalyzer(private val onPayload: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
    )

    /** 释放 ML Kit 的检测器；多次调用是安全的。 */
    fun close() {
        runCatching { scanner.close() }
    }

    @ExperimentalGetImage
    override fun analyze(image: ImageProxy) {
        val frame = image.image
        if (frame == null) {
            image.close()
            return
        }
        scanner.process(InputImage.fromMediaImage(frame, image.imageInfo.rotationDegrees))
            .addOnSuccessListener { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let(onPayload) }
            .addOnCompleteListener { image.close() }
    }
}
