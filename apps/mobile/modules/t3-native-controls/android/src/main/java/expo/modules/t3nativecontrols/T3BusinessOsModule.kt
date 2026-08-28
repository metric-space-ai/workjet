package expo.modules.t3nativecontrols

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONObject

private const val BUSINESS_OS_NOTIFICATION_INTERFACE = "WorkjetBusinessOsNative"
private const val BUSINESS_OS_DEVICE_PROOF_INTERFACE = "WorkjetBusinessOsDeviceProof"
private const val BUSINESS_OS_ORIGIN = "https://appassets.androidplatform.net"
private const val BUSINESS_OS_SHELL_PROTOCOL = "workjet.business-os-shell.v1"
private const val BUSINESS_OS_SHELL_MESSAGE_MAX_BYTES = 65_536

private object WorkjetDeviceProofKey {
  private const val KEY_ALIAS = "workjet-device-proof-v1"

  private fun privateKey(): java.security.PrivateKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
    if (existing != null) return existing
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    generator.initialize(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(false)
        .setInvalidatedByBiometricEnrollment(false)
        .build(),
    )
    return generator.generateKeyPair().private
  }

  private fun publicKey(): ECPublicKey {
    privateKey()
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return keyStore.getCertificate(KEY_ALIAS).publicKey as ECPublicKey
  }

  private fun fixedCoordinate(value: BigInteger): ByteArray {
    val raw = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    require(raw.size <= 32)
    return ByteArray(32 - raw.size) + raw
  }

  private fun base64Url(value: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(value)

  fun publicJwk(): JSONObject {
    val point = publicKey().w
    return JSONObject()
      .put("kty", "EC")
      .put("crv", "P-256")
      .put("x", base64Url(fixedCoordinate(point.affineX)))
      .put("y", base64Url(fixedCoordinate(point.affineY)))
  }

  fun thumbprint(jwk: JSONObject = publicJwk()): String {
    val canonical = "{\"crv\":\"${jwk.getString(
      "crv"
    )}\",\"kty\":\"${jwk.getString(
      "kty"
    )}\",\"x\":\"${jwk.getString("x")}\",\"y\":\"${jwk.getString("y")}\"}"
    return base64Url(MessageDigest.getInstance("SHA-256").digest(canonical.encodeToByteArray()))
  }

  fun proof(message: String): JSONObject {
    require(message.isNotEmpty() && message.encodeToByteArray().size <= 4_096)
    val signer = Signature.getInstance("SHA256withECDSA")
    signer.initSign(privateKey())
    signer.update(message.encodeToByteArray())
    val jwk = publicJwk()
    return JSONObject()
      .put("publicJwk", jwk)
      .put("signature", base64Url(p1363Signature(signer.sign())))
      .put("thumbprint", thumbprint(jwk))
  }

  private fun p1363Signature(der: ByteArray): ByteArray {
    var index = 0
    fun readLength(): Int {
      require(index < der.size)
      val first = der[index++].toInt() and 0xff
      if (first and 0x80 == 0) return first
      val count = first and 0x7f
      require(count in 1..2 && index + count <= der.size)
      var length = 0
      repeat(count) { length = (length shl 8) or (der[index++].toInt() and 0xff) }
      return length
    }
    require(index < der.size && der[index++] == 0x30.toByte())
    require(readLength() == der.size - index)
    fun readInteger(): ByteArray {
      require(index < der.size && der[index++] == 0x02.toByte())
      val length = readLength()
      require(length > 0 && index + length <= der.size)
      var value = der.copyOfRange(index, index + length)
      index += length
      while (value.size > 32 &&
        value.first() == 0.toByte()
      ) {
        value = value.copyOfRange(1, value.size)
      }
      require(value.size <= 32)
      return ByteArray(32 - value.size) + value
    }
    val result = readInteger() + readInteger()
    require(index == der.size && result.size == 64)
    return result
  }
}

