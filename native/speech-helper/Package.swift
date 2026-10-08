// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WorkjetSpeechHelper",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "workjet-speech-helper", targets: ["WorkjetSpeechHelper"])],
    targets: [
        .target(name: "SpeechProtocol"),
        .executableTarget(name: "WorkjetSpeechHelper", dependencies: ["SpeechProtocol"]),
        .testTarget(name: "SpeechProtocolTests", dependencies: ["SpeechProtocol"])
    ]
)
