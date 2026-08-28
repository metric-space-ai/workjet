import ExpoModulesCore
import SwiftUI
import UniformTypeIdentifiers

private struct WorkjetLauncherApp: Codable, Identifiable, Hashable {
  let id: String
  let title: String
  let accent: String
  let iconAssetId: String
  let iconFamilyVersion: Int
  let iconRequired: Bool
  let phoneReady: Bool
  let tabletReady: Bool
  let desktopOnly: Bool?
}

private struct WorkjetLauncherCatalog: Codable {
  let apps: [WorkjetLauncherApp]
}

private struct WorkjetLauncherItem: Codable, Identifiable, Hashable {
  let kind: String
  let id: String
  let appId: String?
  let title: String?
  let appIds: [String]?
}

private struct WorkjetLauncherLayout: Codable {
  let pages: [[WorkjetLauncherItem]]
  let dock: [String]
}

@MainActor
private final class WorkjetLauncherModel: ObservableObject {
  @Published var apps: [WorkjetLauncherApp] = []
  @Published var pages: [[WorkjetLauncherItem]] = [[]]
  @Published var dock: [String] = []
  @Published var badges: [String: Int] = [:]
  @Published var instanceName = "Business OS"
  @Published var editing = false
  @Published var activePage = 0
  @Published var dragged: (page: Int, index: Int)?
  @Published var showsSettingsAction = true

  var onOpenApp: ((String) -> Void)?
  var onOpenSearch: (() -> Void)?
  var onOpenRecents: (() -> Void)?
  var onOpenSettings: (() -> Void)?
  var onReturnToCode: (() -> Void)?
  var onLayoutChange: ((Int, Int, Int) -> Void)?

  var appsById: [String: WorkjetLauncherApp] {
    Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0) })
  }

  func updateCatalog(_ raw: String) {
    let allowedKeys: Set<String> = [
      "id", "title", "category", "iconAssetId", "iconFamilyVersion", "iconRequired", "accent",
      "mobilePresentation", "phoneReady", "tabletReady", "desktopOnly",
    ]
    guard let data = raw.data(using: .utf8), data.count <= 262_144,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let rawApps = object["apps"] as? [[String: Any]],
      rawApps.count <= 256,
      rawApps.allSatisfy({ Set($0.keys).isSubset(of: allowedKeys) }),
      let catalog = try? JSONDecoder().decode(WorkjetLauncherCatalog.self, from: data),
      catalog.apps.allSatisfy({
        $0.id != "desktop" && workjetSafeIdentifier($0.id) && workjetSafeIdentifier($0.iconAssetId)
          && $0.iconFamilyVersion == 1 && !$0.title.isEmpty && $0.title.count <= 80
      })
    else { return }
    apps = catalog.apps
  }

  func updateLayout(_ raw: String) {
    guard let data = raw.data(using: .utf8), data.count <= 262_144,
      let layout = try? JSONDecoder().decode(WorkjetLauncherLayout.self, from: data)
    else { return }
    pages = layout.pages.isEmpty ? [[]] : layout.pages
    dock = layout.dock.filter { $0 != "desktop" }
    activePage = min(activePage, max(0, pages.count - 1))
  }

  func updateBadges(_ raw: String) {
    guard let data = raw.data(using: .utf8), data.count <= 16_384,
      let value = try? JSONDecoder().decode([String: Int].self, from: data)
    else { return }
    badges = value.filter { $0.key != "desktop" && $0.value > 0 && $0.value <= 999 }
  }
}

private func workjetSafeIdentifier(_ value: String) -> Bool {
  guard let first = value.unicodeScalars.first, value.count <= 128,
    CharacterSet.alphanumerics.contains(first)
  else { return false }
  let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789._-")
  return value.unicodeScalars.allSatisfy(allowed.contains)
}