private fun businessOsMime(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
  "html" -> "text/html"
  "css" -> "text/css"
  "js", "mjs" -> "text/javascript"
  "json" -> "application/json"
  "svg" -> "image/svg+xml"
  "png" -> "image/png"
  "jpg", "jpeg" -> "image/jpeg"
  "wasm" -> "application/wasm"
  "woff" -> "font/woff"
  "woff2" -> "font/woff2"
  else -> "application/octet-stream"
}

private class WorkjetBusinessOsAssetHandler(
  shellRoot: File,
  private val sessionJson: String,
  private val configJson: String
) : WebViewAssetLoader.PathHandler {
  private val root = shellRoot.canonicalFile

  // These scripts are intentionally compact and byte-stable because they are injected into the
  // packaged shell. Reflowing them would add executable whitespace and obscure fixture diffs.
  @Suppress("MaxLineLength", "ktlint:standard:max-line-length")
  private fun inject(raw: ByteArray): ByteArray {
    val html = raw.decodeToString()
    val match = Regex("<head(?:\\s[^>]*)?>", RegexOption.IGNORE_CASE).find(html)
      ?: error("Business OS shell index has no head element")
    val clipboardLock = "try{Object.defineProperty(navigator,'clipboard',{value:{read:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),readText:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),write:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),writeText:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))},configurable:false})}catch(_){}"
    val notificationBridge = "try{Object.defineProperty(window,'workjetBusinessOsNotify',{value:(payload)=>{try{$BUSINESS_OS_NOTIFICATION_INTERFACE.postMessage(JSON.stringify(payload));return true}catch(_){return false}},configurable:false})}catch(_){}"
    val shellBridge = "try{Object.defineProperty(window,'workjetBusinessOsPostMessage',{value:(payload)=>{try{$BUSINESS_OS_NOTIFICATION_INTERFACE.postMessage(JSON.stringify(payload));return true}catch(_){return false}},configurable:false})}catch(_){}"
    val deviceProofBridge = "try{const pending=new Map();let sequence=0;$BUSINESS_OS_DEVICE_PROOF_INTERFACE.onmessage=(event)=>{try{const response=JSON.parse(event.data);const entry=pending.get(response.id);if(!entry)return;pending.delete(response.id);response.proof?entry.resolve(response.proof):entry.reject(new Error('device_proof_unavailable'))}catch(_){}};Object.defineProperty(globalThis,'ctoxWorkjetDeviceProofProvider',{value:(nonce)=>new Promise((resolve,reject)=>{const id=String(++sequence);pending.set(id,{resolve,reject});try{$BUSINESS_OS_DEVICE_PROOF_INTERFACE.postMessage(JSON.stringify({id,nonce}))}catch(error){pending.delete(id);reject(error)}}),writable:false,configurable:false,enumerable:false})}catch(_){}"
    val hostCommands = "window.addEventListener('message',(event)=>{if(typeof event.data!=='string')return;try{window.dispatchEvent(new CustomEvent('workjet-business-os-host-command',{detail:JSON.parse(event.data)}))}catch(_){}})"
    val mobileHost = "document.documentElement.dataset.workjetMobileHost='true'"
    val script = "<script data-workjet-mobile-bootstrap>window.CTOX_BUSINESS_OS_SESSION=$sessionJson;window.CTOX_BUSINESS_OS_CONFIG=$configJson;window.CTOX_BUSINESS_OS_DESIGN_TEMPLATES=[];$mobileHost;$clipboardLock;$notificationBridge;$shellBridge;$deviceProofBridge;$hostCommands</script>"
    val insertion = match.range.last + 1
    return (html.substring(0, insertion) + script + html.substring(insertion)).encodeToByteArray()
  }

  override fun handle(path: String): WebResourceResponse? = try {
    val clean = path.ifEmpty { "index.html" }
    require(!clean.split('/').contains(".."))
    val file = File(root, clean).canonicalFile
    require(file.path.startsWith(root.path + File.separator) && file.isFile)
    val index = clean == "index.html"
    val bytes = file.readBytes().let { if (index) inject(it) else it }
    WebResourceResponse(
      businessOsMime(clean),
      null,
      200,
      "OK",
      mapOf(
        "Cache-Control" to if (index) "no-store" else "public, max-age=31536000, immutable",
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
      ),
      ByteArrayInputStream(bytes),
    )
  } catch (_: Exception) {
    null
  }
}

