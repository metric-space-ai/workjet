import Foundation
import Testing
@testable import SpeechProtocol

private func command(_ extra: String = "", name: String = "status") -> Data {
    Data("""
    {"protocolVersion":1,"command":"\(name)","requestId":"r1","instanceId":"i1","projectId":"p1","meetingId":"m1","deckRevision":3\(extra)}
    """.utf8)
}

@Test func commandRequiresCompleteScopeAndVersion() throws {
    #expect(try SpeechCommand.decode(command()).scope.deckRevision == 3)
    #expect(throws: SpeechFailure.invalidRequest) {
        try SpeechCommand.decode(Data(#"{"protocolVersion":1,"command":"begin","requestId":"r"}"#.utf8))
    }
    #expect(throws: SpeechFailure.invalidRequest) {
        try SpeechCommand.decode(Data(String(decoding: command(), as: UTF8.self).replacingOccurrences(of: "\"protocolVersion\":1", with: "\"protocolVersion\":2").utf8))
    }
}

@Test func roomAndDeckSwitchAreRejected() throws {
    var room = RoomBinding()
    let first = SpeechScope(instanceId: "i", projectId: "p", meetingId: "m", deckRevision: 1)
    try room.admit(first)
    try room.admit(first)
    #expect(throws: SpeechFailure.scopeMismatch) {
        try room.admit(SpeechScope(instanceId: "i", projectId: "p", meetingId: "m", deckRevision: 2))
    }
    #expect(throws: SpeechFailure.scopeMismatch) {
        try room.admit(SpeechScope(instanceId: "other", projectId: "p", meetingId: "m", deckRevision: 1))
    }
}

@Test func exactFrameOrderAndBoundAreEnforced() throws {
    var order = FrameOrder()
    try order.admit(sequence: 0, byteCount: 640)
    #expect(order.samples == 320)
    #expect(throws: SpeechFailure.audioOrder) { try order.admit(sequence: 0, byteCount: 640) }
    #expect(order.next == 1)
    for sequence in 1..<700 { try order.admit(sequence: sequence, byteCount: 640) }
    #expect(throws: SpeechFailure.overflow) { try order.admit(sequence: 700, byteCount: 2) }
}

@Test func malformedPcmIsNotAcknowledged() throws {
    #expect(throws: SpeechFailure.invalidRequest) {
        try SpeechCommand.decode(command(#","sequence":0,"audioBase64":"AQ==""#, name: "append"))
    }
    let valid = Data(repeating: 0, count: 640).base64EncodedString()
    #expect(try SpeechCommand.decode(command(",\"sequence\":0,\"audioBase64\":\"\(valid)\"", name: "append")).pcm().count == 640)
}

@Test func lineLimitAppliesBeforeNewline() throws {
    var parser = LineFramer()
    #expect(try parser.append(Data(repeating: 65, count: SpeechLimits.lineBytes)).isEmpty)
    #expect(throws: SpeechFailure.overflow) { try parser.append(Data([65])) }
}

@Test func splitCommandsAndTruncatedEof() throws {
    var parser = LineFramer()
    #expect(try parser.append(Data("abc".utf8)).isEmpty)
    let lines = try parser.append(Data("d\nnext\n".utf8))
    #expect(lines == [Data("abcd".utf8), Data("next".utf8)])
    try parser.finish()
    _ = try parser.append(Data("unfinished".utf8))
    #expect(throws: SpeechFailure.invalidRequest) { try parser.finish() }
}

@Test func narrationTextIsBounded() throws {
    #expect(throws: SpeechFailure.invalidRequest) {
        try SpeechCommand.decode(command(",\"text\":\"\(String(repeating: "a", count: 4097))\"", name: "synthesize"))
    }
}
