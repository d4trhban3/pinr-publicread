import Foundation
import Testing
@testable import PINR

private func fee(_ json: String) throws -> TransferFee? {
    try JSONDecoder().decode(WireTransferFee.self, from: Data(json.utf8)).fee
}

@Suite("the transfer fee")
struct FeeTests {
    @Test("The tile's words, as the site's feeShort")
    func tileWords() throws {
        #expect(try fee(#"{"pct":1,"kind":"rewards_standard","program":"Stonk.fun reward mode","standardPct":1,"standardBasis":"settings"}"#)?.short == "1% rewards")
        #expect(try fee(#"{"pct":5,"kind":"standard_unknown","program":"Stonk.fun reward mode"}"#)?.short == "5% rewards")
        #expect(try fee(#"{"pct":8,"kind":"outside_norm","program":"Stonk.fun reward mode","standardPct":1,"standardBasis":"settings"}"#)?.short == "8% above rate")
        #expect(try fee(#"{"pct":5,"kind":"outside_norm"}"#)?.short == "5% not rewards")
        #expect(try fee(#"{"pct":12.5,"kind":"outside_norm"}"#)?.short == "12.5% not rewards")
        #expect(try fee(#"{"pct":0,"kind":"none"}"#)?.short == nil)
    }

    @Test("DeepScan's sentence, the same words as the server's")
    func longWords() throws {
        #expect(try fee(#"{"pct":1,"kind":"rewards_standard","program":"Stonk.fun reward mode","standardPct":1,"standardBasis":"settings"}"#)?.long == "1% · Stonk.fun reward mode, at its standard rate")
        #expect(try fee(#"{"pct":0.5,"kind":"rewards_standard","program":"Stonk.fun reward mode","standardPct":1,"standardBasis":"observed","standardLinks":["https://solscan.io/token/a"]}"#)?.long == "0.5% · Stonk.fun reward mode, below its observed standard 1%")
        #expect(try fee(#"{"pct":8,"kind":"outside_norm","program":"Stonk.fun reward mode","standardPct":1,"standardBasis":"settings"}"#)?.long == "8% · above Stonk.fun reward mode's standard 1%")
        #expect(try fee(#"{"pct":5,"kind":"outside_norm"}"#)?.long == "5% · not a launchpad rewards fee")
        #expect(try fee(#"{"pct":5,"kind":"standard_unknown","program":"Stonk.fun reward mode"}"#)?.long == "5% · Stonk.fun reward mode; its standard rate was not read")
    }

