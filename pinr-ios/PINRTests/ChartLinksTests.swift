import Foundation
import Testing
@testable import PINR

/// The coin page's outside links (the site's `chartLinks`, ui/coinpage.ts).
@Suite("Chart links")
struct ChartLinksTests {
    private func labels(_ chain: String?, _ lp: String?, _ tv: String? = nil) -> [String] {
        ChartLinks.links(address: "Addr1", chain: chain, launchpad: lp, tvSymbol: tv).map(\.label)
    }

    @Test("A Pump.fun coin: the two chart sites, its own page, the explorer, TradingView last")
    func solanaPump() {
        #expect(labels("solana", "Pump.fun curve") == ["DexScreener", "GeckoTerminal", "Pump.fun", "Solscan", "TradingView"])
        #expect(labels("solana", "PumpSwap (graduated)").contains("Pump.fun"))
        #expect(!labels("solana", "Raydium LaunchLab").contains("Pump.fun"))
    }

    @Test("Base and BNB Chain: their explorer and the launchpad's own page where it has one")
    func evm() {
        #expect(labels("base", "Clanker") == ["DexScreener", "GeckoTerminal", "Basescan", "Clanker", "TradingView"])
        #expect(labels("base", "Zora").contains("Zora") && labels("base", "Virtuals").contains("Virtuals"))
        #expect(labels("bsc", "Four.meme") == ["DexScreener", "GeckoTerminal", "BscScan", "Four.meme", "TradingView"])
        #expect(labels("bnb", "Flap").contains("Flap"))
        #expect(!labels("bsc", "Flap").contains("Clanker"))
    }

    @Test("An unknown chain or no address has no links; the address is path-encoded")
    func edges() {
        #expect(labels("tron", nil).isEmpty && labels(nil, nil).isEmpty)
        #expect(ChartLinks.links(address: "", chain: "solana", launchpad: nil).isEmpty)
        let l = ChartLinks.links(address: "a/b c", chain: "base", launchpad: nil)
        #expect(l[0].url.absoluteString == "https://dexscreener.com/base/a%2Fb%20c")
    }

    @Test("TradingView: the coin's own chart only for a valid symbol, else its chart page")
    func tradingView() {
        #expect(ChartLinks.tradingViewURL("RAYDIUM:BONKSOL").absoluteString == "https://www.tradingview.com/chart/?symbol=RAYDIUM:BONKSOL")
        #expect(ChartLinks.tradingViewURL("bad symbol").absoluteString == "https://www.tradingview.com/chart/")
        #expect(ChartLinks.tradingViewURL(nil).absoluteString == "https://www.tradingview.com/chart/")
        #expect(ChartLinks.validSymbol("javascript:alert(1)") == nil)
        #expect(ChartLinks.links(address: "x", chain: "solana", launchpad: nil, tvSymbol: "A_B:C-D").last?.url.query == "symbol=A_B:C-D")
    }
}
