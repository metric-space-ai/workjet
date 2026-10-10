import AVFAudio
import CoreMedia
import Darwin
import Foundation
import Speech
import SpeechProtocol

private let origin = DispatchTime.now().uptimeNanoseconds
private func clockMs() -> Double {
    // Swift initializes globals lazily. Read the origin before sampling now,
    // otherwise the first call can subtract a later origin and trap.
    let baseline = origin
    return Double(DispatchTime.now().uptimeNanoseconds - baseline) / 1_000_000
}

private struct VoiceInfo: Encodable {
    let identifier: String
    let language: String
    let quality: String
}
private struct Capabilities: Encodable {
    let available: Bool
    let germanSupported: Bool
    let germanInstalled: Bool
    let germanVoices: [VoiceInfo]
    let audioProcessedOnDevice: Bool
}
private struct Event: Encodable {
    let protocolVersion = SpeechLimits.protocolVersion
    let event: String
    let requestId: String
    let instanceId: String
    let projectId: String
    let meetingId: String
    let deckRevision: Int
    let helperMs: Double
    var code: String?
    var text: String?
    var sequence: Int?
    var audioBase64: String?
    var sampleRate: Double?
    var channels: Int?
    var format: String?
    var bytes: Int?
    var firstAudioMs: Double?
    var endToFinalMs: Double?
    var capabilities: Capabilities?
    var voice: VoiceInfo?
    var candidateOnly: Bool?

    init(_ command: SpeechCommand, _ event: String) {
        self.event = event
        requestId = command.requestId
        instanceId = command.instanceId
        projectId = command.projectId
        meetingId = command.meetingId
        deckRevision = command.deckRevision
        helperMs = clockMs()
    }
}

private func writeLine<T: Encodable>(_ value: T) {
    do {
        let bytes = try JSONEncoder().encode(value)
        guard bytes.count <= SpeechLimits.lineBytes else { throw SpeechFailure.overflow }
        try FileHandle.standardOutput.write(contentsOf: bytes + Data([10]))
    } catch {
        // No unbounded diagnostic/error payload or retry on a broken owner pipe.
        Darwin.exit(74)
    }
}

// A room keeps stdin open while waiting for replies. Foundation's counted read
// can wait for the entire buffer; one POSIX read admits each available frame.
private func readPipeChunk() throws -> Data? {
    var bytes = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = bytes.withUnsafeMutableBytes {
            Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count)
        }
        if count < 0 {
            if errno == EINTR { continue }
            throw SpeechFailure.pipeClosed
        }
        if count == 0 { return nil }
        return Data(bytes.prefix(count))
    }
}

@MainActor private final class Capture {
    let command: SpeechCommand
    var analyzer: SpeechAnalyzer?
    var continuation: AsyncStream<AnalyzerInput>.Continuation?
    var prepare: Task<Void, Never>?
    var results: Task<Void, Never>?
    var watchdog: Task<Void, Never>?
    var converter: AVAudioConverter?
    var format: AVAudioFormat?
    var order = FrameOrder()
    var finalized = ""
    var endReceivedMs: Double?
    var ending = false
    var ready = false
    var analyzerSamples: Int64 = 0
    init(_ command: SpeechCommand) { self.command = command }
}

// AVAudioConverter marks its input callback Sendable. Transfer the initialized
// buffer once under a lock; no caller mutates it after this box is created.
private final class ConverterInput: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: AVAudioPCMBuffer?
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func take() -> AVAudioPCMBuffer? {
        lock.lock()
        defer { lock.unlock() }
        let next = buffer
        buffer = nil
        return next
    }
}

