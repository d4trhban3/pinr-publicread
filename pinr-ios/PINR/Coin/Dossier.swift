import Foundation

/// The DeepScan dossier for one coin, as the feed server builds it through its allow-list
/// (pinr-live/server/dossier.ts): public facts with their receipts, one word per check, approved
/// plain sentences, the coin's own links, and the social scan. Never scoring detail.
struct Dossier: Equatable, Sendable {
    /// the coin's pool events (observed on chain), or nil when the feed's answer carried none (shown as "not checked yet").
    var pool: PoolEvents?
    /// The pool facts in the coin's evidence file, for a coin with no pool-events file (Base, BNB); shown in the Pool section (checklist 6).
    var poolRows: [PoolRow] = []

    struct PoolRow: Equatable, Sendable, Identifiable {
        let what: String, value: String?, unit: String?, source: String?, onchain: Bool
        let link: URL?
        var id: String { what + (source ?? "") }
    }

    struct Fact: Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        /// The figure as text, or a dash.
        let value: String
        /// A value the reader can copy (a wallet address).
        let copy: String?
        /// The receipt: all three, or none (then the fact is a dash with "no source").
        let receipt: Receipt?
        /// The engine has not read this figure yet (the transfer fee): a dash with "not read yet", not "no source".
        var notRead = false
        /// Plain sentences under the figure: which fee case applied and why; the feed server wrote them.
        var lines: [String] = []
        /// "High fee", the only badge there is, beside the figure in the warning style.
        var highFee = false
        /// Links under the figure after a lead-in: the launches an observed standard was seen on, the dev group's wallets.
        var moreLinks: MoreLinks? = nil

        struct MoreLinks: Equatable, Sendable {
            struct Link: Equatable, Sendable, Identifiable { let label: String; let url: URL; var id: String { url.absoluteString } }
            let lead: String
            let links: [Link]
        }

        struct Receipt: Equatable, Sendable {
            let source: String
            let readAt: Date
            let link: URL
        }
    }

    /// The facts about the transfer fee.
    static let feeFactIds: Set<String> = ["transfer_fee", "fee_dev_payouts"]

    struct Check: Equatable, Sendable, Identifiable {
        let name: String
        let band: Band
        let reason: String?
        var id: String { name }
    }

    enum Band: String, Sendable {
        case strong = "Strong", fair = "Fair", weak = "Weak", clear = "Clear", noData = "No data", notRead = "Not read"
    }

    struct Channel: Equatable, Sendable, Identifiable {
        enum Status: String, Sendable { case listed, notListed = "not_listed", unknown }
        let id: String
        let label: String
        let status: Status
        let url: URL?
        /// Set when the link is someone's post, not the coin's own account.
        let postBy: String?
    }

    struct Link: Equatable, Sendable, Identifiable {
        let label: String
        let url: URL
        var id: String { url.absoluteString }
    }

    struct Social: Equatable, Sendable {
        struct Claim: Equatable, Sendable, Identifiable {
            let line: String
            let result: String
            let handle: String?
            let postURL: URL?
            let removed: Bool
            let index: Int
            var id: Int { index }
        }
        let claims: [Claim]
        let flags: [String]
        let gaps: [String]
        let totals: [String: Int]
        let scannedAt: Date?
    }

    let available: Bool
    let facts: [Fact]
    let checks: [Check]
    let read: [String]
    let links: [Link]
    let channels: [Channel]
    let social: Social?
    let flagged: Bool

    /// The public sources a receipt may name (contract v1.1, `SOURCES` in dossier.ts). Any other name is not a source.
    static let sources: Set<String> = ["Pump.fun", "Clanker", "Bankr", "Flap.sh", "four.meme", "Raydium LaunchLab", "DexScreener",
                                        "CoinGecko", "GeckoTerminal", "Solana chain", "Base chain", "BNB chain", "Jupiter", "Stonk.fun"]

    /// What each social result means, in the site's words.
    static let resultWords: [String: String] = [
        "MATCHES": "Matches the dossier", "DIVERGES": "Differs from the dossier",
        "UNVERIFIABLE": "Cannot be checked against the dossier", "NOT CHECKABLE": "An opinion or promise, not checkable",
    ]

    /// "4 claims read: 1 match, 2 differ, 1 cannot be checked, 0 not checkable." (the site's sentence)
    static func totalsSentence(_ t: [String: Int]) -> String {
        let m = t["MATCHES"] ?? 0, d = t["DIVERGES"] ?? 0, u = t["UNVERIFIABLE"] ?? 0, n = t["NOT CHECKABLE"] ?? 0
        let total = m + d + u + n
        guard total > 0 else { return "No claims were recorded." }
        return "\(total) claim\(total == 1 ? "" : "s") read: \(m) match, \(d) differ, \(u) cannot be checked, \(n) not checkable."
    }
}

