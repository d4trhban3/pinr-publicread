import Foundation
import Testing
@testable import PINR

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite("Step 5: the chart and the tape")
struct ChartTapeTests {
    @Test("Candles: rows of six good numbers, oldest first; a bad row is dropped, never guessed")
    func candles() throws {
        let w = try decode(WireCandles.self, #"""
        {"tf":"15m","source":"GeckoTerminal","status":"ok","candles":[
          [1700000900,2,3,1,2.5,100],[1700000000,1,2,0.5,1.5,50],
          [1700001800,0,1,1,1,1],[1700002700,1,0.5,1,1,1],[1700003600,1,2,1],[1700004500,null,2,1,1,1]]}
        """#)
        let set = w.set
        #expect(set.status == .ok && set.source == "GeckoTerminal")
        #expect(set.candles.map(\.close) == [1.5, 2.5])
        #expect(set.candles.first!.time < set.candles.last!.time)
    }

    @Test("A busy chart source says so; it is not an empty chart")
    func busy() throws {
        let set = try decode(WireCandles.self, #"{"tf":"1h","source":"GeckoTerminal","candles":[],"status":"busy"}"#).set
        #expect(set.status == .busy && set.candles.isEmpty)
    }

    @Test("a stale chart keeps its candles and says when they were read, never current")
    func stale() throws {
        let set = try decode(WireCandles.self, #"{"tf":"1m","source":"GeckoTerminal","status":"stale","asOfMs":1700000000000,"candles":[[1,1,2,1,2,1],[2,2,3,1,2,1]]}"#).set
        #expect(set.status == .stale && set.drawable)
        #expect(set.asOf == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(set.asOfText == Format.asOf(Date(timeIntervalSince1970: 1_700_000_000)))
        let ok = try decode(WireCandles.self, #"{"status":"ok","asOfMs":1700000000000,"candles":[[1,1,2,1,2,1],[2,2,3,1,2,1]]}"#).set
        #expect(ok.asOfText == nil && ok.asOf == nil)
    }

    @Test("The contract: a status the app does not know, a missing one, or stale without a read time is busy")
    func unknownIsBusy() throws {
        let rows = #"[[1,1,2,1,2,1],[2,2,3,1,2,1]]"#
        for head in [#""status":"later""#, #""source":"x""#, #""status":"stale""#, #""status":"stale","asOfMs":-5"#] {
            let set = try decode(WireCandles.self, "{\(head),\"candles\":\(rows)}").set
            #expect(set.status == .busy && !set.drawable && set.asOfText == nil, "\(head)")
        }
    }

    @Test("'as of' and the clock time of the read, as the site writes it")
    func asOfWords() {
        var c = DateComponents(); c.year = 2026; c.month = 10; c.day = 16; c.hour = 14; c.minute = 32
        let d = Calendar.current.date(from: c)!
        #expect(Format.asOf(d) == "as of 2:32 PM")
        c.hour = 9; c.minute = 5
        #expect(Format.asOf(Calendar.current.date(from: c)!) == "as of 9:05 AM")
    }

    @Test("Log scale past six times, as on the site")
    func logScale() throws {
        let wide = try decode(WireCandles.self, #"{"status":"ok","candles":[[1,1,7,1,6,1],[2,6,7,1,7,1]]}"#).set
        let narrow = try decode(WireCandles.self, #"{"status":"ok","candles":[[1,1,2,1,2,1],[2,2,3,1,2,1]]}"#).set
        #expect(wide.logScale && !narrow.logScale)
        #expect(narrow.range == 1...3)
        // Only the newest 80 are drawn, and the range is theirs alone.
        let rows = (0..<100).map { i in i < 20 ? "[\(i + 1),0.001,0.001,0.001,0.001,1]" : "[\(i + 1),1,2,1,2,1]" }.joined(separator: ",")
        let many = try decode(WireCandles.self, "{\"status\":\"ok\",\"candles\":[\(rows)]}").set
        #expect(many.shown.count == 80 && many.range == 1...2 && !many.logScale)
    }

    @Test("The tape: buy or sell only, sizes above zero, newest first; the summary kept")
    func tape() throws {
        let t = try decode(WireTape.self, #"""
        {"none":false,"complete":false,"coversFrom":1,"asOf":2,
         "trades":[[100,"buy",5],[300,"sell",7.5],[200,"hold",3],[400,"buy",0],[500,"buy"],"junk",[250,"buy",1]],
         "summary":{"buy5m":5,"sell5m":7.5,"buy1h":6,"sell1h":7.5,"n5m":2,"n1h":3,"lastAt":300,"complete":false,"asOf":2}}
        """#).tape
        #expect(t.trades.map(\.usd) == [7.5, 1, 5])
        #expect(t.trades.first?.buy == false)
        #expect(!t.complete && !t.none)
        #expect(t.summary?.trades1h == 3)
    }

    @Test("No trade list yet: none, and no rows")
    func noTape() throws {
        let t = try decode(WireTape.self, #"{"none":true,"trades":[],"complete":false,"coversFrom":null,"asOf":null,"summary":null}"#).tape
        #expect(t.none && t.trades.isEmpty && t.summary == nil)
    }

    @Test("Events: plain, dated, in order; an undated one is dropped")
    func events() throws {
        let e = try decode(WireEvents.self, #"{"events":[{"t":20,"kind":"score_up","tone":"good","text":"Score moved up","from":25,"to":41},{"t":0,"kind":"note","tone":"neutral","text":"x"},{"t":10,"kind":"flag_raised","tone":"bad","text":"Flag raised"},{"bad":1}]}"#).events
        #expect(e.map(\.text) == ["Flag raised", "Score moved up"])
    }

    @Test("Prices with enough digits; trade sizes in full")
    func formats() {
        #expect(Format.price(nil) == "—")
        #expect(Format.price(1.23456) == "$1.23")
        #expect(Format.price(0.0004567) == "$0.000457")
        #expect(Format.price(0.0345) == "$0.0345")
        #expect(Format.price(64_250.5) == "$64,250.50")
        #expect(Format.priceCompact(0.0000495) == "$0.0₄495")
        #expect(Format.priceCompact(0.0000000922) == "$0.0₇922")
        #expect(Format.priceCompact(0.0012) == "$0.00120")
        #expect(Format.usd(1234.4) == "$1,234")
        #expect(Format.usd(12.5) == "$12.50")
        let now = Date(timeIntervalSince1970: 100_000)
        #expect(Format.ago(now.addingTimeInterval(-12), now: now) == "12s ago")
        #expect(Format.ago(now.addingTimeInterval(-300), now: now) == "5m ago")
        #expect(Format.ago(now.addingTimeInterval(-7200), now: now) == "2h ago")
    }
}

@Suite("Step 6: the dossier and its source lines")
struct DossierTests {
    private let full = #"""
    {"available":true,
     "facts":[
       {"id":"valuation","label":"Valuation","value":"$348,747,608","source":"Solana chain","readAtMs":1791999013000,"link":"https://pump.fun/coin/X"},
       {"id":"launcher","label":"Launcher wallet","value":"7xKX","copy":"7xKXfull","source":"Pump.fun","readAtMs":1791999013000,"link":"https://solscan.io/account/7xKX"},
       {"id":"dev_launches","label":"Launches by the launcher","value":"12","noSource":true},
       {"id":"liquidity_usd","label":"Liquidity","value":"$5,000","source":"Some Blog","readAtMs":1791999013000,"link":"https://x.example"},
       {"id":"volume_24h","label":"24-hour volume","value":"$9","source":"DexScreener","readAtMs":1791999013000,"link":"javascript:alert(1)"},
       {"label":""}],
     "checks":[{"name":"Liquidity depth","band":"Weak"},{"name":"Holders","band":"Not read","reason":"No free source answers this read today"},{"name":"Bad","band":"72"},{"name":"Social link","band":"Clear"}],
     "read":["One of the checks needs more price history."],
     "links":[{"label":"Website","url":"https://adtf.us/"},{"label":"Bad","url":"ftp://x"}],
     "channels":[{"id":"x","label":"X","status":"listed","url":"https://x.com/adtf","post":"someone"},{"id":"telegram","label":"Telegram","status":"not_listed"},{"id":"website","label":"Website","status":"listed","url":"nope"},{"id":"farcaster","label":"Farcaster","status":"unknown"}],
     "social":{"version":1,"scannedAtMs":1791999013000,"claims":[{"line":"Post says 1B supply. Dossier shows 1B. Result MATCHES","result":"MATCHES","handle":"a","postUrl":"https://x.com/a/1","removed":false},{"line":"Removed one","result":"DIVERGES","handle":"b","postUrl":"https://x.com/b/2","removed":true},{"line":"Odd","result":"MAYBE"}],"flags":[{"text":"The linked X account names another coin."}],"gaps":["X search"],"totals":{"MATCHES":1,"DIVERGES":1,"UNVERIFIABLE":0,"NOT CHECKABLE":0}}}
    """#

    @Test("A fact shows its figure only with its whole receipt from a named public source")
    func receipts() throws {
        let d = try decode(WireDossier.self, full).dossier
        let byId = Dictionary(uniqueKeysWithValues: d.facts.map { ($0.id, $0) })
        #expect(byId["valuation"]?.value == "$348,747,608")
        #expect(byId["valuation"]?.receipt?.source == "Solana chain")
        #expect(byId["launcher"]?.copy == "7xKXfull")
        #expect(byId["dev_launches"]?.value == "—" && byId["dev_launches"]?.receipt == nil)
        // A source off the fixed list, or a link that is not a web address: a dash with "no source".
        #expect(byId["liquidity_usd"]?.value == "—" && byId["liquidity_usd"]?.receipt == nil)
        #expect(byId["volume_24h"]?.value == "—")
        #expect(d.facts.count == 5)
    }

    @Test("Checks carry one known word each; an unknown word is dropped")
    func checks() throws {
        let d = try decode(WireDossier.self, full).dossier
        #expect(d.checks.map(\.name) == ["Liquidity depth", "Holders", "Social link"])
        #expect(d.checks[1].band == .notRead && d.checks[1].reason != nil)
    }

    @Test("Links: web addresses only; a channel listed without a real link is not read")
    func links() throws {
        let d = try decode(WireDossier.self, full).dossier
        #expect(d.links.map(\.label) == ["Website"])
        #expect(d.channels.first { $0.id == "x" }?.postBy == "someone")
        #expect(d.channels.first { $0.id == "website" }?.status == .unknown)
        #expect(d.channels.first { $0.id == "telegram" }?.status == .notListed)
    }

    @Test("Social (not scored): known results only; a removed post keeps no link; the site's totals sentence")
    func social() throws {
        let s = try #require(try decode(WireDossier.self, full).dossier.social)
        #expect(s.claims.count == 2)
        #expect(s.claims[1].removed && s.claims[1].postURL == nil)
        #expect(s.flags == ["The linked X account names another coin."])
        #expect(Dossier.totalsSentence(s.totals) == "2 claims read: 1 match, 1 differ, 0 cannot be checked, 0 not checkable.")
        #expect(Dossier.totalsSentence([:]) == "No claims were recorded.")
    }

    @Test("A flagged coin's checks are held back")
    func flagged() throws {
        let d = try decode(WireDossier.self, #"{"available":true,"facts":[],"checks":[{"name":"A","band":"Weak"}],"read":[],"links":[],"channels":[],"held":"flagged"}"#).dossier
        #expect(d.flagged && d.checks.isEmpty)
    }

    @Test("No dossier file: available is false and nothing is invented")
    func unavailable() throws {
        let d = try decode(WireDossier.self, #"{"available":false,"facts":[],"checks":[],"read":[],"links":[],"channels":[],"social":null}"#).dossier
        #expect(!d.available && d.facts.isEmpty && d.social == nil)
    }
}

@MainActor
@Suite("Reading one coin from the feed", .serialized)
struct CoinClientTests {
    @Test("Each read asks the feed for that coin only, by its address")
    func asks() async throws {
        StubFeed.asked = []
        StubFeed.answer = { url in
            switch url.path {
            case "/api/candles": (200, #"{"tf":"1h","source":"PINR tape","candles":[[1,1,2,1,2,5],[2,2,3,1,2,5]],"status":"ok"}"#)
            case "/api/trades": (200, #"{"none":true,"trades":[],"complete":false,"summary":null}"#)
            case "/api/events": (200, #"{"events":[]}"#)
            case "/api/dossier": (404, #"{"error":"unknown token"}"#)
            default: (404, "{}")
            }
        }
        let c = CoinClient(baseURL: feedBase, session: StubFeed.session())
        #expect(try await c.candles("Abc", .h1).candles.count == 2)
        #expect(try await c.tape("Abc").none)
        #expect(try await c.events("Abc").isEmpty)
        await #expect(throws: CoinClient.Failure.status(404)) { try await c.dossier("Abc") }
        #expect(StubFeed.asked == ["/api/candles?address=Abc&tf=1h", "/api/trades?address=Abc", "/api/events?address=Abc", "/api/dossier?address=Abc"])
    }
}

@Suite("Steps 5 and 6 in the site's design")
struct SiteStyleCoinTests {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)

    private func coin(_ a: String, chain: String? = "solana", pad: String? = "pump.fun", mcap: Double? = nil, ageMin: Double? = nil, score: Int? = 50) throws -> Token {
        var f = [#""address":"\#(a)""#, #""coverage":40"#]
        if let chain { f.append(#""chain":"\#(chain)""#) }
        if let pad { f.append(#""launchpad":"\#(pad)""#) }
        if let mcap { f.append(#""valuationUsd":\#(mcap)"#) }
        if let ageMin { f.append(#""launchedAtMs":\#((now.timeIntervalSince1970 - ageMin * 60) * 1000)"#) }
        if let score { f.append(#""score":\#(score)"#) }
        return try token("{" + f.joined(separator: ",") + "}")
    }

    @Test("Similar tokens: same chain only, nearest in size and age, never more than about 30 times apart")
    func similar() throws {
        let base = try coin("Base", mcap: 1e6, ageMin: 600)
        let all = try [base,
                       coin("Near", mcap: 1.2e6, ageMin: 500), coin("Far", mcap: 5e5, ageMin: 6000),
                       coin("Huge", mcap: 1e9, ageMin: 600), coin("OtherChain", chain: "base", mcap: 1e6, ageMin: 600),
                       coin("NoFacts", pad: nil)]
        #expect(Similar.tokens(to: base, in: all, now: now).map(\.address) == ["Near", "Far"])
        #expect(Similar.tokens(to: try coin("X", chain: nil), in: all, now: now).isEmpty)
    }

    @Test("Each check's word wears the site's tint; Not read carries its reason")
    func chips() {
        #expect(Chip.tone(.strong) == .good && Chip.tone(.fair) == .fair && Chip.tone(.weak) == .weak)
        #expect(Chip.tone(.clear) == .clear && Chip.tone(.notRead) == .none && Chip.tone(.noData) == .none)
    }

    @Test("PINRmetric: drawn only with two or more points; otherwise not available")
    func metric() throws {
        let m = try JSONDecoder().decode(WireMetric.self, from: Data(#"{"metric":{"name":"PINRmetric","timeframe":"scan","asOf":"","series":[[2,60],[1,50]],"signal":[[1,55],[2,57]],"histogram":[[1,-5],[2,3]],"levels":[30,70]}}"#.utf8)).metric
        #expect(m?.series.map(\.v) == [50, 60] && m?.levels == [30, 70])
        #expect(try JSONDecoder().decode(WireMetric.self, from: Data(#"{"metric":null}"#.utf8)).metric == nil)
        #expect(try JSONDecoder().decode(WireMetric.self, from: Data(#"{"metric":{"series":[[1,50]]}}"#.utf8)).metric == nil)
    }
}

@Suite("Watchlist and price alerts (the site's watchlist.ts)")
struct WatchTests {
    private func alert(_ key: String, _ level: Double, _ dir: String) -> PriceAlert {
        PriceAlert(id: UUID().uuidString, key: key, ticker: "$T", level: level, dir: dir, created: 0)
    }

    @Test("An alert points up or down from the price now; none at the same price or without a price")
    func direction() {
        #expect(Watch.alertDir(level: 2, current: 1) == "up" && Watch.alertDir(level: 0.5, current: 1) == "down")
        #expect(Watch.alertDir(level: 1, current: 1) == nil && Watch.alertDir(level: 1, current: nil) == nil && Watch.alertDir(level: -1, current: 1) == nil)
    }

    @Test("The star toggles, newest first, at most 100")
    func star() {
        #expect(Watch.toggle(["a"], "b") == ["b", "a"] && Watch.toggle(["a", "b"], "a") == ["b"])
        #expect(Watch.toggle((0..<100).map(String.init), "x").count == 100)
    }

    @Test("Alerts fire at or past their level; a missing price fires nothing")
    func fire() {
        let list = [alert("A", 2, "up"), alert("B", 1, "down"), alert("C", 5, "up")]
        let (fired, waiting) = Watch.check(list, price: { ["A": 2.0, "B": 1.5][$0] })
        #expect(fired.map(\.key) == ["A"] && waiting.map(\.key) == ["B", "C"])
        #expect(Watch.toast(fired) == "Alert: $T rose to $2.00")
    }

    @Test("Adding the same alert twice keeps one")
    func duplicate() {
        let a = alert("A", 2, "up")
        #expect(Watch.add(Watch.add([], a), alert("A", 2, "up")).count == 1)
    }
}