private struct TtsPacket: Sendable {
    let pcm: Data
    let sampleRate: Double
    static func read(_ buffer: AVAudioBuffer) throws -> Self? {
        guard let pcm = buffer as? AVAudioPCMBuffer else { throw SpeechFailure.audioFormat }
        if pcm.frameLength == 0 { return nil }
        guard pcm.format.channelCount == 1,
              pcm.frameLength <= 131_072,
              pcm.format.sampleRate >= 8_000, pcm.format.sampleRate <= 48_000
        else { throw SpeechFailure.audioFormat }
        var data = Data(capacity: Int(pcm.frameLength) * 2)
        for i in 0..<Int(pcm.frameLength) {
            var sample: Int16
            if let values = pcm.floatChannelData {
                let value = values[0][i]
                guard value.isFinite else { throw SpeechFailure.audioFormat }
                let bounded = max(-1, min(1, value))
                sample = Int16(max(-32_768, min(32_767, Int((bounded * 32_768).rounded()))))
            } else if let values = pcm.int16ChannelData {
                sample = values[0][i]
            } else { throw SpeechFailure.audioFormat }
            sample = sample.littleEndian
            withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
        }
        return Self(pcm: data, sampleRate: pcm.format.sampleRate)
    }
}

@MainActor private final class Synthesis {
    let command: SpeechCommand
    let synth = AVSpeechSynthesizer()
    let startedMs = clockMs()
    var continuation: AsyncThrowingStream<TtsPacket, Error>.Continuation?
    var reader: Task<Void, Never>?
    var watchdog: Task<Void, Never>?
    var bytes = 0
    var sequence = 0
    var sampleRate: Double?
    var firstAudioMs: Double?
    init(_ command: SpeechCommand) { self.command = command }
}

