import Foundation

/// How figures read on screen. Missing is always a dash, never a zero.
enum Format {
    static let dash = "—"

    /// "$376.11M", "$1.20K", "$950"; a dash when missing.
    /// A count of trades, short: 87, 1,240, 12.4K, 1.2M (the site's `countShort`).
    static func countShort(_ n: Int) -> String {
        let v = Double(n)
        if v < 10_000 { return n.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) } // en-US as the site, whatever the phone's language
        if v < 1_000_000 { return String(format: v < 100_000 ? "%.1fK" : "%.0fK", locale: Locale(identifier: "en_US"), v / 1000) }
        return String(format: "%.1fM", locale: Locale(identifier: "en_US"), v / 1_000_000)
    }

    /// the hour's trades beside the market cap on a tile: "20 tx/1h", or "— tx" when no source counts them (missing stays missing).
    static func tilePlusTrades(_ mc: String, _ flow: Token.Flow?, hour: Int? = nil) -> String {
        // The engine's own hourly count first, then the feed's.
        let n = hour ?? flow?.trades1h
        return "\(mc) · \(n.map { "\(countShort($0)) tx/1h" } ?? "— tx")"
    }

    static func usdCompact(_ v: Double?) -> String {
        guard let v, v.isFinite, v > 0 else { return dash } // a real zero or missing stays a dash (the site's money())
        if v < 0.01 { return "<$0.01" }                     // under a cent, never "$0.00" (checklist 7)
        let units: [(Double, String)] = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")]
        for (size, suffix) in units where v >= size * 0.999995 { // so $999,999 reads $1.00M, not $1000.00K
            return "$" + fixed(v / size, 2) + suffix
        }
        return "$" + fixed(v, v < 10 ? 2 : 0)
    }

    /// "+38.4%", "−12.0%", "+1,250%" (the site's signedPct); a dash when missing.
    /// With a window under a day it says so: "+38.4% · 5h".
    static func change(_ pct: Double?, windowHours: Double? = nil) -> String {
        guard let pct, pct.isFinite else { return dash }
        let a = abs(pct)
        let body = a >= 1000 ? Int(a.rounded()).formatted(.number.locale(Locale(identifier: "en_US"))) : fixed(a, 1)
        var s = (pct < 0 ? "−" : "+") + body + "%"
        if let h = windowHours, h.isFinite, h > 0, h < 23 { s += " · \(max(1, Int(h.rounded())))h" }
        return s
    }

    /// "as of 2:32 PM" (the site's formatAsOf): when a figure that is not current was last read.
    static func asOf(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "h:mm a"
        return "as of " + f.string(from: d)
    }

    /// Coverage as a whole percent: "45%".
    static func coverage(_ v: Double) -> String { "\(Int(v.rounded()))%" }

    /// What the score place shows: the label for a flagged token, the number, or a dash.
    static func score(_ t: Token) -> String {
        if let label = t.label { return label.rawValue }
        if let s = t.score { return String(s) }
        return dash
    }

    /// The name, or a shortened address when there is none ("7xKX…9fQa").
    static func title(_ t: Token) -> String {
        if NameFilter.masks(t) { return NameFilter.maskedTitle }
        if let n = t.name { return n }
        let a = t.address
        guard a.count > 10 else { return a }
        return String(a.prefix(4)) + "…" + String(a.suffix(4))
    }

    static func ticker(_ t: Token) -> String { NameFilter.masks(t) ? NameFilter.maskedTicker : (t.ticker ?? dash) }

    private static func fixed(_ v: Double, _ digits: Int) -> String {
        String(format: "%.\(digits)f", locale: Locale(identifier: "en_US_POSIX"), v)
    }
}