/// An http or https address only; anything else is no link.
func webURL(_ s: String?) -> URL? {
    guard let s, let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http", u.host != nil else { return nil }
    return u
}

struct WireDossier: Decodable, Sendable {
    let dossier: Dossier

    private enum Key: String, CodingKey { case available, facts, checks, read, links, channels, social, held, pool, poolRows }
    private struct PR: Decodable { let what: String?; let value: Plain?; let unit: String?; let source: String?; let onchain: Bool?; let link: String? }
    private enum Plain: Decodable { case text(String), number(Double), flag(Bool)
        init(from d: Decoder) throws { let c = try d.singleValueContainer(); if let s = try? c.decode(String.self) { self = .text(s) } else if let n = try? c.decode(Double.self) { self = .number(n) } else { self = .flag(try c.decode(Bool.self)) } } }
    private struct F: Decodable {
        struct More: Decodable { struct L: Decodable { let label: String?; let url: String? }; let lead: String?; let links: [Lenient<L>]? }
        let id: String?; let label: String?; let value: String?; let copy: String?; let source: String?; let readAtMs: Double?; let link: String?; let noSource: Bool?
        let notRead: Bool?; let lines: [String]?; let badge: String?; let moreLinks: More?
    }
    private struct C: Decodable { let name: String?; let band: String?; let reason: String? }
    private struct L: Decodable { let label: String?; let url: String? }
    private struct Ch: Decodable { let id: String?; let label: String?; let status: String?; let url: String?; let post: String? }
    private struct S: Decodable {
        struct Cl: Decodable { let line: String?; let result: String?; let handle: String?; let postUrl: String?; let removed: Bool? }
        struct Fl: Decodable { let text: String? }
        let claims: [Lenient<Cl>]?; let flags: [Lenient<Fl>]?; let gaps: [String]?; let totals: [String: Int]?; let scannedAtMs: Double?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        func list<T: Decodable>(_ k: Key) -> [T] { ((try? c.decodeIfPresent([Lenient<T>].self, forKey: k)) ?? nil)?.compactMap(\.value) ?? [] }
        let available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false