@MainActor private final class Worker {
    private var binding = RoomBinding()
    private var capture: Capture?
    private var synthesis: Synthesis?
    private var retired = Set<String>()
    private var ownedLocales: [String: Locale] = [:]
    private let inputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                           sampleRate: 16_000, channels: 1, interleaved: false)!

    func handle(_ command: SpeechCommand) async {
        do {
            try binding.admit(command.scope)
            switch command.command {
            case .status: await status(command)
            case .begin: try begin(command)
            case .append: try append(command)
            case .end: try end(command)
            case .cancel: await cancel(command)
            case .synthesize: try synthesize(command)
            }
        } catch {
            fail(command, error)
            if let session = capture, session.command.requestId == command.requestId { await stopCapture(session) }
            if let session = synthesis, session.command.requestId == command.requestId { stopSynthesis(session) }
        }
    }

    private func fail(_ command: SpeechCommand, _ error: Error) {
        var event = Event(command, "error")
        event.code = (error as? SpeechFailure ?? .nativeSpeechFailed).rawValue
        writeLine(event)
    }

    private func germanVoices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.replacingOccurrences(of: "_", with: "-") == "de-DE"
                && ($0.quality == .premium || $0.quality == .enhanced) }
            .sorted {
                $0.quality.rawValue == $1.quality.rawValue
                    ? $0.identifier < $1.identifier : $0.quality.rawValue > $1.quality.rawValue
            }
    }
    private func voiceInfo(_ voice: AVSpeechSynthesisVoice) -> VoiceInfo {
        VoiceInfo(identifier: voice.identifier, language: voice.language,
                  quality: voice.quality == .premium ? "premium" : "enhanced")
    }
    private func status(_ command: SpeechCommand) async {
        let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "de-DE"))
        let installed: Bool
        if let locale = supported {
            let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
            installed = await AssetInventory.status(forModules: [transcriber]) == .installed
        } else {
            installed = false
        }
        var event = Event(command, "status")
        event.capabilities = Capabilities(
            available: SpeechTranscriber.isAvailable, germanSupported: supported != nil,
            germanInstalled: installed,
            germanVoices: germanVoices().map(voiceInfo), audioProcessedOnDevice: true)
        writeLine(event)
    }

    private func begin(_ command: SpeechCommand) throws {
        guard capture == nil else { throw SpeechFailure.busy }
        guard synthesis?.command.requestId != command.requestId else { throw SpeechFailure.invalidRequest }
        guard !retired.contains(command.requestId), retired.count < 2_048 else { throw SpeechFailure.invalidRequest }
        let session = Capture(command)
        capture = session
        session.prepare = Task { [weak self, weak session] in
            guard let self, let session else { return }
            do {
                guard SpeechTranscriber.isAvailable else { throw SpeechFailure.unsupportedDevice }
                guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "de-DE"))
                else { throw SpeechFailure.unsupportedLocale }
                let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
                let modules: [any SpeechModule] = [transcriber]
                if try await AssetInventory.reserve(locale: locale) {
                    self.ownedLocales[locale.identifier(.bcp47)] = locale
                }
                if await AssetInventory.status(forModules: modules) != .installed {
                    guard command.installAssets == true else { throw SpeechFailure.assetsMissing }
                    do {
                        if let installation = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                            try await installation.downloadAndInstall()
                        }
                    } catch { throw SpeechFailure.assetInstallFailed }
                }
                try Task.checkCancellation()
                guard self.capture === session else { return }
                guard await AssetInventory.status(forModules: modules) == .installed else { throw SpeechFailure.assetsMissing }
                guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules, considering: self.inputFormat),
                      let converter = AVAudioConverter(from: self.inputFormat, to: format)
                else { throw SpeechFailure.audioFormat }
                let analyzer = SpeechAnalyzer(modules: modules, options: .init(priority: .userInitiated, modelRetention: .processLifetime))
                session.analyzer = analyzer
                session.converter = converter
                session.format = format
                let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(SpeechLimits.queueFrames))
                session.continuation = continuation
                session.results = Task { [weak self, weak session] in
                    guard let self, let session else { return }
                    do {
                        for try await result in transcriber.results {
                            guard self.capture === session, !Task.isCancelled else { return }
                            let fragment = String(result.text.characters)
                            if result.isFinal {
                                session.finalized += (session.finalized.isEmpty ? "" : " ") + fragment
                            }
                            var event = Event(command, "partial")
                            event.text = result.isFinal ? session.finalized
                                : session.finalized + (session.finalized.isEmpty ? "" : " ") + fragment
                            event.candidateOnly = true
                            writeLine(event)
                        }
                    } catch {
                        if self.capture === session, !Task.isCancelled {
                            self.fail(command, error)
                            await self.stopCapture(session)
                        }
                    }
                }
                try await analyzer.prepareToAnalyze(in: format)
                try Task.checkCancellation()
                guard self.capture === session else { return }
                try await analyzer.start(inputSequence: stream)
                session.ready = true
                writeLine(Event(command, "ready"))
                session.watchdog?.cancel()
                session.watchdog = Task { [weak self, weak session] in
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled, let self, let session, self.capture === session else { return }
                    self.fail(command, SpeechFailure.timeout)
                    await self.stopCapture(session)
                }
            } catch {
                guard self.capture === session else { return }
                self.fail(command, error)
                await self.stopCapture(session)
            }
        }
        session.watchdog = Task { [weak self, weak session] in
            try? await Task.sleep(for: .seconds(command.installAssets == true ? 120 : 15))
            guard !Task.isCancelled, let self, let session, self.capture === session, !session.ready else { return }
            self.fail(command, SpeechFailure.timeout)
            await self.stopCapture(session)
        }
    }

    private func append(_ command: SpeechCommand) throws {
        guard let session = capture, session.command.requestId == command.requestId,
              session.ready, !session.ending, let format = session.format, let converter = session.converter,
              let continuation = session.continuation else { throw SpeechFailure.invalidRequest }
        let data = try command.pcm()
        let sequence = command.sequence!
        try session.order.admit(sequence: sequence, byteCount: data.count)
        guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: UInt32(data.count / 2)),
              let values = input.floatChannelData?[0]
        else { throw SpeechFailure.audioFormat }
        input.frameLength = UInt32(data.count / 2)
        for i in 0..<Int(input.frameLength) {
            let bits = UInt16(data[i * 2]) | (UInt16(data[i * 2 + 1]) << 8)
            values[i] = Float(Int16(bitPattern: bits)) / 32_768
        }
        let capacity = UInt32(ceil(Double(input.frameLength) * format.sampleRate / 16_000)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw SpeechFailure.audioFormat }
        let source = ConverterInput(input)
        var error: NSError?
        let converted = converter.convert(to: output, error: &error) { _, status in
            guard let input = source.take() else { status.pointee = .noDataNow; return nil }
            status.pointee = .haveData
            return input
        }
        guard converted != .error, error == nil else { throw SpeechFailure.audioFormat }
        if output.frameLength > 0 {
            switch continuation.yield(AnalyzerInput(buffer: output, bufferStartTime: CMTime(value: session.analyzerSamples, timescale: Int32(format.sampleRate)))) {
            case .enqueued: break
            case .dropped: throw SpeechFailure.overflow
            case .terminated: throw SpeechFailure.cancelled
            @unknown default: throw SpeechFailure.nativeSpeechFailed
            }
            session.analyzerSamples += Int64(output.frameLength)
        }
        var event = Event(command, "appended")
        event.sequence = sequence
        writeLine(event)
    }

    private func end(_ command: SpeechCommand) throws {
        guard let session = capture, session.command.requestId == command.requestId,
              session.ready, !session.ending, let analyzer = session.analyzer
        else { throw SpeechFailure.invalidRequest }
        session.ending = true
        session.endReceivedMs = clockMs()
        if let converter = session.converter, let format = session.format,
           let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2_048) {
            var conversionError: NSError?
            let converted = converter.convert(to: tail, error: &conversionError) { _, status in
                status.pointee = .endOfStream
                return nil
            }
            guard converted != .error, conversionError == nil else { throw SpeechFailure.audioFormat }
            if tail.frameLength > 0, let continuation = session.continuation {
                switch continuation.yield(AnalyzerInput(buffer: tail, bufferStartTime: CMTime(value: session.analyzerSamples, timescale: Int32(format.sampleRate)))) {
                case .enqueued: break
                case .dropped: throw SpeechFailure.overflow
                case .terminated: throw SpeechFailure.cancelled
                @unknown default: throw SpeechFailure.nativeSpeechFailed
                }
            }
        }
        session.continuation?.finish()
        session.watchdog?.cancel()
        session.watchdog = Task { [weak self, weak session] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, let self, let session, self.capture === session else { return }
            self.fail(command, SpeechFailure.timeout)
            await self.stopCapture(session)
        }
        Task { [weak self, weak session] in
            guard let self, let session else { return }
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                await session.results?.value
                guard self.capture === session else { return }
                var event = Event(command, "final")
                event.text = session.finalized
                event.candidateOnly = true
                event.endToFinalMs = clockMs() - (session.endReceivedMs ?? clockMs())
                writeLine(event)
                await self.stopCapture(session)
            } catch {
                guard self.capture === session else { return }
                self.fail(command, error)
                await self.stopCapture(session)
            }
        }
    }

    private func stopCapture(_ session: Capture) async {
        guard capture === session else { return }
        capture = nil
        retired.insert(session.command.requestId)
        session.prepare?.cancel()
        session.watchdog?.cancel()
        session.continuation?.finish()
        session.results?.cancel()
        await session.analyzer?.cancelAndFinishNow()
    }

    private func synthesize(_ command: SpeechCommand) throws {
        guard synthesis == nil else { throw SpeechFailure.busy }
        guard capture?.command.requestId != command.requestId else { throw SpeechFailure.invalidRequest }
        guard !retired.contains(command.requestId), retired.count < 2_048 else { throw SpeechFailure.invalidRequest }
        guard let voice = germanVoices().first else { throw SpeechFailure.voiceMissing }
        let session = Synthesis(command)
        synthesis = session
        let (stream, continuation) = AsyncThrowingStream<TtsPacket, Error>.makeStream(bufferingPolicy: .bufferingOldest(SpeechLimits.queueFrames))
        session.continuation = continuation
        let utterance = AVSpeechUtterance(string: command.text!)
        utterance.voice = voice
        utterance.preUtteranceDelay = 0
        utterance.postUtteranceDelay = 0
        session.reader = Task { [weak self, weak session] in
            guard let self, let session else { return }
            do {
                for try await packet in stream {
                    guard self.synthesis === session, !Task.isCancelled else { return }
                    guard session.sampleRate == nil || session.sampleRate == packet.sampleRate else { throw SpeechFailure.audioFormat }
                    session.sampleRate = packet.sampleRate
                    guard session.bytes + packet.pcm.count + 44 <= SpeechLimits.totalAudioBytes else { throw SpeechFailure.overflow }
                    session.bytes += packet.pcm.count
                    if session.firstAudioMs == nil { session.firstAudioMs = clockMs() - session.startedMs }
                    for offset in stride(from: 0, to: packet.pcm.count, by: SpeechLimits.audioChunkBytes) {
                        var event = Event(command, "audio")
                        event.sequence = session.sequence
                        event.audioBase64 = packet.pcm.subdata(in: offset..<min(offset + SpeechLimits.audioChunkBytes, packet.pcm.count)).base64EncodedString()
                        event.sampleRate = packet.sampleRate
                        event.channels = 1
                        event.format = "s16le"
                        event.firstAudioMs = session.firstAudioMs
                        writeLine(event)
                        session.sequence += 1
                    }
                }
                guard self.synthesis === session else { return }
                guard session.bytes > 0 else { throw SpeechFailure.nativeSpeechFailed }
                var event = Event(command, "audio_end")
                event.bytes = session.bytes
                event.sampleRate = session.sampleRate
                event.channels = 1
                event.format = "s16le"
                event.firstAudioMs = session.firstAudioMs
                event.voice = self.voiceInfo(voice)
                writeLine(event)
                self.stopSynthesis(session)
            } catch {
                guard self.synthesis === session else { return }
                self.fail(command, error)
                self.stopSynthesis(session)
            }
        }
        session.synth.write(utterance) { buffer in
            do {
                guard let packet = try TtsPacket.read(buffer) else { continuation.finish(); return }
                switch continuation.yield(packet) {
                case .enqueued: break
                case .dropped: continuation.finish(throwing: SpeechFailure.overflow)
                case .terminated: break
                @unknown default: continuation.finish(throwing: SpeechFailure.nativeSpeechFailed)
                }
            } catch { continuation.finish(throwing: error) }
        }
        session.watchdog = Task { [weak self, weak session] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled, let self, let session, self.synthesis === session else { return }
            self.fail(command, SpeechFailure.timeout)
            self.stopSynthesis(session)
        }
    }

    private func stopSynthesis(_ session: Synthesis) {
        guard synthesis === session else { return }
        synthesis = nil
        retired.insert(session.command.requestId)
        session.watchdog?.cancel()
        session.continuation?.finish()
        session.reader?.cancel()
        session.synth.stopSpeaking(at: .immediate)
    }

    private func cancel(_ command: SpeechCommand) async {
        if let session = capture, session.command.requestId == command.requestId { await stopCapture(session) }
        if let session = synthesis, session.command.requestId == command.requestId { stopSynthesis(session) }
        writeLine(Event(command, "cancelled"))
    }
    func close() async {
        if let session = capture { await stopCapture(session) }
        if let session = synthesis { stopSynthesis(session) }
        for locale in ownedLocales.values { await AssetInventory.release(reservedLocale: locale) }
        ownedLocales.removeAll()
    }
}

