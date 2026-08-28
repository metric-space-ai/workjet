import CryptoKit
import ExpoModulesCore
import Security
import UIKit
import WebKit

private enum BusinessOsMimeTypes {
  static func value(for ext: String) -> String {
    let values = [
      "html": "text/html; charset=utf-8",
      "css": "text/css; charset=utf-8",
      "js": "text/javascript; charset=utf-8",
      "mjs": "text/javascript; charset=utf-8",
      "json": "application/json; charset=utf-8",
      "svg": "image/svg+xml",
      "png": "image/png",
      "jpg": "image/jpeg",
      "jpeg": "image/jpeg",
      "wasm": "application/wasm",
      "woff": "font/woff",
      "woff2": "font/woff2",
    ]
    return values[ext.lowercased()] ?? "application/octet-stream"
  }
}

private let businessOsNotificationHandlerName = "workjetBusinessOsNotification"
private let businessOsShellHandlerName = "workjetBusinessOsShell"
private let businessOsDeviceProofHandlerName = "workjetBusinessOsDeviceProof"
private let businessOsShellProtocol = "workjet.business-os-shell.v1"
private let businessOsShellMessageMaxBytes = 65_536

private enum WorkjetDeviceProofKey {
  static let applicationTag = Data("com.t3tools.t3code.workjet-device-proof.v1".utf8)

  static func privateKey() throws -> SecKey {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: applicationTag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let item {
      guard CFGetTypeID(item) == SecKeyGetTypeID() else { throw CocoaError(.coderInvalidValue) }
      guard let key = item as? SecKey else { throw CocoaError(.coderInvalidValue) }
      return key
    }
    guard status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: applicationTag,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      ],
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw error?.takeRetainedValue() ?? CocoaError(.coderInvalidValue)
    }
    return key
  }

  static func publicJwk(for privateKey: SecKey) throws -> [String: String] {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw CocoaError(.coderInvalidValue) }
    var error: Unmanaged<CFError>?
    guard let representation = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw error?.takeRetainedValue() ?? CocoaError(.coderInvalidValue)
    }
    guard representation.count == 65, representation.first == 0x04 else {
      throw CocoaError(.coderInvalidValue)
    }
    return [
      "kty": "EC",
      "crv": "P-256",
      "x": base64Url(representation.subdata(in: 1..<33)),
      "y": base64Url(representation.subdata(in: 33..<65)),
    ]
  }

  static func proof(message: String) throws -> [String: Any] {
    let key = try privateKey()
    let publicJwk = try publicJwk(for: key)
    var error: Unmanaged<CFError>?
    guard let der = SecKeyCreateSignature(
      key,
      .ecdsaSignatureMessageX962SHA256,
      Data(message.utf8) as CFData,
      &error
    ) as Data? else {
      throw error?.takeRetainedValue() ?? CocoaError(.coderInvalidValue)
    }
    return [
      "publicJwk": publicJwk,
      "signature": base64Url(try p1363Signature(fromDer: der)),
      "thumbprint": try thumbprint(publicJwk),
    ]
  }

  static func descriptor() throws -> [String: Any] {
    let publicJwk = try publicJwk(for: privateKey())
    return ["publicJwk": publicJwk, "thumbprint": try thumbprint(publicJwk)]
  }

  private static func base64Url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func thumbprint(_ jwk: [String: String]) throws -> String {
    guard let crv = jwk["crv"], let kty = jwk["kty"], let x = jwk["x"], let y = jwk["y"] else {
      throw CocoaError(.coderInvalidValue)
    }
    let canonical = Data("{\"crv\":\"\(crv)\",\"kty\":\"\(kty)\",\"x\":\"\(x)\",\"y\":\"\(y)\"}".utf8)
    return base64Url(Data(SHA256.hash(data: canonical)))
  }

  private static func p1363Signature(fromDer der: Data) throws -> Data {
    let bytes = [UInt8](der)
    var index = 0
    func readLength() throws -> Int {
      guard index < bytes.count else { throw CocoaError(.coderInvalidValue) }
      let first = Int(bytes[index]); index += 1
      if first & 0x80 == 0 { return first }
      let count = first & 0x7f
      guard count > 0, count <= 2, index + count <= bytes.count else { throw CocoaError(.coderInvalidValue) }
      var length = 0
      for _ in 0..<count { length = (length << 8) | Int(bytes[index]); index += 1 }
      return length
    }
    guard index < bytes.count, bytes[index] == 0x30 else { throw CocoaError(.coderInvalidValue) }
    index += 1
    let sequenceLength = try readLength()
    guard sequenceLength == bytes.count - index else { throw CocoaError(.coderInvalidValue) }
    func readInteger() throws -> [UInt8] {
      guard index < bytes.count, bytes[index] == 0x02 else { throw CocoaError(.coderInvalidValue) }
      index += 1
      let length = try readLength()
      guard length > 0, index + length <= bytes.count else { throw CocoaError(.coderInvalidValue) }
      var value = Array(bytes[index..<(index + length)]); index += length
      while value.count > 32 && value.first == 0 { value.removeFirst() }
      guard value.count <= 32 else { throw CocoaError(.coderInvalidValue) }
      return Array(repeating: 0, count: 32 - value.count) + value
    }
    let r = try readInteger()
    let s = try readInteger()
    guard index == bytes.count else { throw CocoaError(.coderInvalidValue) }
    return Data(r + s)
  }
}

