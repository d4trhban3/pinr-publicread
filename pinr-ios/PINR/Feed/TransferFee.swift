import Foundation

/// A coin's transfer fee.
/// Shown on every coin's DeepScan and, when the coin has a fee, on its tile. Plain words: what the fee is and whose
/// program it belongs to, never a verdict; the engine scores it, the app only shows it.
struct TransferFee: Equatable, Sendable {
    enum Kind: String, Sendable { case none, rewardsStandard = "rewards_standard", standardUnknown = "standard_unknown", outsideNorm = "outside_norm" }
    enum Basis: String, Sendable { case settings, observed }

    /// The fee in force now, in percent of each transfer (0 when the coin has none).
    let pct: Double
    let kind: Kind
    /// The rewards program's public name, when the fee belongs to one.
    let program: String?
    let standardPct: Double?
    let standardBasis: Basis?

    private static func pctText(_ p: Double) -> String { "\(Double(String(format: "%.2f", p))!.formatted(.number.locale(Locale(identifier: "en_US"))))%" }
    private var std: String { standardBasis == .observed ? "observed standard" : "standard" }

    /// The tile's short value (the row's label is "Fee"); nil when the coin has no fee (the tile shows no row).
    var short: String? {
        switch kind {
        case .none: nil
        case .rewardsStandard, .standardUnknown: "\(Self.pctText(pct)) rewards"
        case .outsideNorm: program != nil ? "\(Self.pctText(pct)) above rate" : "\(Self.pctText(pct)) not rewards"
        }
    }

    /// DeepScan's own line comes from the feed server (its `value`); this is the same sentence for the tests.
    var long: String {
        switch kind {
        case .none: return "None"
        case .rewardsStandard:
            return pct == standardPct ? "\(Self.pctText(pct)) · \(program ?? ""), at its \(std) rate"
                : "\(Self.pctText(pct)) · \(program ?? ""), below its \(std) \(Self.pctText(standardPct ?? 0))"
        case .standardUnknown: return "\(Self.pctText(pct)) · \(program ?? ""); its standard rate was not read"
        case .outsideNorm:
            if let program { return "\(Self.pctText(pct)) · above \(program)'s \(std) \(Self.pctText(standardPct ?? 0))" }
            return "\(Self.pctText(pct)) · not a launchpad rewards fee"
        }
    }

    /// The tile's fee row goes first when the fee is outside the rewards norm (so a short tile drops ATH, then MC, first);
    /// a rewards fee comes last, after ATH, so it is the first row a short tile drops.
    var feeFirst: Bool { kind == .outsideNorm }
}

/// What the feed sends for a coin's fee (`transferFee` in /api/tokens). Read leniently: a record that breaks the
/// contract's rules is no fee at all (the tile shows nothing), never a guess.
struct WireTransferFee: Decodable, Equatable, Sendable {
    let pct: Double?
    let kind: String?
    let program: String?
    let standardPct: Double?
    let standardBasis: String?
    let standardLinks: [String]?

    private enum Key: String, CodingKey { case pct, kind, program, standardPct, standardBasis, standardLinks }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        func opt<T: Decodable>(_ k: Key) -> T? { (try? c.decodeIfPresent(T.self, forKey: k)) ?? nil }
        pct = opt(.pct); kind = opt(.kind); program = opt(.program)
        standardPct = opt(.standardPct); standardBasis = opt(.standardBasis); standardLinks = opt(.standardLinks)
    }

    /// The contract's checks (B1, U1, R1), the same as the server's `feeFromFact`.
    var fee: TransferFee? {
        func isPct(_ v: Double?) -> Bool { v.map { $0.isFinite && $0 >= 0 && $0 <= 100 } ?? false }
        guard isPct(pct), let pct, let kind = kind.flatMap(TransferFee.Kind.init(rawValue:)) else { return nil }
        let name = program?.trimmingCharacters(in: .whitespaces)
        if program != nil {
            guard let name, (1...40).contains(name.count),
                  name.allSatisfy({ $0.isLetter || $0.isNumber || " _.-()".contains($0) }) else { return nil }
        }
        if standardPct != nil, !isPct(standardPct) { return nil }
        let basis = standardBasis.flatMap(TransferFee.Basis.init(rawValue:))
        if standardBasis != nil, basis == nil { return nil }
        // The standard's rate and its basis come together, and a standard belongs to a program.
        if (standardPct == nil) != (basis == nil) { return nil }
        if standardPct != nil, name == nil { return nil }
        if basis == .observed {
            guard let l = standardLinks, (1...10).contains(l.count), l.allSatisfy({ URL(string: $0)?.scheme?.lowercased() == "https" }) else { return nil }
        } else if standardLinks != nil { return nil }
        func make() -> TransferFee { .init(pct: pct, kind: kind, program: name, standardPct: standardPct, standardBasis: basis) }
        switch kind {
        case .none: return pct == 0 && name == nil ? make() : nil
        case .rewardsStandard:
            guard pct > 0, name != nil, let s = standardPct, pct <= s else { return nil }
            return make()
        case .standardUnknown: return pct > 0 && name != nil && standardPct == nil ? make() : nil
        case .outsideNorm:
            guard pct > 0 else { return nil }
            return name == nil || (standardPct.map { pct > $0 } ?? false) ? make() : nil
        }
    }
}

/// The rows a tile (or card) carries under its name: MC and ATH, with the fee row first or last (see `feeFirst`),
/// longest first. A short tile takes the first rows that fit, so a rewards fee is dropped first.
enum TileFacts {
    static func rows(mc: String, ath: String, fee: TransferFee?) -> [(label: String, value: String)] {
        var rows = [("MC", mc), ("ATH", ath)]
        if let fee, let s = fee.short { rows.insert(("Fee", s), at: fee.feeFirst ? 0 : 2) }
        return rows
    }
}
