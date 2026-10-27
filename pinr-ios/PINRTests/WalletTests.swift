import Foundation
import Testing
@testable import PINR

@Suite("Wallet by address (the site's wallet.ts), read-only")
struct WalletRuleTests {
    @Test("Solana and EVM addresses are recognised; anything else is not an address")
    func addresses() {
        #expect(WalletRules.clean("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")?.chain == .solana)
        #expect(WalletRules.clean("0xAbCdEf0123456789abcdef0123456789ABCDEF01")?.address == "0xabcdef0123456789abcdef0123456789abcdef01")
        #expect(WalletRules.clean("  0xabcdef0123456789abcdef0123456789abcdef01\n")?.chain == .evm)
        #expect(WalletRules.clean("hello") == nil)
        #expect(WalletRules.clean("0x123") == nil)
        #expect(WalletRules.clean("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl") == nil)
    }

    @Test("A scanned payment code keeps only the address")
    func scanned() {
        #expect(WalletRules.clean("solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU?amount=1")?.address == "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")
        #expect(WalletRules.clean("ethereum:0xabcdef0123456789abcdef0123456789abcdef01@1")?.chain == .evm)
    }

    @Test("A WalletConnect pairing code is not a wallet address")
    func pairingRefused() {
        #expect(WalletRules.clean("wc:a281567bb3e4f0c1d6e5b4a3928170615243f8e9d0c1b2a3948576a6b5c4d3e2@2?relay-protocol=irn&symKey=7f6e5d4c") == nil)
        #expect(WalletRules.clean("wc:00e46b69-d0cc-4b3e-b6a2-cee442f97188@1?bridge=https%3A%2F%2Fbridge.example&key=00000000000000000000000000000000") == nil)
    }

    @Test("the View-only card says PINR does not connect, and never offers connecting or disconnecting")
    func viewOnlyWording() {
        #expect(WalletRules.viewOnlyTitle == "View-only")
        #expect(WalletRules.viewOnlyShort.contains("does not connect to your wallet"))
        #expect(WalletRules.viewOnlyPoints.count == 3 && WalletRules.viewOnlyPoints[1].hasPrefix("PINR does not connect to your wallet."))
        for line in [WalletRules.viewOnlyShort] + WalletRules.viewOnlyPoints {
            let l = line.lowercased()
            #expect(!l.contains("connecting") && !l.contains("disconnect") && !l.contains("read-only connection"))
        }
    }

    @Test("Short form and avatar hues as on the site")
    func looks() {
        #expect(WalletRules.short("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU") == "7xKXtg…gAsU")
        let a = WalletRules.avatarHues("0xABC"), b = WalletRules.avatarHues("0xabc")
        #expect(a == b && (0..<360).contains(a.0))
    }