@MainActor
private final class WorkjetBusinessOsSchemeHandler: NSObject, WKURLSchemeHandler {
  private let storageIdentity: String
  private let shellRoot: URL
  private let sessionJson: String
  private let configJson: String
  private var stopped = Set<ObjectIdentifier>()

  init(storageIdentity: String, shellRoot: URL, sessionJson: String, configJson: String) {
    self.storageIdentity = storageIdentity
    self.shellRoot = shellRoot.standardizedFileURL
    self.sessionJson = sessionJson
    self.configJson = configJson
  }

  private func inject(_ raw: Data) throws -> Data {
    guard let html = String(data: raw, encoding: .utf8),
      let head = html.range(of: #"<head(?:\s[^>]*)?>"#, options: [.regularExpression, .caseInsensitive])
    else { throw CocoaError(.fileReadCorruptFile) }
    let clipboardLock = "try{Object.defineProperty(navigator,'clipboard',{value:{read:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),readText:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),write:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),writeText:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))},configurable:false})}catch(_){}"
    let notificationBridge = "try{Object.defineProperty(window,'workjetBusinessOsNotify',{value:(payload)=>{try{window.webkit.messageHandlers.\(businessOsNotificationHandlerName).postMessage(payload);return true}catch(_){return false}},configurable:false})}catch(_){}"
    let shellBridge = "try{Object.defineProperty(window,'workjetBusinessOsPostMessage',{value:(payload)=>{try{window.webkit.messageHandlers.\(businessOsShellHandlerName).postMessage(JSON.stringify(payload));return true}catch(_){return false}},configurable:false})}catch(_){}"
    let deviceProofBridge = "try{Object.defineProperty(globalThis,'ctoxWorkjetDeviceProofProvider',{value:(nonce)=>window.webkit.messageHandlers.\(businessOsDeviceProofHandlerName).postMessage(nonce),writable:false,configurable:false,enumerable:false})}catch(_){}"
    let mobileHost = "document.documentElement.dataset.workjetMobileHost='true'"
    let script = "<script data-workjet-mobile-bootstrap>window.CTOX_BUSINESS_OS_SESSION=\(sessionJson);window.CTOX_BUSINESS_OS_CONFIG=\(configJson);window.CTOX_BUSINESS_OS_DESIGN_TEMPLATES=[];\(mobileHost);\(clipboardLock);\(notificationBridge);\(shellBridge);\(deviceProofBridge)</script>"
    return Data((html[..<head.upperBound] + script + html[head.upperBound...]).utf8)
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let identifier = ObjectIdentifier(urlSchemeTask)
    do {
      guard let url = urlSchemeTask.request.url,
        url.host == storageIdentity,
        url.path.hasPrefix("/business-os/")
      else { throw CocoaError(.fileReadNoPermission) }
      let relative = String(url.path.dropFirst("/business-os/".count))
      guard !relative.split(separator: "/").contains("..") else { throw CocoaError(.fileReadNoPermission) }
      let file = shellRoot.appending(path: relative.isEmpty ? "index.html" : relative).standardizedFileURL
      guard file.path.hasPrefix(shellRoot.path + "/") else { throw CocoaError(.fileReadNoPermission) }
      let raw = try Data(contentsOf: file)
      let index = relative.isEmpty || relative == "index.html"
      let data = index ? try inject(raw) : raw
      guard !stopped.contains(identifier) else { return }
      guard let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: [
          "Content-Type": BusinessOsMimeTypes.value(for: file.pathExtension),
          "Cache-Control": index ? "no-store" : "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        ]
      ) else { throw CocoaError(.coderInvalidValue) }
      urlSchemeTask.didReceive(response)
      urlSchemeTask.didReceive(data)
      urlSchemeTask.didFinish()
    } catch {
      guard !stopped.contains(identifier) else { return }
      urlSchemeTask.didFailWithError(error)
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    stopped.insert(ObjectIdentifier(urlSchemeTask))
  }
}

@MainActor
private final class WorkjetBusinessOsNotificationHandler: NSObject, WKScriptMessageHandler {
  weak var owner: T3BusinessOsView?

  init(owner: T3BusinessOsView) {
    self.owner = owner
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    owner?.receiveSystemNotification(message.body)
  }
}

@MainActor
private final class WorkjetBusinessOsShellHandler: NSObject, WKScriptMessageHandler {
  weak var owner: T3BusinessOsView?

  init(owner: T3BusinessOsView) {
    self.owner = owner
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    owner?.receiveShellMessage(message.body)
  }
}

@MainActor
private final class WorkjetBusinessOsDeviceProofHandler: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: T3BusinessOsView?

  init(owner: T3BusinessOsView) {
    self.owner = owner
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    guard let owner, owner.acceptsDeviceProofMessage(message),
      let nonce = message.body as? String,
      nonce.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
    else {
      replyHandler(nil, "invalid_device_proof_request")
      return
    }
    do {
      replyHandler(try WorkjetDeviceProofKey.proof(message: nonce), nil)
    } catch {
      replyHandler(nil, "device_proof_unavailable")
    }
  }
}

public final class T3BusinessOsView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onError = EventDispatcher()
  let onNotification = EventDispatcher()
  let onShellMessage = EventDispatcher()
  private var webView: WKWebView?
  private var notificationHandler: WorkjetBusinessOsNotificationHandler?
  private var shellHandler: WorkjetBusinessOsShellHandler?
  private var deviceProofHandler: WorkjetBusinessOsDeviceProofHandler?
  private var storageIdentity = ""
  private var shellRootUri = ""
  private var sessionJson = ""
  private var configJson = ""
  private var launchKey = ""
  private var loadedKey = ""
  private var commandJson = ""

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
  }

  func setStorageIdentity(_ value: String) { storageIdentity = value; loadIfReady() }
  func setShellRootUri(_ value: String) { shellRootUri = value; loadIfReady() }
  func setSessionJson(_ value: String) { sessionJson = value; loadIfReady() }
  func setConfigJson(_ value: String) { configJson = value; loadIfReady() }
  func setLaunchKey(_ value: String) { launchKey = value; loadIfReady() }
  func setCommandJson(_ value: String) {
    guard isValidHostCommand(value) else { return }
    commandJson = value
    deliverCommandIfReady()
  }

  private func loadIfReady() {
    guard !storageIdentity.isEmpty, !shellRootUri.isEmpty, !sessionJson.isEmpty,
      !configJson.isEmpty, !launchKey.isEmpty, loadedKey != launchKey,
      let identifier = UUID(uuidString: storageIdentity),
      let shellRoot = URL(string: shellRootUri), shellRoot.isFileURL
    else { return }
    loadedKey = launchKey
    webView?.removeFromSuperview()
    webView = nil

    let configuration = WKWebViewConfiguration()
    let nextNotificationHandler = WorkjetBusinessOsNotificationHandler(owner: self)
    configuration.userContentController.add(
      nextNotificationHandler,
      name: businessOsNotificationHandlerName
    )
    notificationHandler = nextNotificationHandler
    let nextShellHandler = WorkjetBusinessOsShellHandler(owner: self)
    configuration.userContentController.add(nextShellHandler, name: businessOsShellHandlerName)
    shellHandler = nextShellHandler
    let nextDeviceProofHandler = WorkjetBusinessOsDeviceProofHandler(owner: self)
    configuration.userContentController.addScriptMessageHandler(
      nextDeviceProofHandler,
      contentWorld: .page,
      name: businessOsDeviceProofHandlerName
    )
    deviceProofHandler = nextDeviceProofHandler
    configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: identifier)
    configuration.setURLSchemeHandler(
      WorkjetBusinessOsSchemeHandler(
        storageIdentity: storageIdentity,
        shellRoot: shellRoot,
        sessionJson: sessionJson,
        configJson: configJson
      ),
      forURLScheme: "workjet-business-os"
    )
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    let next = WKWebView(frame: bounds, configuration: configuration)
    next.navigationDelegate = self
    next.uiDelegate = self
    next.allowsBackForwardNavigationGestures = false
    addSubview(next)
    webView = next
    guard let url = URL(string: "workjet-business-os://\(storageIdentity)/business-os/index.html") else {
      onError(["code": "origin"])
      return
    }
    next.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
  }

  fileprivate func receiveSystemNotification(_ raw: Any) {
    guard let payload = raw as? [String: Any],
      payload["kind"] as? String == "decision_hub",
      let title = boundedNotificationText(payload["title"], maxLength: 160),
      let body = boundedNotificationText(payload["body"], maxLength: 240)
    else { return }
    let requestedUrgency = payload["urgency"] as? String ?? ""
    let urgency = ["normal", "high", "critical"].contains(requestedUrgency)
      ? requestedUrgency
      : "normal"
    var event: [String: Any] = [
      "kind": "decision_hub",
      "title": title,
      "body": body,
      "urgency": urgency,
    ]
    if let tag = boundedNotificationToken(payload["tag"], maxLength: 180) { event["tag"] = tag }
    if let recordId = boundedNotificationToken(payload["recordId"], maxLength: 180) {
      event["recordId"] = recordId
    }
    onNotification(event)
  }

  fileprivate func receiveShellMessage(_ raw: Any) {
    guard let value = raw as? String, isValidShellMessage(value) else { return }
    onShellMessage(["message": value])
  }

  fileprivate func acceptsDeviceProofMessage(_ message: WKScriptMessage) -> Bool {
    let origin = message.frameInfo.securityOrigin
    return message.frameInfo.isMainFrame
      && origin.protocol == "workjet-business-os"
      && origin.host == storageIdentity
  }

  private func deliverCommandIfReady() {
    guard let webView, !commandJson.isEmpty else { return }
    Task { @MainActor in
      _ = try? await webView.callAsyncJavaScript(
        "window.dispatchEvent(new CustomEvent('workjet-business-os-host-command',{detail:JSON.parse(command)}));return true;",
        arguments: ["command": commandJson],
        in: nil,
        contentWorld: .page
      )
    }
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
    deliverCommandIfReady()
  }

  public func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    let ownOrigin = url.scheme == "workjet-business-os" && url.host == storageIdentity && url.path.hasPrefix("/business-os/")
    if ownOrigin && action.targetFrame != nil { decisionHandler(.allow); return }
    if url.scheme == "https", action.navigationType == .linkActivated {
      UIApplication.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  public func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? { nil }

  public func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) { decisionHandler(.deny) }
}

