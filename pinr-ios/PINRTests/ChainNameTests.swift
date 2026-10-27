import XCTest
@testable import PINR

final class ChainNameTests: XCTestCase {
    func testNamesEachChainTheFeedSends() {
        XCTAssertEqual(["base", "bsc", "solana", "ethereum"].map(ChainName.of), ["Base", "BNB Chain", "Solana", "Ethereum"])
    }
    func testAnUnknownIdStaysAsItCame() {
        XCTAssertEqual(ChainName.of("tron"), "tron")
    }
}