class T3BusinessOsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onError by EventDispatcher()
  private val onNotification by EventDispatcher()
  private val onShellMessage by EventDispatcher()
  private var webView: WebView? = null
  private var storageIdentity = ""
  private var shellRootUri = ""
  private var sessionJson = ""
  private var configJson = ""
  private var launchKey = ""
  private var loadedKey = ""
  private var commandJson = ""

  fun setStorageIdentity(value: String) {
    storageIdentity = value
    loadIfReady()
  }
  fun setShellRootUri(value: String) {
    shellRootUri = value
    loadIfReady()
  }
  fun setSessionJson(value: String) {
    sessionJson = value
    loadIfReady()
  }
  fun setConfigJson(value: String) {
    configJson = value
    loadIfReady()
  }
  fun setLaunchKey(value: String) {
    launchKey = value
    loadIfReady()
  }
  fun setCommandJson(value: String) {
    if (!isValidHostCommand(value)) return
    commandJson = value
    deliverCommandIfReady()
  }

  // Profile selection, bridge installation, and navigation are one fail-closed launch boundary.
  @Suppress("ComplexCondition", "CyclomaticComplexMethod", "LongMethod", "ReturnCount")
  private fun loadIfReady() {
    if (storageIdentity.isEmpty() || shellRootUri.isEmpty() || sessionJson.isEmpty() ||
      configJson.isEmpty() || launchKey.isEmpty() || launchKey == loadedKey
    ) {
      return
    }
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    ) {
      onError(mapOf("code" to "multi-profile-unsupported"))
      loadedKey = launchKey
      return
    }
    val root = Uri.parse(shellRootUri).path?.let(::File)
    if (root == null || !root.isDirectory) {
      onError(mapOf("code" to "shell-root"))
      loadedKey = launchKey
      return
    }
    loadedKey = launchKey
    webView?.destroy()
    removeAllViews()

    val loader = WebViewAssetLoader.Builder()
      .setDomain("appassets.androidplatform.net")
      .addPathHandler("/business-os/", WorkjetBusinessOsAssetHandler(root, sessionJson, configJson))
      .build()
    val next = WebView(context)
    ProfileStore.getInstance().getOrCreateProfile("workjet-business-os-$storageIdentity")
    WebViewCompat.setProfile(next, "workjet-business-os-$storageIdentity")
    next.setBackgroundColor(Color.TRANSPARENT)
    next.settings.javaScriptEnabled = true
    next.settings.domStorageEnabled = true
    next.settings.allowFileAccess = false
    next.settings.allowContentAccess = false
    next.settings.setGeolocationEnabled(false)
    next.settings.mediaPlaybackRequiresUserGesture = true
    next.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    next.settings.javaScriptCanOpenWindowsAutomatically = false
    next.settings.setSupportMultipleWindows(false)
    WebViewCompat.addWebMessageListener(
      next,
      BUSINESS_OS_NOTIFICATION_INTERFACE,
      setOf(BUSINESS_OS_ORIGIN),
    ) { _, message, sourceOrigin, isMainFrame, _ ->
      if (!isMainFrame ||
        sourceOrigin.toString() != BUSINESS_OS_ORIGIN
      ) {
        return@addWebMessageListener
      }
      val raw = message.data ?: return@addWebMessageListener
      val notification = decodeSystemNotification(raw)
      if (notification != null) {
        post { onNotification(notification) }
      } else if (isValidShellMessage(raw)) {
        post { onShellMessage(mapOf("message" to raw)) }
      }
    }
    WebViewCompat.addWebMessageListener(
      next,
      BUSINESS_OS_DEVICE_PROOF_INTERFACE,
      setOf(BUSINESS_OS_ORIGIN),
    ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
      if (!isMainFrame ||
        sourceOrigin.toString() != BUSINESS_OS_ORIGIN
      ) {
        return@addWebMessageListener
      }
      val raw = message.data ?: return@addWebMessageListener
      val response = try {
        val request = JSONObject(raw)
        val id = request.optString("id").takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,32}")) }
          ?: return@addWebMessageListener
        val nonce = request.optString("nonce")
        require(nonce.matches(Regex("[A-Za-z0-9_-]{43}")))
        JSONObject().put("id", id).put("proof", WorkjetDeviceProofKey.proof(nonce))
      } catch (_: Exception) {
        val id = try {
          JSONObject(raw).optString("id").take(32)
        } catch (_: Exception) {
          ""
        }
        JSONObject().put("id", id).put("error", "device_proof_unavailable")
      }
      replyProxy.postMessage(response.toString())
    }
    next.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) = request.deny()
      override fun onGeolocationPermissionsShowPrompt(
        origin: String?,
        callback: GeolocationPermissions.Callback
      ) {
        callback.invoke(origin, false, false)
      }
    }
    next.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
      ): WebResourceResponse? =
        loader.shouldInterceptRequest(request.url)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
          uri.path?.startsWith("/business-os/") == true
        ) {
          return false
        }
        if (uri.scheme == "https" && request.isForMainFrame && request.hasGesture()) {
          context.startActivity(
            Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
        }
        return true
      }

      override fun onPageFinished(view: WebView, url: String) {
        deliverCommandIfReady()
      }
    }
    addView(
      next,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
    webView = next
    next.loadUrl("https://appassets.androidplatform.net/business-os/index.html")
  }

  private fun deliverCommandIfReady() {
    val next = webView ?: return
    if (commandJson.isEmpty()) return
    WebViewCompat.postWebMessage(
      next,
      WebMessageCompat(commandJson),
      Uri.parse(BUSINESS_OS_ORIGIN),
    )
  }

  fun cleanup() {
    webView?.destroy()
    webView = null
    removeAllViews()
  }
}

