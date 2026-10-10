import Foundation

public enum SpeechFailure: String, Error, Sendable {
    case invalidRequest = "invalid_request"
    case scopeMismatch = "scope_mismatch"
    case audioOrder = "audio_order"
    case overflow
    case busy
    case unsupportedDevice = "unsupported_device"
    case unsupportedLocale = "unsupported_locale"
    case assetsMissing = "assets_missing"
    case assetInstallFailed = "asset_install_failed"
    case voiceMissing = "voice_missing"
    case audioFormat = "audio_format"
    case nativeSpeechFailed = "native_speech_failed"
    case cancelled
    case timeout
    case pipeClosed = "pipe_closed"
}

public enum SpeechLimits {
    public static let protocolVersion = 1
    public static let lineBytes = 16_384
    public static let queueFrames = 32
    public static let frameBytes = 640
    public static let audioChunkBytes = 4_096
    public static let totalAudioBytes = 32 * 1_024 * 1_024
    public static let textBytes = 4_096
    public static let utteranceSamples = 16_000 * 14
}

public struct SpeechScope: Codable, Equatable, Sendable {
    public let instanceId: String
    public let projectId: String
    public let meetingId: String
    public let deckRevision: Int

    public init(instanceId: String, projectId: String, meetingId: String, deckRevision: Int) {
        self.instanceId = instanceId
        self.projectId = projectId
        self.meetingId = meetingId
        self.deckRevision = deckRevision
    }
}

public struct SpeechCommand: Decodable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case status, begin, append, end, cancel, synthesize
    }
    public let protocolVersion: Int
    public let command: Kind
    public let requestId: String
    public let instanceId: String
    public let projectId: String
    public let meetingId: String
    public let deckRevision: Int
    public let sequence: Int?
    public let audioBase64: String?
    public let text: String?
    public let slideId: String?
    public let installAssets: Bool?

    public var scope: SpeechScope {
        SpeechScope(instanceId: instanceId, projectId: projectId,
                    meetingId: meetingId, deckRevision: deckRevision)
    }

    public static func decode(_ data: Data) throws -> SpeechCommand {
        guard !data.isEmpty, data.count <= SpeechLimits.lineBytes else { throw SpeechFailure.overflow }
        let value: SpeechCommand
        do { value = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw SpeechFailure.invalidRequest }
        let identifiers = [value.requestId, value.instanceId, value.projectId, value.meetingId]
        guard value.protocolVersion == SpeechLimits.protocolVersion,
              value.deckRevision >= 0,
              identifiers.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 && !$0.unicodeScalars.contains(where: { $0.value < 32 }) })
        else { throw SpeechFailure.invalidRequest }
        if value.command == .append { _ = try value.pcm() }
        if value.command == .synthesize {
            guard let text = value.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= SpeechLimits.textBytes else { throw SpeechFailure.invalidRequest }
            if let slide = value.slideId {
                guard !slide.isEmpty, slide.utf8.count <= 128,
                      !slide.unicodeScalars.contains(where: { $0.value < 32 }) else { throw SpeechFailure.invalidRequest }
            }
        }
        return value
    }

    public func pcm() throws -> Data {
        guard let sequence, sequence >= 0, let audioBase64,
              audioBase64.utf8.count <= 856, let pcm = Data(base64Encoded: audioBase64),
              !pcm.isEmpty, pcm.count <= SpeechLimits.frameBytes, pcm.count % 2 == 0
        else { throw SpeechFailure.invalidRequest }
        return pcm
    }
}

/// Once bound, a child can never be retargeted to another room/revision.
public struct RoomBinding: Sendable {
    private var scope: SpeechScope?
    public init() {}
    public mutating func admit(_ value: SpeechScope) throws {
        if let scope, scope != value { throw SpeechFailure.scopeMismatch }
        scope = value
    }
}

public struct FrameOrder: Sendable {
    public private(set) var next = 0
    public private(set) var samples = 0
    public init() {}
    public mutating func admit(sequence: Int, byteCount: Int) throws {
        guard sequence == next else { throw SpeechFailure.audioOrder }
        guard byteCount > 0, byteCount <= SpeechLimits.frameBytes, byteCount % 2 == 0 else { throw SpeechFailure.invalidRequest }
        guard samples + byteCount / 2 <= SpeechLimits.utteranceSamples else { throw SpeechFailure.overflow }
        next += 1
        samples += byteCount / 2
    }
}

/// Bound memory before attempting JSON decoding, including missing newline attacks.
public struct LineFramer: Sendable {
    private var pending = Data()
    public init() {}
    public mutating func append(_ bytes: Data) throws -> [Data] {
        var lines: [Data] = []
        for byte in bytes {
            if byte == 10 {
                guard !pending.isEmpty else { throw SpeechFailure.invalidRequest }
                lines.append(pending)
                pending = Data()
            } else {
                guard pending.count < SpeechLimits.lineBytes else { throw SpeechFailure.overflow }
                pending.append(byte)
            }
        }
        return lines
    }
    public func finish() throws {
        guard pending.isEmpty else { throw SpeechFailure.invalidRequest }
    }
}