@MainActor
public final class T3BusinessOsLauncherView: ExpoView {
  private let model = WorkjetLauncherModel()
  private let hostingController: UIHostingController<WorkjetNativeLauncher>
  private let onOpenApp = EventDispatcher()
  private let onOpenSearch = EventDispatcher()
  private let onOpenRecents = EventDispatcher()
  private let onOpenSettings = EventDispatcher()
  private let onReturnToCode = EventDispatcher()
  private let onLayoutChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    hostingController = UIHostingController(rootView: WorkjetNativeLauncher(model: model))
    super.init(appContext: appContext)
    hostingController.view.backgroundColor = .clear
    addSubview(hostingController.view)
    model.onOpenApp = { [weak self] appId in self?.onOpenApp(["appId": appId]) }
    model.onOpenSearch = { [weak self] in self?.onOpenSearch([:]) }
    model.onOpenRecents = { [weak self] in self?.onOpenRecents([:]) }
    model.onOpenSettings = { [weak self] in self?.onOpenSettings([:]) }
    model.onReturnToCode = { [weak self] in self?.onReturnToCode([:]) }
    model.onLayoutChange = { [weak self] pageIndex, sourceIndex, targetIndex in
      self?.onLayoutChange([
        "pageIndex": pageIndex,
        "sourceIndex": sourceIndex,
        "targetIndex": targetIndex,
      ])
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    hostingController.view.frame = bounds
  }

  func setCatalogJson(_ value: String) { model.updateCatalog(value) }
  func setLayoutJson(_ value: String) { model.updateLayout(value) }
  func setBadgesJson(_ value: String) { model.updateBadges(value) }
  func setInstanceName(_ value: String) {
    let next = value.trimmingCharacters(in: .whitespacesAndNewlines)
    model.instanceName = next.isEmpty ? "Business OS" : String(next.prefix(80))
  }
  func setShowsSettingsAction(_ value: Bool) { model.showsSettingsAction = value }
}

public final class T3BusinessOsLauncherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3BusinessOsLauncher")
    View(T3BusinessOsLauncherView.self) {
      Prop("catalogJson") { (view: T3BusinessOsLauncherView, value: String) in view.setCatalogJson(value) }
      Prop("layoutJson") { (view: T3BusinessOsLauncherView, value: String) in view.setLayoutJson(value) }
      Prop("badgesJson") { (view: T3BusinessOsLauncherView, value: String) in view.setBadgesJson(value) }
      Prop("instanceName") { (view: T3BusinessOsLauncherView, value: String) in view.setInstanceName(value) }
      Prop("showsSettingsAction") { (view: T3BusinessOsLauncherView, value: Bool) in
        view.setShowsSettingsAction(value)
      }
      Events(
        "onOpenApp",
        "onOpenSearch",
        "onOpenRecents",
        "onOpenSettings",
        "onReturnToCode",
        "onLayoutChange"
      )
    }
    Function("isSupported") { true }
  }
}

