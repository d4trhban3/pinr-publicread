import Foundation
import Testing
@testable import PINR

/// A stand-in feed server: answers the app's requests from a table, so the store is tested
/// without the network. Each test sets its own table.
final class StubFeed: URLProtocol {
    nonisolated(unsafe) static var answer: (URL) -> (Int, String) = { _ in (404, "{}") }
    nonisolated(unsafe) static var asked: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.asked.append(url.path + (url.query.map { "?" + $0 } ?? ""))
        let (code, body) = Self.answer(url)
        let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubFeed.self]
        return URLSession(configuration: config)
    }
}

private func tokensJSON(_ prefix: String, _ range: Range<Int>) -> String {
    "[" + range.map { #"{"address":"\#(prefix)\#($0)","coverage":50,"score":\#(1 + $0 % 99)}"# }.joined(separator: ",") + "]"
}

private func query(_ url: URL, _ name: String) -> Int {
    Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value ?? "") ?? 0
}

@MainActor
@Suite("Reading the feed", .serialized)
struct FeedStoreTests {
    private func store() -> FeedStore {
        StubFeed.asked = []
        return FeedStore(baseURL: feedBase, session: StubFeed.session(), pageDelay: .zero)
    }

    @Test("The first page and every page of the rest are read, in order, once each")
    func readsEverything() async {
        let restTotal = 2403
        StubFeed.answer = { url in
            switch url.path {
            case "/api/tokens":
                return (200, #"{"contract":"1.0","mode":"feed","asOfMs":1,"files":3,"tokens":\#(tokensJSON("F", 0..<3)),"problems":[]}"#)
            case "/api/tokens/rest":
                let offset = query(url, "offset"), limit = query(url, "limit")
                let end = min(restTotal, offset + limit)
                return (200, #"{"contract":"1.0","total":\#(restTotal),"offset":\#(offset),"tokens":\#(tokensJSON("R", offset..<end))}"#)
            default: return (404, "{}")
            }
        }
        let s = store()
        await s.poll()
        #expect(s.state == .live)
        #expect(s.firstPage.map(\.address) == ["F0", "F1", "F2"])
        await s.sweep()
        #expect(s.rest.count == restTotal)
        #expect(s.restLoaded == restTotal && s.restTotal == restTotal)
        #expect(s.all.count == 3 + restTotal)
        #expect(s.rest.first?.address == "R0" && s.rest.last?.address == "R2402")
        // The first page of the rest comes first; the others follow two at a time, so their order between them is not fixed.
        let asked = StubFeed.asked.filter { $0.hasPrefix("/api/tokens/rest") }
        #expect(asked.first == "/api/tokens/rest?offset=0&limit=1000")
        #expect(Set(asked) == ["/api/tokens/rest?offset=0&limit=1000", "/api/tokens/rest?offset=1000&limit=1000", "/api/tokens/rest?offset=2000&limit=1000"])
    }

    @Test("A token on both the first page and the rest is shown once")
    func noDuplicates() async {
        StubFeed.answer = { url in
            url.path == "/api/tokens"
                ? (200, #"{"contract":"1.0","tokens":[{"address":"Same","coverage":10,"score":5}]}"#)
                : (200, #"{"contract":"1.0","total":2,"offset":0,"tokens":[{"address":"same","coverage":10,"score":5},{"address":"Other","coverage":10}]}"#)
        }
        let s = store()
        await s.poll()
        await s.sweep()
        #expect(s.all.map(\.address) == ["Same", "Other"])
    }

    @Test("Unreadable tokens are left out and counted; the rest are shown")
    func countsLeftOut() async {
        StubFeed.answer = { _ in
            (200, #"{"contract":"1.0","tokens":[{"address":"Good","coverage":10},{"coverage":10},{"address":"A","coverage":500},"junk",{"address":"B","coverage":5,"noScoreLabel":"NEW"}]}"#)
        }
        let s = store()
        await s.poll()
        #expect(s.firstPage.map(\.address) == ["Good"])
        #expect(s.leftOut == 4)
    }

    @Test("Another contract version is a mismatch and nothing is shown")
    func mismatch() async {
        StubFeed.answer = { _ in (200, #"{"contract":"1.0","tokens":\#(tokensJSON("F", 0..<2))}"#) }
        let s = store()
        await s.poll()
        #expect(s.firstPage.count == 2)
        StubFeed.answer = { _ in (200, #"{"contract":"2.0","tokens":\#(tokensJSON("F", 0..<2))}"#) }
        await s.poll()
        #expect(s.state == .mismatch(contract: "2.0"))
        #expect(s.all.isEmpty)
    }

    @Test("When the feed stops answering, the state says offline and the last tokens stay")
    func offlineKeepsLastHeard() async {
        StubFeed.answer = { _ in (200, #"{"contract":"1.0","tokens":\#(tokensJSON("F", 0..<2))}"#) }
        let s = store()
        await s.poll()
        StubFeed.answer = { _ in (503, "") }
        await s.poll()
        #expect(s.state == .offline(reason: "The feed answered 503"))
        #expect(s.firstPage.count == 2)
        #expect(s.lastHeard != nil)
    }

    @Test("A failed page ends the sweep and keeps the last whole sweep")
    func failedPageKeepsLastSweep() async {
        var failRest = false
        StubFeed.answer = { url in
            if url.path == "/api/tokens" { return (200, #"{"contract":"1.0","tokens":[]}"#) }
            if failRest, query(url, "offset") == 1000 { return (500, "") }
            let offset = query(url, "offset")
            return (200, #"{"contract":"1.0","total":1700,"offset":\#(offset),"tokens":\#(tokensJSON("R", offset..<min(1700, offset + 1000)))}"#)
        }
        let s = store()
        await s.poll()
        await s.sweep()
        #expect(s.rest.count == 1700)
        failRest = true
        await s.sweep()
        #expect(s.rest.count == 1700)
    }

    @Test("Nothing is read without a feed address")
    func noAddress() async {
        let s = FeedStore(baseURL: nil, session: StubFeed.session())
        await s.poll()
        #expect(s.state == .offline(reason: "No feed address in this build"))
    }
}
