import Foundation
import Testing
@testable import PINR

@Suite("● on chain, ○ reported")
struct ReceiptMarkTests {
    @Test("An on-chain row with no link keeps its ● and says so; a reported row is ○ and says nothing")
    func marks() {
        #expect(ReceiptMark.mark(onchain: true) == "●")
        #expect(ReceiptMark.note(onchain: true, hasLink: false) == "no receipt link yet")
        #expect(ReceiptMark.note(onchain: true, hasLink: true) == nil)
        #expect(ReceiptMark.mark(onchain: false) == "○")
        #expect(ReceiptMark.note(onchain: false, hasLink: false) == nil)
        #expect(ReceiptMark.word(onchain: true) == "read on chain")
    }
}

@Suite("A coin with no trade read")
struct NoTradesWordsTests {
    @Test("says \"No trades read yet.\" on every chain, never \"give it a few seconds\"")
    func words() {
        #expect(TradesWords.noTradesRead == "No trades read yet.")
        #expect(!TradesWords.noTradesRead.contains("few seconds"))
    }
}

@Suite("A figure is shown only with its source; a curve coin has no pool yet")
struct FigureRuleTests {
    @Test("a value with no source is a dash that says not read yet; a sourced one stays; a plain fact passes")
    func figures() {
        #expect(FigureRule.shown("$486", hasSource: false, sourced: true) == (Format.dash, true))
        #expect(FigureRule.shown("$486", hasSource: true, sourced: true) == ("$486", false))
        #expect(FigureRule.shown(Format.dash, hasSource: false, sourced: true) == (Format.dash, true))
        #expect(FigureRule.shown("1m", hasSource: false, sourced: false) == ("1m", false))
    }
    @Test("a curve coin says it is on its curve; a graduated or unknown one says not checked yet")
    func pool() {
        #expect(FigureRule.noPoolWords("Pump.fun curve") == "On its bonding curve; no pool yet.")
        #expect(FigureRule.noPoolWords("PumpSwap (graduated)") == "Not checked yet.")
        #expect(FigureRule.noPoolWords(nil) == "Not checked yet.")
    }
}

@Suite("A coin whose funding the engine did not trace says why")
struct FundingNoteTests {
    @Test("an empty Funders group reads the note; with no note it is as before")
    func note() throws {
        let note = "Funding not traced: the launcher is a mass launcher and the fee wallet is brand new."
        let with = try JSONDecoder().decode(WireEvidence.self, from: Data(#"{"evidence":{"rows":[],"fundingNote":"\#(note)"}}"#.utf8))
        let without = try JSONDecoder().decode(WireEvidence.self, from: Data(#"{"evidence":{"rows":[]}}"#.utf8))
        let f = { (h: EvidenceHub?) in EvidenceWords.orbitGroups(h, now: Date()).first { $0.id == .funders }!.empty }
        #expect(f(with.hub) == note)
        #expect(f(without.hub) == "Where the creator's money came from: not checked yet.")
    }
}