@main private struct SpeechHelper {
    @MainActor static func main() async {
        _ = origin
        signal(SIGPIPE, SIG_IGN)
        if Array(CommandLine.arguments.dropFirst()) == ["--version"] {
            print("{\"protocolVersion\":1,\"helper\":\"workjet-speech-helper\",\"minimumMacOS\":\"26.0\"}")
            return
        }
        guard CommandLine.arguments.count == 1 else { Darwin.exit(64) }
        let worker = Worker()
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(SpeechLimits.queueFrames))
        let reader = Task.detached {
            var framer = LineFramer()
            do {
                while let bytes = try readPipeChunk() {
                    for line in try framer.append(bytes) {
                        switch continuation.yield(line) {
                        case .enqueued: break
                        case .dropped: throw SpeechFailure.overflow
                        case .terminated: return
                        @unknown default: throw SpeechFailure.pipeClosed
                        }
                    }
                }
                try framer.finish()
                continuation.finish()
            } catch { continuation.finish(throwing: error) }
        }
        do {
            for try await bytes in stream {
                await worker.handle(try SpeechCommand.decode(bytes))
            }
        } catch {
            struct Failure: Encodable { let protocolVersion = 1; let event = "protocol_error"; let code: String }
            writeLine(Failure(code: (error as? SpeechFailure ?? .invalidRequest).rawValue))
        }
        reader.cancel()
        await worker.close()
    }
}
