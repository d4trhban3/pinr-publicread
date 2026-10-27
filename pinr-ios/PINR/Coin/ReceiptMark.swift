import Foundation

/// ● read on chain, ○ reported. An on-chain fact with no receipt link keeps its ● and says so beside it; the site's
/// `pinr-live/src/ui/orbit.ts` does the same.
enum ReceiptMark {
    static func mark(onchain: Bool) -> String { onchain ? "●" : "○" }
    static func word(onchain: Bool) -> String { onchain ? "read on chain" : "reported" }
    /// The words beside an on-chain row that has no link yet; nil otherwise.
    static func note(onchain: Bool, hasLink: Bool) -> String? { onchain && !hasLink ? "no receipt link yet" : nil }
}

/// What a coin with no trade read says (the site's NO_TRADES_READ in pinr-live/src/ui/tradeslist.ts), the same on every chain.
enum TradesWords {
    static let noTradesRead = "No trades read yet."
}

/// The site's pinr-live/src/world/figures.ts: a figure is shown only with its source named; a curve coin has no pool yet.
enum FigureRule {
    static func shown(_ value: String, hasSource: Bool, sourced: Bool) -> (value: String, notRead: Bool) {
        guard sourced else { return (value, false) }
        if value == Format.dash { return (value, true) }
        return hasSource ? (value, false) : (Format.dash, true)
    }
    static let onCurve = "On its bonding curve; no pool yet."
    static func noPoolWords(_ launchpad: String?) -> String {
        let lp = (launchpad ?? "").lowercased()
        return lp.contains("curve") || (lp.contains("launchlab") && !lp.contains("graduat")) ? onCurve : "Not checked yet."
    }
}
