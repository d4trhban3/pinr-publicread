import Foundation
import Testing
@testable import PINR

@Suite("Release build: the server over HTTPS only")
struct ReleaseTests {
    @Test("A release build takes only an HTTPS address; a test build may read this Mac")
    func scheme() {
        #expect(FeedLink.feedURL("https://pinr.io", release: true)?.absoluteString == "https://pinr.io")
        #expect(FeedLink.feedURL("http://pinr.io", release: true) == nil)
        #expect(FeedLink.feedURL("http://127.0.0.1:8787", release: true) == nil)
        #expect(FeedLink.feedURL("ftp://pinr.io", release: true) == nil)
        #expect(FeedLink.feedURL("pinr.io", release: true) == nil)
        #expect(FeedLink.feedURL(nil, release: true) == nil)
        #expect(FeedLink.feedURL("http://127.0.0.1:8787", release: false) != nil)
    }

    @Test("The release settings name https://pinr.io, so every call goes to https://pinr.io/api/…, with no transport exception")
    func releasePlist() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Config/Release.plist")
        let plist = try #require(NSDictionary(contentsOf: file) as? [String: Any])
        let base = try #require(FeedLink.feedURL(plist["PINRFeedURL"] as? String, release: true))
        #expect(base.appending(path: "api/contract").absoluteString == "https://pinr.io/api/contract")
        #expect(plist["NSAppTransportSecurity"] == nil)
    }
}
