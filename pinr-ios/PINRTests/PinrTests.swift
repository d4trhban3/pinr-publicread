import Foundation
import Testing
@testable import PINR

/// A token for the ranking tests, built through the same rules as the feed's.
private func tok(_ address: String, score: Int? = nil, coverage: Double = 50, label: String? = nil,
                 mcap: Double? = nil, launchedMinutesAgo: Double? = nil, lastTradeSecondsAgo: Double? = nil,
                 trades5m: Int? = nil, scoredSecondsAgo: Double? = nil, seenSecondsAgo: Double? = nil, seen: Bool? = nil,
                 now: Date = Date(timeIntervalSince1970: 2_000_000_000)) throws -> Token {
    var fields = [#""address":"\#(address)""#, #""coverage":\#(coverage)"#]
    if let score { fields.append(#""score":\#(score)"#) }
    if let label { fields.append(#""noScoreLabel":"\#(label)""#) }
    if let mcap { fields.append(#""valuationUsd":\#(mcap)"#) }
    if let m = launchedMinutesAgo { fields.append(#""launchedAtMs":\#((now.timeIntervalSince1970 - m * 60) * 1000)"#) }
    if let s = lastTradeSecondsAgo { fields.append(#""lastTradeMs":\#((now.timeIntervalSince1970 - s) * 1000)"#) }
    if let a = scoredSecondsAgo { fields.append(#""asOfMs":\#((now.timeIntervalSince1970 - a) * 1000)"#) }
    if let a = seenSecondsAgo { fields.append(#""seenAtMs":\#((now.timeIntervalSince1970 - a) * 1000)"#) }
    if let seen { fields.append(#""seen":\#(seen)"#) }
    if let n = trades5m {
        fields.append(#""flow":{"buy5m":1,"sell5m":1,"buy1h":1,"sell1h":1,"n5m":\#(n),"n1h":\#(n),"lastAt":null,"complete":true}"#)
    }
    return try token("{" + fields.joined(separator: ",") + "}")
}

private let now = Date(timeIntervalSince1970: 2_000_000_000)

@Suite("The PINR page's ranking")
struct RankingTests {
    @Test("PINR Index: only real scores, highest first; flagged, unscored and no-coverage coins are not in it")
    func pinrindex() throws {
        let list = try [
            tok("A", score: 40), tok("B", score: 90), tok("C", label: "VAMP"),
            tok("D", coverage: 0), tok("E", score: 70, coverage: 0), tok("F", score: 90),
        ]
        #expect(Ranking.rank(.pinrindex, list, now: now).map(\.address) == ["B", "F", "A"])
    }

    @Test("New Launches: under an hour old, newest first; an unknown age is not new")
    func newLaunches() throws {
        let list = try [
            tok("Old", launchedMinutesAgo: 61), tok("Mid", launchedMinutesAgo: 30),
            tok("Fresh", launchedMinutesAgo: 2), tok("NoAge"),
        ]
        #expect(Ranking.rank(.new, list, now: now).map(\.address) == ["Fresh", "Mid"])
    }

    @Test("Movers: the biggest score change since the app opened, either way")
    func movers() throws {
        let list = try [tok("A", score: 50), tok("B", score: 50), tok("C", score: 50)]
        let ranked = Ranking.rank(.movers, list, moved: ["b": -12, "c": 5], now: now)
        #expect(ranked.map(\.address) == ["B", "C", "A"])
    }

    @Test("Trending: no order of the app's own; a coin not scored yet is not pushed behind the read ones")
    func noOwnOrder() throws {
        let list = try [
            tok("Unread", coverage: 0, mcap: 9e9, lastTradeSecondsAgo: 1, trades5m: 900),
            tok("Read", score: 20, mcap: 1000),
        ]
        #expect(Ranking.rank(.trending, list, now: now).map(\.address) == ["Unread", "Read"])
    }

    @Test("coins scored in the last 24 hours come first, newest first, then new unscored coins; the rest follow by what is moving")
    func recentFirst() throws {
        let list = try [
            tok("Busy", score: 50, mcap: 1e4, lastTradeSecondsAgo: 5, trades5m: 200),
            tok("ScoredOld", score: 50, mcap: 1e9, scoredSecondsAgo: 25 * 3600),
            tok("SeenOld", coverage: 0, seenSecondsAgo: 23 * 3600, seen: true),
            tok("Scored1h", score: 40, scoredSecondsAgo: 3600),
            tok("SeenNow", coverage: 0, seenSecondsAgo: 30, seen: true),
        ]
        #expect(Ranking.rank(.trending, list, now: now).map(\.address) == ["Scored1h", "SeenNow", "SeenOld", "Busy", "ScoredOld"])
    }

    @Test("An unscored coin counts from when it was met, else from its launch, never from `as_of` (a retrying coin moves it each retry)")
    func unscoredTimes() throws {
        let list = try [
            tok("Retrying", coverage: 0, launchedMinutesAgo: 3 * 24 * 60, scoredSecondsAgo: 30),
            tok("Seen2h", coverage: 0, seenSecondsAgo: 2 * 3600, seen: true),
            tok("Launched1h", coverage: 0, launchedMinutesAgo: 60),
            tok("Scored", score: 40, scoredSecondsAgo: 3600),
        ]
        #expect(Ranking.rank(.trending, list, now: now).map(\.address) == ["Scored", "Launched1h", "Seen2h", "Retrying"])
    }

    @Test("A seen coin counts from when it was seen; a time in the future and a tie keep the feed's order")
    func recentEdges() throws {
        let list = try [
            tok("Future", score: 10, scoredSecondsAgo: -600),
            tok("TieA", score: 10, scoredSecondsAgo: 100),
            tok("TieB", score: 10, scoredSecondsAgo: 100),
            tok("Skew", score: 10, scoredSecondsAgo: -30),
        ]
        #expect(Ranking.rank(.trending, list, now: now).map(\.address) == ["Skew", "TieA", "TieB", "Future"])
    }

    @Test("`seen` counts only on a coin without a score or a label, and carries its time")
    func seenRules() throws {
        let seen = try tok("S", coverage: 0, seenSecondsAgo: 60, seen: true)
        #expect(seen.seenAt == Date(timeIntervalSince1970: now.timeIntervalSince1970 - 60))
        #expect(try tok("Scored", score: 40, seenSecondsAgo: 60, seen: true).seenAt == nil)
        #expect(try tok("Flag", label: "VAMP", seenSecondsAgo: 60, seen: true).seenAt == nil)
        #expect(try tok("No", coverage: 0, seenSecondsAgo: 60).seenAt == nil)
        // with no time of its own, a seen coin counts from the feed's own read time
        let bare = try token(#"{"address":"B","coverage":0,"seen":true,"asOfMs":1999999000000}"#)
        #expect(bare.seenAt == Date(timeIntervalSince1970: 1_999_999_000))
    }

    @Test("Trending: busy and just traded rank above merely big")
    func busyFirst() throws {
        let list = try [
            tok("Big", score: 50, mcap: 1e9),
            tok("Busy", score: 50, mcap: 1e4, lastTradeSecondsAgo: 5, trades5m: 200),
            tok("Quiet", score: 50, mcap: 1e5, lastTradeSecondsAgo: 3600, trades5m: 0),
        ]
        #expect(Ranking.rank(.trending, list, now: now).map(\.address) == ["Busy", "Big", "Quiet"])
    }

    @Test("The page shows the top 90, ties in the feed's own order")
    func limitAndTies() throws {
        let list = try (0..<120).map { try tok("T\($0)", score: 50) }
        let ranked = Ranking.rank(.pinrindex, list, now: now)
        #expect(ranked.count == 90)
        #expect(ranked.first?.address == "T0" && ranked.last?.address == "T89")
    }

    @Test("Size weight: log of market cap across the set; unknown is the floor")
    func weights() throws {
        let w = Ranking.baseWeights(try [tok("A", mcap: 1e3), tok("B", mcap: 1e9), tok("C")])
        #expect(abs(w[0] - 0.2) < 1e-9 && abs(w[1] - 0.74) < 1e-9 && w[2] == 0.12)
    }
}

@Suite("A tile's ribbon and badge")
struct TileTests {
    private func flow(buy5m: Double, sell5m: Double, n5m: Int, buy1h: Double, sell1h: Double, n1h: Int) -> Token.Flow {
        Token.Flow(buy5m: buy5m, sell5m: sell5m, buy1h: buy1h, sell1h: sell1h, trades5m: n5m, trades1h: n1h, isCount: false, complete: true)
    }

    @Test("No trades in the last hour: no ribbon")
    func noRibbon() {
        #expect(Ribbon(nil) == nil)
        #expect(Ribbon(flow(buy5m: 0, sell5m: 0, n5m: 0, buy1h: 0, sell1h: 0, n1h: 0)) == nil)
    }

    @Test("The real mix: the last five minutes when busy enough, else the hour, else even")
    func mix() {
        #expect(Ribbon(flow(buy5m: 75, sell5m: 25, n5m: 4, buy1h: 10, sell1h: 90, n1h: 40))?.buyShare == 0.75)
        #expect(Ribbon(flow(buy5m: 100, sell5m: 0, n5m: 2, buy1h: 10, sell1h: 90, n1h: 40))?.buyShare == 0.1)
        #expect(Ribbon(flow(buy5m: 0, sell5m: 0, n5m: 0, buy1h: 5, sell1h: 0, n1h: 2))?.buyShare == 0.5)
    }

    @Test("Busier coins move faster; the number of streaks never changes")
    func speed() throws {
        let calm = try #require(Ribbon(flow(buy5m: 1, sell5m: 1, n5m: 1, buy1h: 1, sell1h: 1, n1h: 3)))
        let busy = try #require(Ribbon(flow(buy5m: 1, sell5m: 1, n5m: 300, buy1h: 1, sell1h: 1, n1h: 900)))
        #expect(busy.speed > calm.speed)
        for i in 0..<Ribbon.streaks {
            let u = busy.streak(i, at: 1234.5).u
            #expect(u >= 0 && u < 1)
        }
    }

    @Test("All buys draw only buy streaks")
    func allBuys() throws {
        let r = try #require(Ribbon(flow(buy5m: 9, sell5m: 0, n5m: 9, buy1h: 9, sell1h: 0, n1h: 9)))
        #expect((0..<Ribbon.streaks).allSatisfy { r.streak($0, at: 0).buy })
    }

    @Test("The badge: the pair's coin and the launchpad, short; none for a copy or when both are unknown")
    func badge() throws {
        let t = try token(#"{"address":"A","coverage":5,"quotePair":"ZRN / SOL","launchpad":"pump.fun"}"#)
        #expect(Badge.text(for: t) == "SOL · pump")
        #expect(Badge.text(for: try token(#"{"address":"A","coverage":5,"launchpad":"letsbonk"}"#)) == "bonk")
        #expect(Badge.text(for: try token(#"{"address":"A","coverage":5}"#)) == nil)
        #expect(Badge.text(for: try token(#"{"address":"A","coverage":5,"noScoreLabel":"VAMP","launchpad":"pump.fun"}"#)) == nil)
    }

    @Test("All-time high: kept only when above zero; missing otherwise")
    func ath() throws {
        #expect(try token(#"{"address":"A","coverage":5,"athUsd":2500000,"athSource":"Pump.fun","athAtMs":1791650000000}"#).athUsd == 2_500_000)
        #expect(try token(#"{"address":"A","coverage":5,"athUsd":0}"#).athUsd == nil)
        #expect(Format.usdCompact(try token(#"{"address":"A","coverage":5}"#).athUsd) == "—")
    }
}

@MainActor
@Suite("Score moves since the app opened", .serialized)
struct MovedTests {
    @Test("A change in score is a move; a label or a missing score is not")
    func moves() async {
        var score = 50
        var label = "null"
        StubFeed.answer = { _ in
            (200, #"{"contract":"1.0","tokens":[{"address":"A","coverage":50,"score":\#(score),"noScoreLabel":\#(label)}]}"#)
        }
        let s = FeedStore(baseURL: feedBase, session: StubFeed.session())
        await s.poll()
        #expect(s.moved.isEmpty)
        score = 62
        await s.poll()
        #expect(s.moved["a"] == 12)
        label = #""BOT/RUG""#
        await s.poll()
        #expect(s.moved["a"] == 12)
        label = "null"; score = 50
        await s.poll()
        #expect(s.moved["a"] == nil)
    }
}

@Suite("tiles")
struct Tile260Tests {
    @Test("A trade's size is its height: a buy rides above the line, a sell below, up to 17% of the tile, swooping at now")
    func sizeOffset() {
        #expect(Ribbon.sizeOffset(1, buy: true, u: 0.5) == -0.17)
        #expect(Ribbon.sizeOffset(1, buy: false, u: 0.5) == 0.17)
        #expect(Ribbon.sizeOffset(0, buy: true, u: 1) == 0)
        #expect(abs(Ribbon.sizeOffset(1, buy: true, u: 1) - (-0.17 * 1.6)) < 1e-9)
        #expect(Ribbon.sizeOffset(2, buy: false, u: 0) == 0.17)
    }

    @Test("The hour's trades beside the market cap; a dash when no source counts them; counts are short")
    func trades() throws {
        #expect(Format.tilePlusTrades("$3.9K", nil) == "$3.9K · — tx")
        let t = try token(#"{"address":"A","coverage":50,"flow":{"buy5m":1,"sell5m":1,"buy1h":1,"sell1h":1,"n5m":3,"n1h":20,"lastAt":null,"complete":true}}"#)
        #expect(Format.tilePlusTrades("$3.9K", t.flow) == "$3.9K · 20 tx/1h")
        #expect(Format.countShort(87) == "87" && Format.countShort(1240) == "1,240" && Format.countShort(12_400) == "12.4K" && Format.countShort(1_200_000) == "1.2M")
    }
}
