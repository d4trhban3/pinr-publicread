import Foundation
import Testing
@testable import PINR

/// Builds a feed record from JSON text, the way the server sends it.
func wire(_ json: String) throws -> WireToken {
    try JSONDecoder().decode(WireToken.self, from: Data(json.utf8))
}

let feedBase = URL(string: "http://127.0.0.1:8787")!

func token(_ json: String) throws -> Token {
    try Token.make(from: wire(json), feedBase: feedBase).get()
}

@Suite("A token from the feed")
struct TokenTests {
    @Test("A full record keeps every figure")
    func fullRecord() throws {
        let t = try token(#"""
        {"address":"So1Addr111","chain":"solana","launchpad":"pump.fun","name":"Zircon","ticker":"$ZRN",
         "imageUrl":"/api/img?a=So1Addr111","score":72,"coverage":45,"noScoreLabel":null,"note":null,
         "valuationUsd":376110000,"volume24hUsd":1200,"change24hPct":38.4,"priceSeries":[1,2,3],
         "launchedAtMs":1791650000000,"asOfMs":1791650001000.5,"rank":3,"priceUsd":0.00012,"liquidityUsd":5000,
         "quotePair":"ZRN / SOL","changeWindowH":5,"priceSource":"Pump.fun","lastTradeMs":1791650002000,
         "quoteSource":"DexScreener","quoteAtMs":1791650003000,
         "flow":{"buy5m":10,"sell5m":5,"buy1h":100,"sell1h":50,"n5m":3,"n1h":20,"lastAt":1791650,"complete":true,"asOf":null},
         "possibleCopyOf":{"address":"Orig111","ticker":"$ORIG","proof":"chain"}}
        """#)
        #expect(t.score == 72)
        #expect(t.coverage == 45)
        #expect(t.label == nil)
        #expect(t.ticker == "$ZRN")
        #expect(t.imageURL?.absoluteString == "http://127.0.0.1:8787/api/img?a=So1Addr111")
        #expect(t.valuationUsd == 376_110_000)
        #expect(t.priceSeries == [1, 2, 3, 0.00012]) // the live price joins the tracked line
        #expect(t.rank == 3)
        #expect(t.quoteReceipt?.source == "DexScreener")
        #expect(t.flow?.trades1h == 20)
        #expect(t.flow?.isCount == false)
        #expect(t.possibleCopyOf?.chainProven == true)
        #expect(t.launchedAt == Date(timeIntervalSince1970: 1_791_650_000))
    }

    @Test("Only address and coverage are needed; every other figure is missing, not zero")
    func minimalRecord() throws {
        let t = try token(#"{"address":"Abc","coverage":0}"#)
        #expect(t.score == nil)
        #expect(t.name == nil && t.ticker == nil && t.imageURL == nil)
        #expect(t.valuationUsd == nil && t.volume24hUsd == nil && t.change24hPct == nil)
        #expect(t.priceSeries == nil && t.flow == nil && t.rank == nil)
    }

    @Test("A no-score label always wins: the number is dropped", arguments: NoScoreLabel.allCases)
    func labelDropsNumber(label: NoScoreLabel) throws {
        let t = try token(#"{"address":"A1","coverage":30,"score":55,"noScoreLabel":"\#(label.rawValue)"}"#)
        #expect(t.label == label)
        #expect(t.score == nil)
        #expect(Format.score(t) == label.rawValue)
    }

    @Test("A score outside 1 to 99, or not whole, means no number", arguments: [0.0, 100, -5, 42.5, 1e9])
    func badScores(score: Double) throws {
        let t = try token(#"{"address":"A1","coverage":30,"score":\#(score)}"#)
        #expect(t.score == nil)
        #expect(Format.score(t) == "—")
    }

    @Test("The edges 1 and 99 are scores")
    func edgeScores() throws {
        #expect(try token(#"{"address":"A","coverage":1,"score":1}"#).score == 1)
        #expect(try token(#"{"address":"A","coverage":1,"score":99}"#).score == 99)
    }

    @Test("A field of the wrong type is missing, and the rest of the token is kept")
    func wrongTypes() throws {
        let t = try token(#"{"address":"A","coverage":10,"score":"72","valuationUsd":"lots","name":5,"ticker":"$OK"}"#)
        #expect(t.score == nil)
        #expect(t.valuationUsd == nil)
        #expect(t.name == nil)
        #expect(t.ticker == "$OK")
    }

    @Test("Figures outside their range are missing, never clamped")
    func outOfRange() throws {
        let t = try token(#"""
        {"address":"A","coverage":10,"valuationUsd":-1,"volume24hUsd":-3,"change24hPct":-100,"priceUsd":0,
         "liquidityUsd":-0.5,"rank":-1,"changeWindowH":0,"launchedAtMs":0,"priceSeries":[1]}
        """#)
        #expect(t.valuationUsd == nil && t.volume24hUsd == nil && t.change24hPct == nil)
        #expect(t.priceUsd == nil && t.liquidityUsd == nil && t.rank == nil)
        #expect(t.changeWindowHours == nil && t.launchedAt == nil && t.priceSeries == nil)
    }

    @Test("A real zero stays zero where the contract allows it")
    func realZero() throws {
        let t = try token(#"{"address":"A","coverage":0,"valuationUsd":0,"volume24hUsd":0,"change24hPct":0}"#)
        #expect(t.valuationUsd == 0 && t.volume24hUsd == 0 && t.change24hPct == 0)
    }

    @Test("A price line needs 2 to 500 positive numbers")
    func priceSeries() throws {
        #expect(try token(#"{"address":"A","coverage":0,"priceSeries":[1,0.5]}"#).priceSeries == [1, 0.5])
        #expect(try token(#"{"address":"A","coverage":0,"priceSeries":[1,0]}"#).priceSeries == nil)
        let long = "[" + Array(repeating: "1", count: 501).joined(separator: ",") + "]"
        #expect(try token(#"{"address":"A","coverage":0,"priceSeries":\#(long)}"#).priceSeries == nil)
    }

    @Test("A token that cannot be shown is left out, with its reason")
    func leftOut() throws {
        #expect(Token.make(from: try wire(#"{"address":"  ","coverage":5}"#), feedBase: feedBase) == .failure(.noAddress))
        #expect(Token.make(from: try wire(#"{"address":"A","coverage":101}"#), feedBase: feedBase) == .failure(.badCoverage))
        #expect(Token.make(from: try wire(#"{"address":"A","coverage":-1}"#), feedBase: feedBase) == .failure(.badCoverage))
        #expect(Token.make(from: try wire(#"{"address":"A","coverage":5,"noScoreLabel":"SCAM"}"#), feedBase: feedBase) == .failure(.unknownLabel("SCAM")))
        #expect(throws: DecodingError.self) { try wire(#"{"address":"A"}"#) }
    }

    @Test("Pictures come only from the feed server's own picture address")
    func picturesOnlyFromFeed() {
        #expect(Token.sameServer("/api/img?a=X", feedBase)?.absoluteString == "http://127.0.0.1:8787/api/img?a=X")
        #expect(Token.sameServer("http://127.0.0.1:8787/api/img?a=X", feedBase) != nil)
        #expect(Token.sameServer("https://ipfs.io/ipfs/abc", feedBase) == nil)
        #expect(Token.sameServer("http://127.0.0.1:9999/api/img?a=X", feedBase) == nil)
        #expect(Token.sameServer("/api/tokens", feedBase) == nil)
        #expect(Token.sameServer("/api/img?a=X", nil) == nil)
    }

    @Test("A copy is proven only when the chain confirmed it")
    func copyProof() throws {
        let proven = try token(#"{"address":"A","coverage":0,"noScoreLabel":"VAMP","copyOf":{"address":"O","ticker":"$O"},"copyProof":"chain"}"#)
        let unchecked = try token(#"{"address":"A","coverage":0,"noScoreLabel":"VAMP","copyOf":{"address":"O","ticker":"$O"},"copyProof":"unchecked"}"#)
        #expect(proven.copyOf?.chainProven == true)
        #expect(unchecked.copyOf?.chainProven == false)
    }

    @Test("The early mark is not used: an early token reads like any other")
    func earlyIgnored() throws {
        let t = try token(#"{"address":"A","coverage":12,"score":40,"early":true}"#)
        #expect(t.score == 40)
    }
}

@Suite("How figures read")
struct FormatTests {
    @Test("Money, compact; a dash when missing")
    func money() {
        #expect(Format.usdCompact(nil) == "—")
        #expect(Format.usdCompact(-1) == "—")
        #expect(Format.usdCompact(.nan) == "—")
        #expect(Format.usdCompact(0) == "—") // a real zero stays a dash (checklist 7)
        #expect(Format.usdCompact(0.004) == "<$0.01" && Format.usdCompact(0.4) == "$0.40")
        #expect(Format.usdCompact(950) == "$950")
        #expect(Format.usdCompact(1200) == "$1.20K")
        #expect(Format.usdCompact(376_110_000) == "$376.11M")
        #expect(Format.usdCompact(999_999) == "$1.00M")
        #expect(Format.usdCompact(2_500_000_000) == "$2.50B")
    }

    @Test("The move, with its window when under a day")
    func change() {
        #expect(Format.change(nil) == "—")
        #expect(Format.change(38.4) == "+38.4%")
        #expect(Format.change(-12) == "−12.0%")
        #expect(Format.change(0) == "+0.0%")
        #expect(Format.change(1250.4) == "+1,250%")
        #expect(Format.change(38.4, windowHours: 5) == "+38.4% · 5h")
        #expect(Format.change(38.4, windowHours: 24) == "+38.4%")
    }

    @Test("Title falls back to a shortened address; ticker to a dash")
    func titles() throws {
        let t = try token(#"{"address":"7xKXabcdefghij9fQa","coverage":0}"#)
        #expect(Format.title(t) == "7xKX…9fQa")
        #expect(Format.ticker(t) == "—")
        #expect(Format.coverage(45.4) == "45%")
    }
}
