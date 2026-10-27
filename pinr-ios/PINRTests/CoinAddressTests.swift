import Foundation
import Testing
@testable import PINR

/// Opening one coin by its address (decision D3): which strings and links name a coin.
@Suite("Coin address")
struct CoinAddressTests {
    static let sol = "AAxKPE8TEUfLH7txHppZNk5aP5V2i7PEZL6qf8Rwpump"
    static let evm = "0x4200000000000000000000000000000000000006"

    @Test("An exact Solana or EVM address; nothing else")
    func addresses() {
        #expect(CoinAddress.isAddress(Self.sol) && CoinAddress.isAddress(Self.evm))
        #expect(!CoinAddress.isAddress("") && !CoinAddress.isAddress("pepe") && !CoinAddress.isAddress("0x1234"))
        #expect(!CoinAddress.isAddress(Self.sol + " ") && !CoinAddress.isAddress("0OIl" + Self.sol)) // 0, O, I, l are not base58
    }

    @Test("The app's own link and the site's coin link name a coin; other links and other hosts do not")
    func links() {
        #expect(CoinAddress.parse(URL(string: "pinr://coin/\(Self.sol)")!) == Self.sol)
        #expect(CoinAddress.parse(URL(string: "https://pinr.io/?coin=\(Self.evm)")!) == Self.evm)
        #expect(CoinAddress.parse(URL(string: "https://pinr.io/?coin=\(Self.sol)&x=1")!) == Self.sol)
        #expect(CoinAddress.parse(URL(string: "https://evil.example/?coin=\(Self.sol)")!) == nil)
        #expect(CoinAddress.parse(URL(string: "http://pinr.io/?coin=\(Self.sol)")!) == nil)
        #expect(CoinAddress.parse(URL(string: "pinr://wallet/\(Self.sol)")!) == nil)
        #expect(CoinAddress.parse(URL(string: "https://pinr.io/?coin=nonsense")!) == nil)
        #expect(CoinAddress.parse(URL(string: "https://pinr.io/")!) == nil)
    }
}