@available(iOS 26.0, *)
private struct WorkjetNativeLauncher: View {
  @ObservedObject var model: WorkjetLauncherModel

  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Color(uiColor: .systemBackground).ignoresSafeArea()
        RadialGradient(
          colors: [Color.accentColor.opacity(0.09), .clear],
          center: .topTrailing,
          startRadius: 16,
          endRadius: max(geometry.size.width, geometry.size.height) * 0.72
        )
        VStack(spacing: 0) {
          header
          pages(in: geometry.size)
          pageControl
          dock
        }
      }
    }
    .environment(\.colorScheme, UITraitCollection.current.userInterfaceStyle == .dark ? .dark : .light)
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      Button(
        action: { model.onReturnToCode?() },
        label: {
          Image(systemName: "chevron.left.forwardslash.chevron.right")
            .font(.system(size: 18, weight: .semibold))
            .frame(width: 44, height: 44)
        }
      )
      .accessibilityLabel("In Code wechseln")
      VStack(alignment: .leading, spacing: 1) {
        Text(model.instanceName).font(.headline).lineLimit(1)
        Text(model.editing ? "Apps bearbeiten" : "Business OS")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      if model.editing {
        Button("Fertig") { model.editing = false }
          .buttonStyle(.glassProminent)
      } else {
        Button(
          action: { model.onOpenSearch?() },
          label: { Image(systemName: "magnifyingglass").frame(width: 44, height: 44) }
        )
        .accessibilityLabel("Apps durchsuchen")
        if model.showsSettingsAction {
          Button(
            action: { model.onOpenSettings?() },
            label: { Image(systemName: "gearshape").frame(width: 44, height: 44) }
          )
          .accessibilityLabel("Workjet Einstellungen")
        }
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 8)
    .padding(.bottom, 4)
  }

  private func pages(in size: CGSize) -> some View {
    let columns = size.width >= 840 ? (size.width > size.height ? 8 : 6) : size.width >= 600 ? (size.width > size.height ? 7 : 5) : (size.width > size.height ? 6 : 4)
    return TabView(selection: $model.activePage) {
      ForEach(Array(model.pages.enumerated()), id: \.offset) { pageIndex, page in
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: columns),
          alignment: .center,
          spacing: size.width >= 600 ? 24 : 18
        ) {
          ForEach(Array(page.enumerated()), id: \.element.id) { itemIndex, item in
            itemView(item, pageIndex: pageIndex, itemIndex: itemIndex)
          }
        }
        .padding(.horizontal, size.width >= 600 ? 28 : 14)
        .padding(.top, 18)
        .frame(maxHeight: .infinity, alignment: .top)
        .tag(pageIndex)
      }
    }
    .tabViewStyle(.page(indexDisplayMode: .never))
  }

  @ViewBuilder
  private func itemView(_ item: WorkjetLauncherItem, pageIndex: Int, itemIndex: Int) -> some View {
    if item.kind == "folder" {
      WorkjetFolderCell(item: item, apps: model.appsById)
    } else if let appId = item.appId, let app = model.appsById[appId] {
      WorkjetAppCell(
        app: app,
        badge: model.badges[app.id],
        editing: model.editing,
        onOpen: {
          guard app.id != "desktop" else { return }
          model.onOpenApp?(app.id)
        },
        onEdit: {
          model.editing = true
          UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
      )
      .onDrag {
        model.dragged = (pageIndex, itemIndex)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        return NSItemProvider(object: app.id as NSString)
      }
      .onDrop(of: [UTType.text], delegate: WorkjetIconDropDelegate(
        model: model,
        pageIndex: pageIndex,
        targetIndex: itemIndex
      ))
    }
  }

  private var pageControl: some View {
    HStack(spacing: 6) {
      ForEach(model.pages.indices, id: \.self) { index in
        Capsule()
          .fill(index == model.activePage ? Color.primary : Color.secondary.opacity(0.35))
          .frame(width: index == model.activePage ? 16 : 6, height: 6)
          .animation(.snappy(duration: 0.18), value: model.activePage)
      }
    }
    .frame(height: 22)
  }

  private var dock: some View {
    HStack(spacing: 12) {
      ForEach(model.dock, id: \.self) { appId in
        if let app = model.appsById[appId] {
          WorkjetAppCell(
            app: app,
            badge: model.badges[app.id],
            editing: false,
            compact: true,
            onOpen: { model.onOpenApp?(app.id) },
            onEdit: { model.editing = true }
          )
        }
      }
      Divider().frame(height: 42)
      Button(
        action: { model.onOpenRecents?() },
        label: {
          Image(systemName: "rectangle.stack")
            .font(.system(size: 22, weight: .semibold))
            .frame(width: 52, height: 52)
        }
      )
      .accessibilityLabel("Workjet Recents")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: .rect(cornerRadius: 28))
    .padding(.horizontal, 16)
    .padding(.bottom, 8)
  }
}

@available(iOS 26.0, *)
private struct WorkjetAppCell: View {
  let app: WorkjetLauncherApp
  let badge: Int?
  let editing: Bool
  var compact = false
  let onOpen: () -> Void
  let onEdit: () -> Void

