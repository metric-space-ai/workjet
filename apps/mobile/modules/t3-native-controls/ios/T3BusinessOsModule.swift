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
    let script = "<script data-workjet-mobile-bootstrap>window.CTOX_BUSINESS_OS_SESSION=\(sessionJson);window.CTOX_BUSINESS_OS_CONFIG=\(configJson);window.CTOX_BUSINESS_OS_DESIGN_TEMPLATES=[];\(clipboardLock)</script>"
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

public final class T3BusinessOsView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onError = EventDispatcher()
  private var webView: WKWebView?
  private var storageIdentity = ""
  private var shellRootUri = ""
  private var sessionJson = ""
  private var configJson = ""
  private var launchKey = ""
  private var loadedKey = ""

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
      Events("onError")
    }
    AsyncFunction("removeProfile") { (storageIdentity: String) in
      guard let identifier = UUID(uuidString: storageIdentity) else { return }
      try await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }
    Function("isSupported") { true }
  }
}