public final class T3BusinessOsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3BusinessOsSurface")
    View(T3BusinessOsView.self) {
      Prop("storageIdentity") { (view: T3BusinessOsView, value: String) in view.setStorageIdentity(value) }
      Prop("shellRootUri") { (view: T3BusinessOsView, value: String) in view.setShellRootUri(value) }
      Prop("sessionJson") { (view: T3BusinessOsView, value: String) in view.setSessionJson(value) }
      Prop("configJson") { (view: T3BusinessOsView, value: String) in view.setConfigJson(value) }
      Prop("launchKey") { (view: T3BusinessOsView, value: String) in view.setLaunchKey(value) }
      Prop("commandJson") { (view: T3BusinessOsView, value: String) in view.setCommandJson(value) }
      Events("onError", "onNotification", "onShellMessage")
    }
    AsyncFunction("removeProfile") { (storageIdentity: String) in
      guard let identifier = UUID(uuidString: storageIdentity) else { return }
      try await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }
    AsyncFunction("getDeviceProofKey") {
      try WorkjetDeviceProofKey.descriptor()
    }
    AsyncFunction("signDeviceProofMessage") { (message: String) in
      guard !message.isEmpty, message.utf8.count <= 4_096 else {
        throw CocoaError(.coderInvalidValue)
      }
      return try WorkjetDeviceProofKey.proof(message: message)
    }
    Function("isSupported") { true }
  }
}

