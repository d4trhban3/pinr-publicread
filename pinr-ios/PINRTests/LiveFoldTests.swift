import Foundation
import Testing
@testable import PINR

/// a trade from the stream moves the tile at once.
@Suite("Live fold")
struct LiveFoldTests {
    static let at = Date(timeIntervalSince1970: 2_000_000_000)
    private func coin(price: Double? = 2, cap: Double? = 1000) throws -> Token {
        var f = [#""address":"A","coverage":50"#]
        if let price { f.append(#""priceUsd":\#(price)"#) }
        if let cap { f.append(#""valuationUsd":\#(cap)"#) }
        f.append(#""flow":{"buy5m":10,"sell5m":5,"buy1h":20,"sell1h":15,"n5m":3,"n1h":8,"lastAt":null,"complete":true}"#)
        f.append(#""priceSeries":[1,2]"#)
        return try token("{" + f.joined(separator: ",") + "}")
    }

    @Test("The price becomes the trade's, the cap scales by new over old, the line gets its newest point")
    func price() throws {
        let t = try coin().folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 4, isBuy: true))
        #expect(t.priceUsd == 3 && t.valuationUsd == 1500 && t.priceSeries == [1, 2, 3] && t.lastTrade == Self.at)
    }

    @Test("A coin with no cap keeps none; a coin with no old price keeps its cap")
    func missing() throws {
        let noCap = try coin(cap: nil).folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 4, isBuy: true))
        #expect(noCap.valuationUsd == nil && noCap.priceUsd == 3)
        let noPrice = try coin(price: nil).folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 4, isBuy: false))
        #expect(noPrice.valuationUsd == 1000 && noPrice.priceUsd == 3)
    }

    @Test("The ribbon takes the trade: dollars to the right side, one more trade in the count")
    func ribbon() throws {
        let buy = try coin().folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 4, isBuy: true))
        #expect(buy.flow?.buy5m == 14 && buy.flow?.sell5m == 5 && buy.flow?.buy1h == 24 && buy.flow?.trades5m == 4 && buy.flow?.trades1h == 9)
        let sell = try coin().folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 4, isBuy: false))
        #expect(sell.flow?.sell5m == 9 && sell.flow?.sell1h == 19 && sell.flow?.buy5m == 10)
        let priceOnly = try coin().folded(LiveTick(address: "a", at: Self.at, price: 3, usd: nil, isBuy: nil))
        #expect(priceOnly.flow?.trades5m == 3)
    }

    @Test("An older trade does not move the last-trade time back; a bad price changes nothing")
    func edges() throws {
        let newer = try coin().folded(LiveTick(address: "a", at: Self.at, price: 3, usd: 1, isBuy: true))
        let older = newer.folded(LiveTick(address: "a", at: Self.at.addingTimeInterval(-60), price: 3, usd: 1, isBuy: true))
        #expect(older.lastTrade == Self.at && older.priceUsd == 3 && older.flow?.trades5m == newer.flow.map { $0.trades5m + 1 })
        #expect(try coin().repriced(to: 0).priceUsd == 2 && (try coin().repriced(to: .nan).priceUsd == 2))
    }
}
