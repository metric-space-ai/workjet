import ExpoModulesCore
import Security
import UIKit

public final class T3NativeControlsModule: Module {
  private var businessOsProtectionEnabled = false
  private var privacyOverlay: UIView?
  private var observers: [NSObjectProtocol] = []

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first { $0.isKeyWindow }
  }

  private func showPrivacyOverlay() {
    guard businessOsProtectionEnabled, privacyOverlay == nil, let window = keyWindow() else { return }
    let overlay = UIView(frame: window.bounds)
    overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    overlay.backgroundColor = .systemBackground
    overlay.accessibilityLabel = "Protected Workjet content"
    window.addSubview(overlay)
    privacyOverlay = overlay
  }

  private func hidePrivacyOverlay() {
    privacyOverlay?.removeFromSuperview()
    privacyOverlay = nil
  }

  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    Function("getShowcasePairingUrl") {
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcasePairingUrl"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseScene") { () -> String? in
      let scenePath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseScene"
      if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
        return storedScene
      }
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseScene"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseOrientation") { () -> String? in
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseOrientation"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    // Rotates the interface without Simulator menu UI scripting, which CI
    // runners cannot perform (osascript is denied Accessibility access there).
    AsyncFunction("applyShowcaseOrientation") { (orientation: String) in
      guard #available(iOS 16.0, *) else { return }
      let mask: UIInterfaceOrientationMask = orientation == "landscape" ? .landscapeRight : .portrait
      for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
        windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
          NSLog("T3NativeControls applyShowcaseOrientation(\(orientation)) failed: \(error)")
        }
        for window in windowScene.windows {
          window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
      }
    }.runOnQueue(.main)

    // The geometry request above can fail transiently (for example before the
    // scene is foreground-active), so callers poll this until it settles.
    // Screen bounds — not the scene's interface orientation — decide the
    // answer because they match the captured framebuffer: with iPadOS
    // windowing active, a floating landscape window still reports a portrait
    // screen, and screenshots would come out portrait.
    AsyncFunction("getInterfaceOrientation") { () -> String in
      guard
        let windowScene = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first
      else {
        return "unknown"
      }
      let bounds = windowScene.screen.coordinateSpace.bounds
      return bounds.width > bounds.height ? "landscape" : "portrait"
    }.runOnQueue(.main)

    Function("prepareShowcaseCapture") {
      for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
        SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
      }
    }

    Function("markShowcaseReady") { (scene: String) in
      let readyPath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseReadyScene"
      try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
    }

    Function("setBusinessOsContentProtected") { (enabled: Bool) in
      DispatchQueue.main.async {
        self.businessOsProtectionEnabled = enabled
        if enabled {
          if UIApplication.shared.applicationState != .active || UIScreen.main.isCaptured {
            self.showPrivacyOverlay()
          }
        } else {
          self.hidePrivacyOverlay()
        }
      }
    }

    OnCreate {
      let center = NotificationCenter.default
      self.observers = [
        center.addObserver(
          forName: UIApplication.willResignActiveNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in self?.showPrivacyOverlay() },
        center.addObserver(
          forName: UIApplication.didBecomeActiveNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          guard UIScreen.main.isCaptured == false else { return }
          self?.hidePrivacyOverlay()
        },
        center.addObserver(
          forName: UIScreen.capturedDidChangeNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          if UIScreen.main.isCaptured {
            self?.showPrivacyOverlay()
          } else if UIApplication.shared.applicationState == .active {
            self?.hidePrivacyOverlay()
          }
        },
      ]
    }

    OnDestroy {
      self.observers.forEach(NotificationCenter.default.removeObserver)
      self.observers = []
      self.hidePrivacyOverlay()
    }
  }
}