        let facts: [Dossier.Fact] = (list(.facts) as [F]).enumerated().compactMap { i, f in
            guard let label = f.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty else { return nil }
            var receipt: Dossier.Fact.Receipt?
            if f.noSource != true, let s = f.source, Dossier.sources.contains(s), let ms = f.readAtMs, ms.isFinite, ms > 0, let link = webURL(f.link) {
                receipt = .init(source: s, readAt: Date(timeIntervalSince1970: ms / 1000), link: link)
            }
            // A figure without its whole receipt is a dash, never a number (contract v1.1).
            let value = receipt == nil ? Format.dash : (f.value?.isEmpty == false ? f.value! : Format.dash)
            // the design's extras: plain text only (a few short sentences), the one badge there is, https links only.
            let lines = (f.lines ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.prefix(6).map { String($0.prefix(300)) }
            let more: Dossier.Fact.MoreLinks? = f.moreLinks.flatMap { m in
                let links = (m.links ?? []).compactMap(\.value).prefix(10).compactMap { l -> Dossier.Fact.MoreLinks.Link? in
                    guard let label = l.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty, let u = webURL(l.url), u.scheme?.lowercased() == "https" else { return nil }
                    return .init(label: String(label.prefix(40)), url: u)
                }
                guard let lead = m.lead?.trimmingCharacters(in: .whitespaces), !lead.isEmpty, !links.isEmpty else { return nil }
                return .init(lead: String(lead.prefix(60)), links: links)
            }
            return .init(id: f.id ?? "fact-\(i)", label: String(label.prefix(60)), value: value, copy: receipt == nil ? nil : f.copy, receipt: receipt,
                         notRead: f.notRead == true && receipt == nil, lines: receipt == nil ? [] : Array(lines),
                         highFee: receipt != nil && f.badge == "High fee", moreLinks: receipt == nil ? nil : more)
        }
        let checks: [Dossier.Check] = (list(.checks) as [C]).compactMap { ch in
            guard let n = ch.name, !n.isEmpty, let b = ch.band.flatMap(Dossier.Band.init(rawValue:)) else { return nil }
            return .init(name: n, band: b, reason: ch.reason)
        }
        let read = ((try? c.decodeIfPresent([String].self, forKey: .read)) ?? nil)?.filter { !$0.isEmpty } ?? []
        let links: [Dossier.Link] = (list(.links) as [L]).compactMap { l in
            guard let label = l.label, let u = webURL(l.url) else { return nil }
            return .init(label: label, url: u)
        }
        let channels: [Dossier.Channel] = (list(.channels) as [Ch]).compactMap { ch in
            guard let id = ch.id, let label = ch.label, let st = ch.status.flatMap(Dossier.Channel.Status.init(rawValue:)) else { return nil }
            let url = st == .listed ? webURL(ch.url) : nil
            return .init(id: id, label: label, status: st == .listed && url == nil ? .unknown : st, url: url, postBy: ch.post)
        }
        var social: Dossier.Social?
        if let s = (try? c.decodeIfPresent(S.self, forKey: .social)) ?? nil {
            let claims = (s.claims ?? []).compactMap(\.value).enumerated().compactMap { i, cl -> Dossier.Social.Claim? in
                guard let line = cl.line, !line.isEmpty, let r = cl.result, Dossier.resultWords[r] != nil else { return nil }
                let removed = cl.removed == true
                return .init(line: line, result: r, handle: cl.handle, postURL: removed ? nil : webURL(cl.postUrl), removed: removed, index: i)
            }
            social = .init(claims: claims, flags: (s.flags ?? []).compactMap { $0.value?.text }, gaps: Array((s.gaps ?? []).prefix(5)),
                           totals: s.totals ?? [:], scannedAt: s.scannedAtMs.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil })
        }
        let held = ((try? c.decodeIfPresent(String.self, forKey: .held)) ?? nil) == "flagged"
        var built = Dossier(pool: (try? c.decodeIfPresent(PoolEvents.self, forKey: .pool)) ?? nil, available: available, facts: facts,
                          checks: held ? [] : checks, read: read, links: links, channels: channels, social: social, flagged: held)
        let prs = ((try? c.decodeIfPresent([Lenient<PR>].self, forKey: .poolRows)) ?? nil) ?? []
        built.poolRows = prs.compactMap { $0.value }.compactMap { r in
            guard let what = r.what, !what.isEmpty else { return nil }
            let v: String? = switch r.value { case .text(let s)?: s; case .number(let n)?: PoolWords.amount(n); case .flag(let b)?: b ? "yes" : "no"; case nil: nil }
            return Dossier.PoolRow(what: what, value: v, unit: r.unit, source: r.source, onchain: r.onchain == true, link: r.link.flatMap { URL(string: $0) }.flatMap { $0.scheme == "https" ? $0 : nil })
        }
        dossier = built
    }
}

/// One entry of a list that may be unreadable: kept as nil instead of failing the whole list.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}