    @Test("Holdings: a label beats a score; a score is a whole 1 to 99; a bad price is no price")
    func holdings() throws {
        let v = try JSONDecoder().decode(WalletView.self, from: Data(#"""
        {"status":"partial","unavailable":["base"],"totalUsd":12.5,"holdings":[
          {"address":"A","chain":"solana","name":"Zircon","ticker":"$ZRN","balance":2200,"usd":12.5,"score":72,"noScoreLabel":null},
          {"address":"B","chain":"solana","name":null,"ticker":null,"balance":10,"usd":null,"score":40,"noScoreLabel":"VAMP"},
          {"address":"C","chain":"solana","name":"C","ticker":"$C","balance":5,"usd":-3,"score":150,"noScoreLabel":null},
          {"address":"","chain":"solana","balance":1},"junk"]}
        """#.utf8))
        #expect(v.status == "partial" && v.unavailable == ["base"] && v.totalUsd == 12.5)
        #expect(v.holdings.map(\.address) == ["A", "B", "C"])
        #expect(v.holdings[1].score == nil && v.holdings[1].noScoreLabel == "VAMP")
        #expect(v.holdings[2].usd == nil && v.holdings[2].score == nil)
    }

    @Test("Money for a holding never reads $0")
    func money() {
        #expect(WalletRoom.usd(1234) == "$1.23K")
        #expect(WalletRoom.usd(0.0000495) == "$0.0₄495")
    }
}

@MainActor
@Suite("The wallet on this device", .serialized)
struct WalletStoreTests {
    @Test("Viewing keeps only the address; a wrong one gets the site's message; Clear forgets it")
    func store() {
        let d = UserDefaults(suiteName: "pinr-wallet-test")!
        d.removePersistentDomain(forName: "pinr-wallet-test")
        let w = WalletStore(defaults: d)
        #expect(w.view("nope") == "That is not a wallet address. Check it and try again.")
        #expect(w.view("0xABCDEF0123456789abcdef0123456789abcdef01") == nil)
        #expect(d.string(forKey: "pinr.wallet") == "0xabcdef0123456789abcdef0123456789abcdef01")
        #expect(WalletStore(defaults: d).address == "0xabcdef0123456789abcdef0123456789abcdef01")
        w.clear()
        #expect(w.address == nil && d.string(forKey: "pinr.wallet") == nil)
    }

    @Test("The holdings are read from the feed by the address only")
    func reads() async {
        StubFeed.asked = []
        StubFeed.answer = { _ in (200, #"{"status":"ok","holdings":[],"totalUsd":null,"unavailable":[]}"#) }
        let v = await WalletStore.read(feedBase, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", StubFeed.session())
        #expect(v?.status == "ok")
        #expect(StubFeed.asked == ["/api/wallet?address=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"])
    }
}

@Suite("Strangers' coin names (Apple review risk 2)")
struct NameFilterTests {
    @Test("Rude names are caught, with letter swaps, any case, inside a word")
    func rude() {
        for n in ["Wet Ass Pussy", "FUCK U CAT", "BootyDickPussy", "$SHITTER", "Sh1t Inu", "f*ck".replacingOccurrences(of: "*", with: "u"), "Nice Fucking Token"] {
            #expect(NameFilter.isRude(n), "\(n)")
        }
    }

    @Test("Harmless names stay: a $ ticker, words across a space, short stems inside words, allowed names")
    func harmless() {
        for n in ["$HIT", "RIP Satoshi Tajiri", "Document", "Analytics", "Cockatoo", "Moby Dick", "Scunthorpe".replacingOccurrences(of: "c", with: "x"), "Grape", "Titsy".replacingOccurrences(of: "s", with: "")] {
            #expect(!NameFilter.isRude(n), "\(n)")
        }
    }

    @Test("A masked coin shows neither its name nor its ticker nor its picture; switched off, it shows")
    func masking() throws {
        let t = try token(#"{"address":"A","coverage":5,"name":"Wet Ass Pussy","ticker":"$WAP","imageUrl":"/api/img?a=A"}"#)
        NameFilter.enabled = true
        #expect(Format.title(t) == "Name hidden" && Format.ticker(t) == "$•••" && NameFilter.masks(t))
        NameFilter.enabled = false
        #expect(Format.title(t) == "Wet Ass Pussy" && Format.ticker(t) == "$WAP")
        NameFilter.enabled = true
    }
}

@MainActor
@Suite("Hiding a coin", .serialized)
struct HideTests {
    @Test("A hidden coin leaves every list, stays hidden after a restart, and comes back on request")
    func hide() throws {
        let d = UserDefaults(suiteName: "pinr-hide-test")!
        d.removePersistentDomain(forName: "pinr-hide-test")
        let m = ModerationStore(defaults: d)
        let a = try token(#"{"address":"A","coverage":5}"#), b = try token(#"{"address":"B","coverage":5}"#)
        m.hide(a)
        #expect(m.visible([a, b]).map(\.address) == ["B"])
        #expect(ModerationStore(defaults: d).isHidden(a))
        m.unhideAll()
        #expect(m.visible([a, b]).count == 2)
        #expect(m.filterNames)
    }
}
