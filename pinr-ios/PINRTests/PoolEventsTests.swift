import Foundation
import Testing
@testable import PINR

/// the coin page's Pool section.
@Suite("Pool events")
struct PoolEventsTests {
    static let sig = "5" + String(repeating: "J", count: 87)
    static let wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    static let body = """
    {"state":"read","source":"Solana chain","asOfMs":1792950000000,"events":[
     {"atMs":1792950000000,"kind":"liquidity added","sig":"\(sig)","user":"\(wallet)","base":1200000,"quote":12.3,"quoteSymbol":"SOL","raw":false},
     {"atMs":1792940000000,"kind":"bought back and burned","sig":"\(sig)","base":500,"quote":1.5,"quoteSymbol":"SOL","raw":true},
     {"atMs":1792930000000,"kind":"coin creator changed","sig":"\(sig)","oldCreator":"\(wallet)","newCreator":"\(wallet)","quoteSymbol":"SOL","raw":false},
     {"atMs":1,"kind":"something else","sig":"\(sig)"},{"atMs":2,"kind":"pool created","sig":"short"}]}
    """

    @Test("Events are read newest first as served; an unknown kind or a bad transaction is dropped alone")
    func reading() throws {
        let p = try JSONDecoder().decode(PoolEvents.self, from: Data(Self.body.utf8))
        #expect(p.state == "read" && p.events.map(\.kind) == ["liquidity added", "bought back and burned", "coin creator changed"])
    }

    @Test("a 0x hash is a receipt too, the chain names the explorer, a hash fitting neither is dropped")
    func evm() throws {
        let h = "0x" + String(repeating: "cd", count: 32), a = "0x" + String(repeating: "ab", count: 20)
        let json = #"{"state":"read","chain":"base","events":[{"atMs":1792950000000,"kind":"pool created","sig":"\#(h)","user":"\#(a)"},{"atMs":1792950000001,"kind":"liquidity added","sig":"0xzz"}]}"#
        let p = try JSONDecoder().decode(PoolEvents.self, from: Data(json.utf8))
        #expect(p.chain == "base" && p.events.count == 1 && p.events[0].user == a)
        #expect(PoolWords.txURL(h, chain: p.chain)?.absoluteString == "https://basescan.org/tx/\(h)")
        #expect(PoolWords.accountURL(a, chain: "bnb")?.absoluteString == "https://bscscan.com/address/\(a)")
        #expect(try JSONDecoder().decode(PoolEvents.self, from: Data(Self.body.utf8)).chain == "solana")
    }

    @Test("No file is not checked yet; an unknown state is no pool")
    func states() throws {
        #expect(try JSONDecoder().decode(PoolEvents.self, from: Data(#"{"state":"none","events":[]}"#.utf8)).state == "none")
        #expect((try? JSONDecoder().decode(PoolEvents.self, from: Data(#"{"state":"weird"}"#.utf8))) == nil)
    }

    @Test("Observed amounts, raw units said as such, the site's amount format and UTC time")
    func words() throws {
        let e = try JSONDecoder().decode(PoolEvents.self, from: Data(Self.body.utf8)).events
        #expect(PoolWords.what(e[0]) == "12.30 SOL and 1.20M tokens")
        #expect(PoolWords.what(e[1]) == "500.00 raw token units burned for 1.50 raw SOL units")
        #expect(PoolWords.what(e[2]) == "" && PoolWords.title(e[0].kind) == "Liquidity added")
        #expect(PoolWords.local(1792950000000, zone: TimeZone(identifier: "UTC")!) == "Oct 25, 5:40 PM" && PoolWords.amount(0.00123) == "0.00123")
        #expect(PoolWords.local(1792950000000, zone: TimeZone(identifier: "America/Denver")!) == "Oct 25, 11:40 AM")
        #expect(PoolWords.txURL(Self.sig)?.absoluteString.hasPrefix("https://solscan.io/tx/") == true)
    }
}
