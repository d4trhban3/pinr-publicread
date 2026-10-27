import Testing
@testable import PINR

@Suite("Not investment advice beside a score (the site's wording)")
struct AdviceTests {
    @Test("The words and the tile width match the site")
    func wording() {
        #expect(Advice.line == "Not investment advice")
        #expect(Advice.minTileWidth == 145)
    }

    @Test("Only where the coin has a number: not on an unscored coin, not under a label")
    func onlyScored() throws {
        let base = #"{"address":"A1","chain":"solana","name":"N","ticker":"$N","coverage":40,"note":null,"#
        #expect(Advice.shows(try token(base + #""score":61,"noScoreLabel":null}"#)))
        #expect(!Advice.shows(try token(base + #""score":null,"noScoreLabel":null}"#)))
        #expect(!Advice.shows(try token(base + #""score":61,"noScoreLabel":"VAMP"}"#)))
    }
}