class T3BusinessOsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3BusinessOsSurface")
    View(T3BusinessOsView::class) {
      Prop("storageIdentity") { view: T3BusinessOsView, value: String ->
        view.setStorageIdentity(value)
      }
      Prop("shellRootUri") { view: T3BusinessOsView, value: String -> view.setShellRootUri(value) }
      Prop("sessionJson") { view: T3BusinessOsView, value: String -> view.setSessionJson(value) }
      Prop("configJson") { view: T3BusinessOsView, value: String -> view.setConfigJson(value) }
      Prop("launchKey") { view: T3BusinessOsView, value: String -> view.setLaunchKey(value) }
      Prop("commandJson") { view: T3BusinessOsView, value: String -> view.setCommandJson(value) }
      Events("onError", "onNotification", "onShellMessage")
      OnViewDestroys { view: T3BusinessOsView -> view.cleanup() }
    }
    AsyncFunction("removeProfile") { storageIdentity: String ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return@AsyncFunction
      val profileName = "workjet-business-os-$storageIdentity"
      ProfileStore.getInstance().deleteProfile(profileName)
    }
    AsyncFunction("getDeviceProofKey") {
      val jwk = WorkjetDeviceProofKey.publicJwk()
      mapOf(
        "publicJwk" to mapOf(
          "kty" to jwk.getString("kty"),
          "crv" to jwk.getString("crv"),
          "x" to jwk.getString("x"),
          "y" to jwk.getString("y"),
        ),
        "thumbprint" to WorkjetDeviceProofKey.thumbprint(jwk),
      )
    }
    AsyncFunction("signDeviceProofMessage") { message: String ->
      val proof = WorkjetDeviceProofKey.proof(message)
      val jwk = proof.getJSONObject("publicJwk")
      mapOf(
        "publicJwk" to mapOf(
          "kty" to jwk.getString("kty"),
          "crv" to jwk.getString("crv"),
          "x" to jwk.getString("x"),
          "y" to jwk.getString("y"),
        ),
        "signature" to proof.getString("signature"),
        "thumbprint" to proof.getString("thumbprint"),
      )
    }
    Function("isSupported") {
      WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    }
  }
}

