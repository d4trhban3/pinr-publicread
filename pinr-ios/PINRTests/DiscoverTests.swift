import Foundation
import Testing
@testable import PINR

private func t(_ json: String) throws -> Token { try token(json) }

@Suite("Discover")
struct DiscoverTests {
    @Test("Top Movers: the largest price move either way; no move figure ranks last, never as zero")
    func movers() throws {
        let list = try [
            t(#"{"address":"Flat","coverage":5,"change24hPct":0}"#),
            t(#"{"address":"None","coverage":5}"#),
            t(#"{"address":"Down","coverage":5,"change24hPct":-80}"#),
            t(#"{"address":"Up","coverage":5,"change24hPct":40}"#),
        ]
        #expect(DiscoverRanking.rank(.movers, list).map(\.address) == ["Down", "Up", "Flat", "None"])
    }

    @Test("Base/BNB: only Base and BNB Chain coins, newest first by when met, else launch; none with a time last")
    func baseBnb() throws {
        let ms = { (secondsAgo: Double) in (2_000_000_000 - secondsAgo) * 1000 }
        let list = try [
            t(#"{"address":"Sol","chain":"solana","coverage":5,"launchedAtMs":\#(ms(10))}"#),
            t(#"{"address":"NoTime","chain":"bsc","coverage":0}"#),
            t(#"{"address":"OldBase","chain":"base","coverage":0,"launchedAtMs":\#(ms(7200))}"#),
            t(#"{"address":"NewBsc","chain":"bsc","coverage":0,"launchedAtMs":\#(ms(60))}"#),
            t(#"{"address":"SeenBase","chain":"base","coverage":0,"seen":true,"seenAtMs":\#(ms(30)),"launchedAtMs":\#(ms(9000))}"#),
        ]
        #expect(DiscoverRanking.rank(.basebnb, list).map(\.address) == ["SeenBase", "NewBsc", "OldBase", "NoTime"])
    }

    @Test("Thirty rows at most")
    func thirty() throws {
        let list = try (0..<50).map { try t(#"{"address":"A\#($0)","coverage":5,"score":50}"#) }
        #expect(DiscoverRanking.rank(.pinrindex, list).count == 30)
    }

    @Test("Search: name or ticker (a leading $ ignored), any case; biggest first")
    func search() throws {
        let list = try [
            t(#"{"address":"Small","coverage":5,"name":"Zircon Mini","ticker":"$ZM","valuationUsd":1000}"#),
            t(#"{"address":"Big","coverage":5,"name":"Other","ticker":"$ZRN","valuationUsd":1000000}"#),
            t(#"{"address":"No","coverage":5,"name":"Nothing","ticker":"$NO","valuationUsd":5000000}"#),
        ]
        #expect(DiscoverRanking.rank(.movers, list, query: "z").map(\.address) == ["Big", "Small"])
        #expect(DiscoverRanking.rank(.movers, list, query: "$zrn").map(\.address) == ["Big"])
        #expect(DiscoverRanking.rank(.movers, list, query: "  ZIRCON ").map(\.address) == ["Small"])
    }

    @Test("Search by address only from six characters on")
    func addressSearch() throws {
        let list = try [t(#"{"address":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU","coverage":5,"name":"N","ticker":"$T"}"#)]
        #expect(DiscoverRanking.rank(.movers, list, query: "7xkxt").isEmpty)
        #expect(DiscoverRanking.rank(.movers, list, query: "7xkxtg").count == 1)
    }

    @Test("The search finds coins outside the tab's own list")
    func searchIgnoresTab() throws {
        let list = try [t(#"{"address":"Old","coverage":5,"name":"Ancient","launchedAtMs":1000}"#)]
        #expect(DiscoverRanking.rank(.fresh, list).isEmpty)
        #expect(DiscoverRanking.rank(.fresh, list, query: "anc").count == 1)
    }

    @Test("The lite chart: none without a series or for a copy; log scale past six times; whose history it is")
    func liteChart() throws {
        #expect(LiteChart(try t(#"{"address":"A","coverage":5}"#)) == nil)
        #expect(LiteChart(try t(#"{"address":"A","coverage":5,"noScoreLabel":"VAMP","priceSeries":[1,2]}"#)) == nil)
        let wide = try #require(LiteChart(try t(#"{"address":"A","coverage":5,"priceSeries":[1,7],"priceSource":"GeckoTerminal"}"#)))
        #expect(wide.logScale && wide.rising && wide.label == "1h · GeckoTerminal")
        let narrow = try #require(LiteChart(try t(#"{"address":"A","coverage":5,"priceSeries":[3,2],"priceSource":"PINR tape"}"#)))
        #expect(!narrow.logScale && !narrow.rising && narrow.label == "PINR tape · tracked")
        #expect(try #require(LiteChart(try t(#"{"address":"A","coverage":5,"priceSeries":[3,2]}"#))).label == nil)
    }
}

@Suite("Arena (259)")
struct ArenaTests {
    @Test("A group's members, the 500+ floor and the dashes; a bad group or member is dropped alone")
    func decode() throws {
        let json = #"{"groups":[{"id":"g1","title":"musepad","ticker":"$musepad","members":[{"address":"A1","name":"musepad","ticker":"$musepad","chain":"solana","launchpad":"PumpSwap (graduated)","launchedAtMs":1792950084000,"recentTrades":500,"recentUsd":20893.3,"recentAtLeast":true,"volume24hUsd":58086,"xPosts":0,"hasX":true,"change24hPct":12.5,"valuationUsd":41802,"earliest":true},{"address":"B1","name":"musepad","chain":"bsc","recentTrades":0,"recentUsd":0,"recentAtLeast":false,"volume24hUsd":null,"xPosts":null,"hasX":false,"change24hPct":null,"valuationUsd":null,"earliest":false},{"name":"no address"}]},{"title":"no id"}]}"#
        let g = try JSONDecoder().decode(WireArena.self, from: Data(json.utf8)).groups
        #expect(g.count == 1 && g[0].members.count == 2)
        let a = g[0].members[0], b = g[0].members[1]
        #expect(a.recentText == "$20.89K+ · 500+ tx" && a.xText == "0 posts" && a.earliest)
        #expect(b.recentText == "— · 0 tx" && b.xText == "—" && b.volume24h == nil && b.valuation == nil)
    }

    @Test("A member whose 30-minute figures were not read yet shows a dash, never $0 · 0 tx; a missing field counts as read (266)")
    func recentKnown() throws {
        let json = #"{"groups":[{"id":"g","title":"t","ticker":"$t","members":[{"address":"A1","recentKnown":false,"recentTrades":0,"recentUsd":0},{"address":"B1","recentTrades":3,"recentUsd":12}]}]}"#
        let m = try JSONDecoder().decode(WireArena.self, from: Data(json.utf8)).groups[0].members
        #expect(m[0].recentText == "—" && m[1].recentText == "\(Format.usdCompact(12)) · 3 tx")
    }

    @Test("A name or ticker made only of invisible characters counts as missing (266): the member's short address shows")
    func invisibleOnlyName() throws {
        let json = #"{"groups":[{"id":"g","title":"t","ticker":"$t","members":[{"address":"AbCdEfGhIjKlMnOpQrSt","name":"\u200B\u2060\u3164","ticker":"\u200B","recentTrades":0,"recentUsd":0}]}]}"#
        let m = try JSONDecoder().decode(WireArena.self, from: Data(json.utf8)).groups[0].members[0]
        #expect(m.name == nil && m.ticker == nil)
    }

    @Test("The engine's hourly trade count is preferred on a tile, then the feed's, then a dash")
    func hour() throws {
        let t = try token(#"{"address":"A","coverage":50,"hourTrades":{"n":87,"buys":50,"sells":37},"flow":{"buy5m":1,"sell5m":1,"buy1h":1,"sell1h":1,"n5m":3,"n1h":20,"lastAt":null,"complete":true}}"#)
        #expect(t.hourTrades == 87)
        #expect(Format.tilePlusTrades("$1K", t.flow, hour: t.hourTrades) == "$1K · 87 tx/1h")
        #expect(Format.tilePlusTrades("$1K", t.flow) == "$1K · 20 tx/1h")
        #expect(Format.tilePlusTrades("$1K", nil) == "$1K · — tx")
    }
}

@Suite("Invisible characters")
struct InvisibleTests {
    @Test("Zero-width and invisible characters are taken out of names and tickers; plain text, emoji and accents stay")
    func strip() throws {
        #expect(Invisible.strip("Blind\u{2060} Ape") == "Blind Ape")
        #expect(Invisible.strip("a\u{200B}b\u{200D}c\u{FEFF}d\u{00AD}e\u{202E}f") == "abcdef")
        #expect(Invisible.strip("Café 🐸 ÿ") == "Café 🐸 ÿ")
        // A joiner between two emoji stays (one built emoji); a lone joiner goes; a variation selector 16 stays only after an emoji; spaces collapse.
        #expect(Invisible.strip("👨\u{200D}💻 Dev") == "👨\u{200D}💻 Dev")
        #expect(Invisible.strip("a\u{200D}b 👨\u{200D}") == "ab 👨")
        #expect(Invisible.strip("❤\u{FE0F} x\u{FE0F}") == "❤\u{FE0F} x")
        #expect(Invisible.strip("  a \u{0007}  b\u{3164} ") == "a b")
        let t = try token(#"{"address":"A","coverage":50,"name":"Blind\u2060 Ape","ticker":"$AP\u200bE"}"#)
        #expect(t.name == "Blind Ape" && t.ticker == "$APE")
    }
}

@Suite("Engine note (W4) and nameless coins (W1)")
struct EngineNoteTests {
    @Test("A status part (technical error, retrying) is never shown as a finding; the rest is; nothing left, no note")
    func parts() {
        #expect(EngineNote.shown("Technical error, retrying") == nil)
        #expect(EngineNote.shown("no dev wallet read; Technical error, retrying; thin liquidity") == "no dev wallet read; thin liquidity")
        #expect(EngineNote.shown("Retrying the holders read") == nil)
        #expect(EngineNote.shown("thin liquidity") == "thin liquidity" && EngineNote.shown(nil) == nil && EngineNote.shown(" ; ") == nil)
    }
    @Test("A coin with no name shows its address: 6 characters, an ellipsis, 4")
    func nameless() {
        #expect(PoolWords.shortAddress("AAxKPE8TEUfLH7txHppZNk5aP5V2i7PEZL6qf8Rwpump") == "AAxKPE…pump" && PoolWords.shortAddress("short") == "short")
    }
}