  var body: some View {
    Button(action: onOpen) {
      VStack(spacing: 7) {
        ZStack(alignment: .topTrailing) {
          RoundedRectangle(cornerRadius: compact ? 14 : 16, style: .continuous)
            .fill(
              LinearGradient(
                colors: [Color(hex: app.accent).opacity(0.96), Color(hex: app.accent).opacity(0.68)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
            .frame(width: compact ? 52 : 60, height: compact ? 52 : 60)
            .overlay {
              Image(systemName: workjetSystemSymbol(app.id))
                .font(.system(size: compact ? 23 : 27, weight: .semibold))
                .foregroundStyle(.white)
            }
          if let badge, badge > 0 {
            Text(badge > 99 ? "99+" : String(badge))
              .font(.caption2.bold())
              .foregroundStyle(.white)
              .padding(.horizontal, 5)
              .frame(minWidth: 20, minHeight: 20)
              .background(.red, in: Capsule())
              .offset(x: 7, y: -7)
          }
        }
        if !compact {
          Text(app.title)
            .font(.caption.weight(.medium))
            .foregroundStyle(.primary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .frame(maxWidth: 92, minHeight: 30, alignment: .top)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(editing)
    .contextMenu {
      Button("Öffnen", systemImage: "arrow.up.forward.app", action: onOpen)
      Button("Home-Bildschirm bearbeiten", systemImage: "square.grid.3x3", action: onEdit)
    }
    .scaleEffect(editing ? 0.97 : 1)
    .rotationEffect(.degrees(editing ? -0.7 : 0))
    .animation(editing ? .easeInOut(duration: 0.12).repeatForever(autoreverses: true) : .snappy, value: editing)
    .accessibilityLabel(app.title)
    .accessibilityHint(app.desktopOnly == true ? "Nur auf Desktop verfügbar" : "App öffnen")
  }
}

@available(iOS 26.0, *)
private struct WorkjetFolderCell: View {
  let item: WorkjetLauncherItem
  let apps: [String: WorkjetLauncherApp]

  var body: some View {
    VStack(spacing: 7) {
      LazyVGrid(columns: Array(repeating: GridItem(.fixed(18), spacing: 4), count: 2), spacing: 4) {
        ForEach(Array((item.appIds ?? []).prefix(4)), id: \.self) { appId in
          RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(Color(hex: apps[appId]?.accent ?? "#64748b"))
            .frame(width: 18, height: 18)
        }
      }
      .padding(8)
      .frame(width: 60, height: 60)
      .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      Text(item.title ?? "Ordner")
        .font(.caption.weight(.medium))
        .lineLimit(1)
        .frame(maxWidth: 92)
    }
    .accessibilityLabel("\(item.title ?? "Ordner"), \((item.appIds ?? []).count) Apps")
  }
}

@available(iOS 26.0, *)
private struct WorkjetIconDropDelegate: DropDelegate {
  let model: WorkjetLauncherModel
  let pageIndex: Int
  let targetIndex: Int

  func performDrop(info: DropInfo) -> Bool {
    guard let source = model.dragged else { return false }
    model.onLayoutChange?(source.page, source.index, targetIndex)
    model.dragged = nil
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    return true
  }

  func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
}

private func workjetSystemSymbol(_ id: String) -> String {
  let symbols = [
    "ctox": "gearshape.2.fill",
    "tickets": "checkmark.seal.fill",
    "threads": "point.3.connected.trianglepath.dotted",
    "knowledge": "books.vertical.fill",
    "browser": "location.north.circle.fill",
    "credentials": "key.fill",
    "mail": "envelope.fill",
    "app-store": "shippingbox.fill",
    "importer": "square.and.arrow.down.fill",
    "reports": "ladybug.fill",
    "coding-agents": "chevron.left.forwardslash.chevron.right",
    "documents": "doc.on.doc.fill",
    "buchhaltung": "checkmark.rectangle.stack.fill",
  ]
  return symbols[id] ?? "square.grid.2x2.fill"
}

private extension Color {
  init(hex: String) {
    let raw = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let value = UInt64(raw, radix: 16) ?? 0x64748B
    self.init(
      .sRGB,
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255,
      opacity: 1
    )
  }
}