private fun boundedNotificationText(raw: String?, maxLength: Int): String? {
  val value = raw?.trim()?.replace(Regex("\\s+"), " ")?.take(maxLength)?.trim().orEmpty()
  return value.ifEmpty { null }
}

private fun boundedNotificationToken(raw: String?, maxLength: Int): String? {
  val value = raw?.trim().orEmpty()
  return value.takeIf { it.length in 1..maxLength && it.matches(Regex("[A-Za-z0-9._:-]+")) }
}

@Suppress("ReturnCount")
private fun decodeSystemNotification(raw: String): Map<String, Any>? {
  if (raw.toByteArray().size > 1_024) return null
  return try {
    val payload = JSONObject(raw)
    if (payload.optString("kind") != "decision_hub") return null
    val title = boundedNotificationText(payload.optString("title"), 160) ?: return null
    val body = boundedNotificationText(payload.optString("body"), 240) ?: return null
    val requestedUrgency = payload.optString("urgency")
    val urgency = if (requestedUrgency in
      setOf("normal", "high", "critical")
    ) {
      requestedUrgency
    } else {
      "normal"
    }
    val event = mutableMapOf<String, Any>(
      "kind" to "decision_hub",
      "title" to title,
      "body" to body,
      "urgency" to urgency,
    )
    boundedNotificationToken(payload.optString("tag"), 180)?.let { event["tag"] = it }
    boundedNotificationToken(payload.optString("recordId"), 180)?.let { event["recordId"] = it }
    event
  } catch (_: Exception) {
    null
  }
}

private fun jsonObject(raw: String): JSONObject? {
  if (raw.toByteArray().size > BUSINESS_OS_SHELL_MESSAGE_MAX_BYTES) return null
  return try {
    JSONObject(raw).takeIf { it.optString("protocol") == BUSINESS_OS_SHELL_PROTOCOL }
  } catch (_: Exception) {
    null
  }
}

private fun JSONObject.hasOnlyKeys(allowed: Set<String>): Boolean {
  val keys = keys().asSequence().toSet()
  return keys.all { it in allowed }
}

private fun isValidHostCommand(raw: String): Boolean {
  val value = jsonObject(raw) ?: return false
  return when (value.optString("type")) {
    "host.configure" -> value.hasOnlyKeys(
      setOf("protocol", "type", "platform", "windowClass", "colorScheme", "reducedMotion", "locale")
    )
    "catalog.request", "navigation.back" -> value.hasOnlyKeys(setOf("protocol", "type"))
    "app.open", "app.close", "app.suspend", "app.resume" ->
      value.hasOnlyKeys(setOf("protocol", "type", "appId")) &&
        boundedNotificationToken(value.optString("appId"), 128) != null &&
        value.optString("appId") != "desktop"
    "action.invoke" -> value.hasOnlyKeys(setOf("protocol", "type", "appId", "actionId"))
    else -> false
  }
}

private fun isValidShellMessage(raw: String): Boolean {
  val value = jsonObject(raw) ?: return false
  return when (value.optString("type")) {
    "shell.ready" -> value.hasOnlyKeys(setOf("protocol", "type", "revision"))
    "catalog.replace" -> value.hasOnlyKeys(setOf("protocol", "type", "catalog"))
    "app.state" -> value.hasOnlyKeys(
      setOf("protocol", "type", "appId", "title", "canGoBack", "state", "actions")
    )
    "badge.update" -> value.hasOnlyKeys(setOf("protocol", "type", "appId", "count", "attention"))
    "shell.error" -> value.hasOnlyKeys(setOf("protocol", "type", "code", "retryable"))
    else -> false
  }
}