    @Test("A fee that breaks the contract is no fee: never a guess")
    func brokenIsNothing() throws {
        let bad = [
            #"{"pct":1,"kind":"rewards_standard","program":"P","standardPct":0.5,"standardBasis":"settings"}"#,   // above its standard
            #"{"pct":1,"kind":"rewards_standard","standardPct":1,"standardBasis":"settings"}"#,                      // no program
            #"{"pct":1,"kind":"rewards_standard","program":"P"}"#,                                                  // no standard
            #"{"pct":1,"kind":"standard_unknown","program":"P","standardPct":1,"standardBasis":"settings"}"#,       // a standard it says it lacks
            #"{"pct":8,"kind":"outside_norm","program":"P","standardPct":9,"standardBasis":"settings"}"#,            // not above the standard
            #"{"pct":3,"kind":"none"}"#, #"{"pct":0,"kind":"outside_norm"}"#, #"{"pct":101,"kind":"outside_norm"}"#,
            #"{"pct":-1,"kind":"outside_norm"}"#, #"{"pct":2,"kind":"later"}"#, #"{"pct":2}"#, #"{"kind":"outside_norm"}"#,
            #"{"pct":1,"kind":"rewards_standard","program":"P","standardPct":1,"standardBasis":"observed"}"#,        // observed without receipts
            #"{"pct":1,"kind":"rewards_standard","program":"P","standardPct":1,"standardBasis":"observed","standardLinks":["http://x.io/a"]}"#,
            #"{"pct":1,"kind":"rewards_standard","program":"P","standardPct":1,"standardBasis":"settings","standardLinks":["https://x.io/a"]}"#,
            #"{"pct":2,"kind":"outside_norm","program":"<b>bad</b>","standardPct":1,"standardBasis":"settings"}"#,
        ]
        for json in bad { #expect(try fee(json) == nil, "\(json)") }
    }

    @Test("The fee comes on the token from the feed, and a broken one leaves it without")
    func onTheToken() throws {
        let ok = try token(#"{"address":"A","coverage":10,"transferFee":{"pct":5,"kind":"outside_norm"}}"#)
        #expect(ok.transferFee?.short == "5% not rewards")
        #expect(try token(#"{"address":"A","coverage":10,"transferFee":{"pct":5,"kind":"later"}}"#).transferFee == nil)
        #expect(try token(#"{"address":"A","coverage":10,"transferFee":"5%"}"#).transferFee == nil)
        #expect(try token(#"{"address":"A","coverage":10}"#).transferFee == nil)
    }

    @Test("A fee outside the norm takes the top row; a rewards fee comes last, so a short tile drops it first")
    func tileRows() throws {
        let outside = try #require(try fee(#"{"pct":5,"kind":"outside_norm"}"#))
        let rewards = try #require(try fee(#"{"pct":1,"kind":"standard_unknown","program":"P"}"#))
        let none = try #require(try fee(#"{"pct":0,"kind":"none"}"#))
        #expect(TileFacts.rows(mc: "$1M", ath: "$2M", fee: outside).map(\.label) == ["Fee", "MC", "ATH"])
        #expect(TileFacts.rows(mc: "$1M", ath: "$2M", fee: rewards).map(\.label) == ["MC", "ATH", "Fee"])
        #expect(TileFacts.rows(mc: "$1M", ath: "$2M", fee: none).map(\.label) == ["MC", "ATH"])
        #expect(TileFacts.rows(mc: "$1M", ath: "$2M", fee: nil).map(\.label) == ["MC", "ATH"])
    }
}

@Suite("DeepScan's fee lines")
struct FeeDossierTests {
    private func facts(_ rows: String) throws -> [Dossier.Fact] {
        try JSONDecoder().decode(WireDossier.self, from: Data(#"{"available":true,"facts":\#(rows)}"#.utf8)).dossier.facts
    }
    private let receipt = #""source":"Solana chain","readAtMs":1791650000000,"link":"https://solscan.io/token/A""#

    @Test("Lines, the High fee badge and the links come with a whole receipt")
    func extras() throws {
        let f = try facts(#"""
        [{"id":"transfer_fee","label":"Transfer fee","value":"5% · not a launchpad rewards fee",\#(receipt),
          "lines":["No reason found on chain:","Fees were paid to the dev group (2 wallets, 9 transfers)."],"badge":"High fee",
          "moreLinks":{"lead":"Standard observed on","links":[{"label":"launch 1","url":"https://solscan.io/token/B"},{"label":"bad","url":"javascript:alert(1)"},{"label":"plain","url":"http://x.io/c"}]}}]
        """#)[0]
        #expect(f.lines == ["No reason found on chain:", "Fees were paid to the dev group (2 wallets, 9 transfers)."])
        #expect(f.highFee)
        #expect(f.moreLinks?.lead == "Standard observed on")
        #expect(f.moreLinks?.links.map(\.label) == ["launch 1"])   // https only
    }

    @Test("Only the one badge there is; a fee without its receipt is a dash with no lines")
    func guarded() throws {
        let odd = try facts(#"[{"id":"transfer_fee","label":"Transfer fee","value":"1%",\#(receipt),"badge":"Scam"}]"#)[0]
        #expect(!odd.highFee)
        let none = try facts(#"[{"id":"transfer_fee","label":"Transfer fee","value":"5%","noSource":true,"lines":["No reason found on chain:"],"badge":"High fee"}]"#)[0]
        #expect(none.value == Format.dash && none.lines.isEmpty && !none.highFee && none.receipt == nil && !none.notRead)
    }

    @Test("Not read yet says so; it is not 'no source'")
    func notRead() throws {
        let f = try facts(#"[{"id":"transfer_fee","label":"Transfer fee","value":"—","notRead":true}]"#)[0]
        #expect(f.notRead && f.value == Format.dash && f.receipt == nil)
    }
}
