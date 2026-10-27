import SwiftUI

/// The outside sites for a coin's full chart and its own pages (the site's `chartLinks`, ui/coinpage.ts): only what applies to
/// the coin's chain; the Pump.fun page only for a Pump.fun coin; the chain's explorer; the launchpad's own page where it has one
/// for a coin; and TradingView last: the coin's own chart where TradingView lists it (`/api/tvsymbol`), else its
/// chart page, whose search box finds the coin (TradingView has no address search by link). The app opens them in the reader's
/// own browser; PINR sends nothing.
enum ChartLinks {
    static let tradingViewChart = "https://www.tradingview.com/chart/"

    struct Item: Identifiable, Equatable, Sendable { let label: String; let url: URL; var id: String { label } }

    /// A TradingView symbol the site accepts (`EXCHANGE:NAME`), else nil.
    static func validSymbol(_ s: String?) -> String? {
        guard let s, s.range(of: #"^[A-Z0-9_]{2,40}:[A-Z0-9_.\-]{2,60}$"#, options: .regularExpression) != nil else { return nil }
        return s
    }

    static func tradingViewURL(_ symbol: String?) -> URL {
        guard let s = validSymbol(symbol), var c = URLComponents(string: tradingViewChart) else { return URL(string: tradingViewChart)! }
        c.queryItems = [URLQueryItem(name: "symbol", value: s)]
        return c.url ?? URL(string: tradingViewChart)!
    }

    static func links(address a: String, chain: String?, launchpad: String?, tvSymbol: String? = nil) -> [Item] {
        guard !a.isEmpty else { return [] }
        let slugs = ["solana": "solana", "base": "base", "bsc": "bsc", "bnb": "bsc", "ethereum": "ethereum"]
        guard let slug = slugs[(chain ?? "").lowercased()] else { return [] }
        // Encoded as the site's `encodeURIComponent` does (a `/` or `:` in an address becomes %2F, %3A), as the Android app does.
        let e = a.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))) ?? a
        let lp = launchpad ?? ""
        func has(_ pattern: String) -> Bool { lp.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        var raw: [(String, String)] = [
            ("DexScreener", "https://dexscreener.com/\(slug)/\(e)"),
            ("GeckoTerminal", "https://www.geckoterminal.com/\(slug)/tokens/\(e)"),
        ]
        if slug == "solana", has("pump") { raw.append(("Pump.fun", "https://pump.fun/coin/\(e)")) }
        let explorers = ["solana": ("Solscan", "https://solscan.io/token/"), "base": ("Basescan", "https://basescan.org/token/"),
                         "bsc": ("BscScan", "https://bscscan.com/token/"), "ethereum": ("Etherscan", "https://etherscan.io/token/")]
        if let x = explorers[slug] { raw.append((x.0, x.1 + e)) }
        if slug == "base", has("clanker") { raw.append(("Clanker", "https://www.clanker.world/clanker/\(e)")) }
        if slug == "base", has("zora") { raw.append(("Zora", "https://zora.co/coin/base:\(e)")) }
        if slug == "base", has("virtuals") { raw.append(("Virtuals", "https://app.virtuals.io/prototypes/\(e)")) }
        if slug == "bsc", has(#"four\.?meme"#) { raw.append(("Four.meme", "https://four.meme/token/\(e)")) }
        if slug == "bsc", has("flap") { raw.append(("Flap", "https://flap.sh/bnb/\(e)")) }
        var out = raw.compactMap { l, u in URL(string: u).map { Item(label: l, url: $0) } }
        out.append(Item(label: "TradingView", url: tradingViewURL(tvSymbol)))
        return out
    }
}

/// Lays its children out left to right and wraps them onto new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? .infinity, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let a = arrange(bounds.width, subviews)
        for (i, p) in a.points.enumerated() { subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified) }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var points: [CGPoint] = [], x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing; row = max(row, size.height); maxX = max(maxX, x - spacing)
        }
        return (points, CGSize(width: maxX, height: y + row))
    }
}

/// "Full chart and pages elsewhere": the links as small capsules, under the chart.
struct ChartLinksRow: View {
    let items: [ChartLinks.Item]

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("FULL CHARTS AND PAGES ELSEWHERE").font(Typo.mono(10.5, .bold)).tracking(1.2).foregroundStyle(Brand.mute)
                FlowLayout(spacing: 8) {
                    ForEach(items) { i in
                        Link(destination: i.url) {
                            Text(verbatim: i.label).font(Typo.mono(11.5, .medium)).foregroundStyle(Brand.paper.opacity(0.9))
                                .padding(.horizontal, 12).frame(height: 30)
                                .background(Capsule().fill(Brand.fg.opacity(0.07)))
                                .overlay(Capsule().strokeBorder(Brand.fg.opacity(0.12), lineWidth: 1))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 14)
        }
    }
}
