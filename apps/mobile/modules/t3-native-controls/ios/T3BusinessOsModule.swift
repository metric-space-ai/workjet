import ExpoModulesCore
import UIKit
import WebKit

private enum BusinessOsMimeTypes {
  static func value(for ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "json": return "application/json; charset=utf-8"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "wasm": return "application/wasm"
    case "woff": return "font/woff"
    case "woff2": return "font/woff2"
    default: return "application/octet-stream"
    }
  }
}

private let businessOsNotificationHandlerName = "workjetBusinessOsNotification"
private let businessOsShellHandlerName = "workjetBusinessOsShell"
private let businessOsShellProtocol = "workjet.business-os-shell.v1"
private let businessOsShellMessageMaxBytes = 65_536

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
    let mobileHost = "document.documentElement.dataset.workjetMobileHost='true'"
    let script = "<script data-workjet-mobile-bootstrap>window.CTOX_BUSINESS_OS_SESSION=\(sessionJson);window.CTOX_BUSINESS_OS_CONFIG=\(configJson);window.CTOX_BUSINESS_OS_DESIGN_TEMPLATES=[];\(mobileHost);\(clipboardLock);\(notificationBridge);\(shellBridge)</script>"
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
      let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: [
          "Content-Type": BusinessOsMimeTypes.value(for: file.pathExtension),
          "Cache-Control": index ? "no-store" : "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        ]
      )!
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

public final class T3BusinessOsView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onError = EventDispatcher()
  let onNotification = EventDispatcher()
  let onShellMessage = EventDispatcher()
  private var webView: WKWebView?
  private var notificationHandler: WorkjetBusinessOsNotificationHandler?
  private var shellHandler: WorkjetBusinessOsShellHandler?
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

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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