private func boundedNotificationText(_ raw: Any?, maxLength: Int) -> String? {
  guard let raw = raw as? String else { return nil }
  let value = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  guard !value.isEmpty else { return nil }
  return String(value.prefix(maxLength))
}

private func boundedNotificationToken(_ raw: Any?, maxLength: Int) -> String? {
  guard let raw = raw as? String, !raw.isEmpty, raw.count <= maxLength else { return nil }
  let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-")
  return raw.unicodeScalars.allSatisfy(allowed.contains) ? raw : nil
}

private func jsonObject(_ raw: String) -> [String: Any]? {
  guard let data = raw.data(using: .utf8), data.count <= businessOsShellMessageMaxBytes,
    let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    value["protocol"] as? String == businessOsShellProtocol
  else { return nil }
  return value
}

private func hasOnlyKeys(_ object: [String: Any], _ allowed: Set<String>) -> Bool {
  Set(object.keys).isSubset(of: allowed)
}

private func isValidHostCommand(_ raw: String) -> Bool {
  guard let value = jsonObject(raw), let type = value["type"] as? String else { return false }
  switch type {
  case "host.configure":
    return hasOnlyKeys(value, ["protocol", "type", "platform", "windowClass", "colorScheme", "reducedMotion", "locale"])
  case "catalog.request", "navigation.back":
    return hasOnlyKeys(value, ["protocol", "type"])
  case "app.open", "app.close", "app.suspend", "app.resume":
    return hasOnlyKeys(value, ["protocol", "type", "appId"])
      && boundedNotificationToken(value["appId"], maxLength: 128) != nil
      && value["appId"] as? String != "desktop"
  case "action.invoke":
    return hasOnlyKeys(value, ["protocol", "type", "appId", "actionId"])
  default:
    return false
  }
}

private func isValidShellMessage(_ raw: String) -> Bool {
  guard let value = jsonObject(raw), let type = value["type"] as? String else { return false }
  switch type {
  case "shell.ready":
    return hasOnlyKeys(value, ["protocol", "type", "revision"])
  case "catalog.replace":
    return hasOnlyKeys(value, ["protocol", "type", "catalog"])
  case "app.state":
    return hasOnlyKeys(value, ["protocol", "type", "appId", "title", "canGoBack", "state", "actions"])
  case "badge.update":
    return hasOnlyKeys(value, ["protocol", "type", "appId", "count", "attention"])
  case "shell.error":
    return hasOnlyKeys(value, ["protocol", "type", "code", "retryable"])
  default:
    return false
  }
}
