import Foundation

/// The coin's evidence file as the feed serves it (`/api/evidence?address=`, contract "evidence/1", already cleaned by the
/// server): the rows, the gate's result at launch and PINRai's reading. The wording follows the
/// site's `world/orbit.ts` (`describe`, `gateView`, `pinraiView`): a doctor's words (231), what was observed, never a verdict;
/// missing stays missing. Links are https only.
struct EvidenceHub: Sendable, Equatable {
    var rows: [Row] = []
    var gate: Gate?
    var pinrai: Pinrai?
    /// Why no funding is traced, in observed words, when the engine did not trace it; the server adds it to the answer.
    var fundingNote: String?

    /// A plain value or a small record of plain values (a holding's amount and marks, a pair's figures).
    indirect enum Plain: Sendable, Equatable, Decodable {
        case text(String), number(Double), flag(Bool), record([String: Plain])
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .flag(b) }
            else if let n = try? c.decode(Double.self) { self = .number(n) }
            else if let s = try? c.decode(String.self) { self = .text(s) }
            else { self = .record(try c.decode([String: Plain].self)) }
        }
        var number: Double? { if case .number(let n) = self, n.isFinite { n } else { nil } }
        var string: String? { if case .text(let s) = self { s } else { nil } }
        var record: [String: Plain] { if case .record(let r) = self { r } else { [:] } }
        /// The value in plain words for a receipt ("12.5", "yes").
        var words: String {
            switch self {
            case .text(let s): s
            case .number(let n): n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
            case .flag(let b): b ? "yes" : "no"
            case .record: ""
            }
        }
    }

    struct Ref: Sendable, Equatable { let kind: String; let id: String }
    struct Row: Sendable, Equatable {
        let from: Ref, to: Ref
        let what: String
        let value: Plain?
        let unit: String?
        let atMs: Double?, readMs: Double?
        let source: String?, link: URL?
        let onchain: Bool
    }
    struct GateCoin: Sendable, Equatable { let coin: String; let launchedAtMs: Double?; let link: URL? }
    enum GateItem: Sendable, Equatable {
        case earlierLookalike(words: String, coin: String?, launchedAtMs: Double?, link: URL?, creator: String?, creatorLink: URL?)
        case sameCreatorRelaunch(words: String, coins: [GateCoin])
        case plain(words: String)
    }
    struct Gate: Sendable, Equatable {
        let status: String           // "passed" | "held" | "not read yet"
        let words: [String]
        let items: [GateItem]
        let creatorLink: URL?
        let otherCoins: [GateCoin]
        let launchedAtMs: Double?
        let source: String?
        let readMs: Double?
    }
    struct Receipt: Sendable, Equatable { let source: String?; let value: Plain?; let link: URL?; let asOfMs: Double?; let onchain: Bool }
    struct PinraiItem: Sendable, Equatable { let words: String; let reviewed: Bool; let receipts: [Receipt] }
    struct Pinrai: Sendable, Equatable {
        let status: String           // "read" | "off" | "not read yet"
        let readMs: Double?
        let model: String?
        let items: [PinraiItem]
        let dropped: Int?, pending: Int?
    }
}

// MARK: - Reading the feed's answer

struct WireEvidence: Decodable, Sendable {
    let hub: EvidenceHub?

    private enum Key: String, CodingKey { case evidence }
    private struct R: Decodable {
        struct Ref: Decodable { let kind: String?; let id: String? }
        let from: Ref?, to: Ref?; let what: String?; let value: EvidenceHub.Plain?; let unit: String?
        let atMs: Double?, readMs: Double?; let source: String?, link: String?; let onchain: Bool?
    }
    private struct C: Decodable { let coin: String?; let launchedAtMs: Double?; let link: String? }
    private struct GI: Decodable {
        let kind: String?; let words: String?; let coin: String?; let launchedAtMs: Double?; let link: String?
        let creator: String?; let creatorLink: String?; let coins: [Lenient<C>]?
    }
    private struct GC: Decodable { let link: String?; let otherCoins: [Lenient<C>]? }
    private struct G: Decodable {
        let status: String?; let words: [String]?; let items: [Lenient<GI>]?; let creator: GC?
        let launchedAtMs: Double?; let source: String?; let readMs: Double?
    }
    private struct PR: Decodable { let source: String?; let value: EvidenceHub.Plain?; let link: String?; let asOfMs: Double?; let onchain: Bool? }
    private struct PI: Decodable { let words: String?; let reviewed: Bool?; let receipts: [Lenient<PR>]? }
    private struct P: Decodable {
        let status: String?; let readMs: Double?; let model: String?; let items: [Lenient<PI>]?; let dropped: Int?; let pending: Int?
    }
    private struct E: Decodable { let rows: [Lenient<R>]?; let gate: G?; let pinrai: P?; let fundingNote: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        guard let e = (try? c.decodeIfPresent(E.self, forKey: .evidence)) ?? nil else { hub = nil; return }
        func coin(_ x: C) -> EvidenceHub.GateCoin? { x.coin.map { .init(coin: $0, launchedAtMs: x.launchedAtMs, link: httpsURL(x.link)) } }
        var hub = EvidenceHub()
        hub.fundingNote = e.fundingNote
        hub.rows = (e.rows ?? []).compactMap(\.value).compactMap { r in
            guard let what = r.what, let f = r.from, let t = r.to else { return nil }
            return .init(from: .init(kind: f.kind ?? "", id: f.id ?? ""), to: .init(kind: t.kind ?? "", id: t.id ?? ""), what: what,
                         value: r.value, unit: r.unit, atMs: r.atMs, readMs: r.readMs, source: r.source, link: httpsURL(r.link), onchain: r.onchain == true)
        }
        if let g = e.gate, let status = g.status {
            let items: [EvidenceHub.GateItem] = (g.items ?? []).compactMap(\.value).compactMap { it in
                guard let words = it.words else { return nil }
                switch it.kind {
                case "earlier_lookalike":
                    return .earlierLookalike(words: words, coin: it.coin, launchedAtMs: it.launchedAtMs, link: httpsURL(it.link), creator: it.creator, creatorLink: httpsURL(it.creatorLink))
                case "same_creator_relaunch":
                    return .sameCreatorRelaunch(words: words, coins: (it.coins ?? []).compactMap(\.value).compactMap(coin))
                default: return .plain(words: words)
                }
            }
            hub.gate = .init(status: status, words: g.words ?? [], items: items, creatorLink: httpsURL(g.creator?.link),
                             otherCoins: (g.creator?.otherCoins ?? []).compactMap(\.value).compactMap(coin),
                             launchedAtMs: g.launchedAtMs, source: g.source, readMs: g.readMs)
        }
        if let p = e.pinrai, let status = p.status {
            let items: [EvidenceHub.PinraiItem] = (p.items ?? []).compactMap(\.value).compactMap { it in
                guard let words = it.words else { return nil }
                let receipts = (it.receipts ?? []).compactMap(\.value).map {
                    EvidenceHub.Receipt(source: $0.source, value: $0.value, link: httpsURL($0.link), asOfMs: $0.asOfMs, onchain: $0.onchain == true)
                }
                return .init(words: words, reviewed: it.reviewed == true, receipts: receipts)
            }
            hub.pinrai = .init(status: status, readMs: p.readMs, model: p.model, items: items, dropped: p.dropped, pending: p.pending)
        }
        self.hub = hub
    }
}

/// An https link only (the server already cleans; the app checks again).
func httpsURL(_ s: String?) -> URL? {
    guard let s, let u = URL(string: s), u.scheme?.lowercased() == "https", u.host != nil, u.user == nil, u.password == nil else { return nil }
    return u
}

// MARK: - The words (the site's orbit.ts)

enum EvidenceWords {
    /// The gate's own copy lines keep 4…4 (orbit.ts: `short`); evidence rows use the site's `shortAddress` (6…4 above 14 characters).
    static func gateShort(_ a: String) -> String { a.count > 8 ? "\(a.prefix(4))…\(a.suffix(4))" : a }
    static func short(_ a: String) -> String { a.count > 14 ? "\(a.prefix(6))…\(a.suffix(4))" : a }
    static func ago(_ ms: Double?, now: Date) -> String? {
        guard let ms, ms.isFinite, ms > 0 else { return nil }
        return DiscoverCard.scoredAgo(Date(timeIntervalSince1970: ms / 1000), now: now)
    }
    static func money(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "$%.1fB", n / 1e9) }
        if n >= 1e6 { return String(format: "$%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: "$%.1fK", n / 1e3) }
        return "$\(Int(n.rounded()))"
    }
    static func amount(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.2fB", n / 1e9) }
        if n >= 1e6 { return String(format: "%.2fM", n / 1e6) }
        if n >= 1e3 { return String(format: "%.1fK", n / 1e3) }
        if n > 0, n < 1 { return PoolWords.amount(n) } // three significant digits, written out (site's amount())
        let r = (n * 100).rounded() / 100
        return r == r.rounded() ? String(Int(r)) : String(r)
    }

    /// A number the way the site prints it: no trailing ".0" (JavaScript's String(n)).
    static func plain(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e15 { return String(Int(n)) }
        var t = String(format: "%.8f", n)
        while t.hasSuffix("0") { t.removeLast() }
        return t
    }
    /// A share (0 to 1) as a percent, never rounded up to 100%; nil when not a share (orbit.ts `share`).
    static func share(_ s: Double?) -> String? {
        guard let s, s >= 0, s <= 1 else { return nil }
        let p = s * 100
        return plain(p >= 1 ? (p * 100).rounded(.down) / 100 : Double(String(format: "%.2g", p)) ?? p) + "%"
    }
    static func duration(_ sec: Double) -> String {
        sec < 120 ? "\(Int(sec.rounded())) s" : sec < 7200 ? "\(Int((sec / 60).rounded())) min" : "\(Int((sec / 3600).rounded())) h"
    }
    static func grouped(_ n: Double) -> String {
        let f = NumberFormatter(); f.locale = Locale(identifier: "en_US"); f.numberStyle = .decimal; f.maximumFractionDigits = 3
        return f.string(from: NSNumber(value: n)) ?? plain(n)
    }

    enum GroupID: String, CaseIterable, Sendable { case creator, funders, holders, pool, socials, links }
    static let groups: [(id: GroupID, label: String, empty: String)] = [
        (.creator, "Creator", "Who created and launched this coin: not checked yet."),
        (.funders, "Funders", "Where the creator's money came from: not checked yet."),
        (.holders, "Holders", "Who holds this coin: not checked yet."),
        (.pool, "Pool", "Where it trades: not checked yet."),
        (.socials, "Socials", "The accounts the coin lists: not checked yet."),
        (.links, "Links", "The coin's own documents: not checked yet."),
    ]
    static let linked = ["bought in the creation block", "funded by the creator before launch", "received tokens from the creator", "linked to the creator"]

    /// Which group a row belongs to and how it reads (orbit.ts `describe`). An unknown row still shows, under Links, in the source's words.
    static func describe(_ r: EvidenceHub.Row) -> (group: GroupID, text: String) {
        let w = r.what, to = short(r.to.id), from = short(r.from.id)
        switch w {
        case "created by": return (.creator, "Created by \(to)")
        case "launched by": return (.creator, "Launched by \(to)")
        case "fee receiver at launch": return (.creator, "Launch fees went to \(to)")
        case "coins launched (the launchpad's list)":
            let n = r.value?.number.map { String(Int($0)) } ?? r.value?.string
            return (.creator, n.map { "\(from) has launched \($0) coins (the launchpad's list)" } ?? "\(from) has launched other coins (the launchpad's list)")
        case "copies of this coin launched":
            return (.creator, "\(r.value?.number.map { String(Int($0)) } ?? "Some") copies of this coin were launched by the same creator")
        case "funded":
            guard let sol = r.value?.number else { return (.funders, "\(from) funded \(to)") }
            return (.funders, "\(from) sent \(amount(sol)) \(r.unit ?? "SOL") to \(to)")
        case "holds":
            let v = r.value?.record ?? [:]
            let marks = ["dev", "sniper", "bundler"].filter { if case .flag(true)? = v[$0] { true } else { false } }
            let tail = marks.isEmpty ? "" : " · the source marks it: \(marks.joined(separator: ", "))"
            // Base and BNB rows give a share of the supply, and a note on who the wallet is (a burn address, a launchpad's curve)
            let held = v["amount"]?.number.map { "\(amount($0)) of it" } ?? share(v["share"]?.number).map { "\($0) of the supply" } ?? "this coin"
            let note = v["note"]?.string.map { " · \($0)" } ?? ""
            return (.holders, "\(from) holds \(held)\(tail)\(note)")
        case "holds (dev team)":
            let s = share((r.value?.record ?? [:])["share"]?.number)
            return (.holders, s.map { "The dev team's wallets hold \($0) of it" } ?? "The dev team's wallets hold this coin")
        case "holders counted":
            guard let n = r.value?.number else { return (.holders, "Holders counted") }
            return (.holders, "\(grouped(n)) \(n == 1 ? "wallet holds" : "wallets hold") this coin")
        case "dev moves":
            let v = r.value?.record ?? [:]
            var parts: [String] = []
            if let m = v["members"]?.number { parts.append("\(plain(m)) \(m == 1 ? "wallet" : "wallets")") }
            if let a = v["acquired"]?.number { parts.append("\(amount(a)) tokens acquired") }
            if let h = v["half_out_after_s"]?.number { parts.append("half sent on after \(duration(h))") }
            return (.creator, "The creator's tokens moved\(parts.isEmpty ? "" : " · " + parts.joined(separator: ", "))")
        case "bought at launch":
            let v = r.value?.record ?? [:]
            let first = (r.unit ?? "").split(separator: "/", omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            let coin = first.isEmpty ? "ETH" : first
            var parts: [String] = []
            if let t = v["tokens"]?.number { parts.append("\(amount(t)) tokens") }
            if let e = v["eth"]?.number { parts.append("for \(plain(e)) \(coin)") }
            return (.creator, "\(from) bought at launch\(parts.isEmpty ? "" : " · " + parts.joined(separator: " "))")
        case "is a contract (a launch service, not a person)": return (.creator, "\(from) is a contract (a launch service, not a person)")
        case "owned by (contract owner)":
            let v = r.value?.record ?? [:]
            let parts = [v["template"]?.string, v["can"]?.string.map { "the owner can: \($0)" }].compactMap { $0 }.filter { !$0.isEmpty }
            return (.creator, "Contract owner: \(to)\(parts.isEmpty ? "" : " · " + parts.joined(separator: " · "))")
        case "creator rewards paid to": return (.creator, "Creator rewards go to \(to)")
        case "tax paid to": return (.creator, "Tax goes to \(to)")
        case "launched on": return (.pool, "Launched on \(r.to.id)")
        case "trades in pool (Uniswap v4)": return (.pool, "Trades in the Uniswap v4 pool \(to)")
        case "liquidity locked":
            let s = share(r.value?.number)
            return (.pool, "Liquidity locked\(s.map { ": \($0) of the pool" } ?? "") · \(r.to.id)")
        case "liquidity held by Zora's hook":
            let v = r.value?.record ?? [:]
            // what the owners can do with it is always shown
            let can = v["owners_can"]?.string.map { "; its owners can \($0)" } ?? ""
            return (.pool, "Zora's hook holds \(share(v["locked_share"]?.number) ?? "some") of the pool's liquidity\(can)")
        case "trading tax":
            let v = r.value?.record ?? [:]
            func pct(_ n: Double?) -> String { n.map { "\(plain($0))%" } ?? "–" }
            return (.pool, "Trading tax: buy \(pct(v["buy_pct"]?.number)), sell \(pct(v["sell_pct"]?.number))")
        case "trades in pool":
            let burned = share((r.value?.record ?? [:])["lp_burned_share"]?.number)
            return (.pool, "Trades in the pool \(to)\(burned.map { " · \($0) of its LP tokens burned" } ?? "")")
        case "market pair":
            let v = r.value?.record ?? [:]
            var parts: [String] = []
            if let d = v["dex"]?.string { parts.append("on \(d)") }
            if let m = v["market_cap"]?.number { parts.append("market cap \(money(m))") }
            if let l = v["liquidity_usd"]?.number { parts.append("liquidity \(money(l))") }
            return (.pool, "Market pair \(to)\(parts.isEmpty ? "" : " · " + parts.joined(separator: ", "))")
        case "trades on": return (.pool, "Trades on \(r.to.id)")
        case "launched": return (.pool, "Launched")
        case "lists its own link":
            let name = r.to.kind == "x" ? "X account" : r.to.kind == "telegram" ? "Telegram" : r.to.kind == "site" ? "website" : "link"
            return (.socials, "Lists its own \(name)")
        case "X check": return (.socials, "X check ran")
        case "creator's Zora profile": return (.socials, "Creator's Zora profile @\(r.to.id)")
        case "creator's linked account":
            let v = r.value?.record ?? [:]
            let who = v["username"]?.string.map { "@\($0)" } ?? r.to.id
            return (.socials, "Creator's linked account \(who)\(v["followers"]?.number.map { " · \(grouped($0)) followers" } ?? "")")
        case "metadata document": return (.links, "Metadata document")
        case "copy of the template": return (.links, r.value?.string.map { "Contract is a copy of \($0)" } ?? "Contract is a copy of a template")
        case "GoPlus security check (a lead)": return (.links, "GoPlus check (a lead): \(r.value?.string ?? "read")")
        default:
            if w.hasPrefix("dev team: ") { return (.creator, "Dev team wallet, \(w.dropFirst(10)): \(to)") }
            if linked.contains(w) { return (.creator, "Linked wallet \(to) · \(w)") }
            return (.links, w)
        }
    }

    struct Fact: Identifiable, Sendable, Equatable {
        let id: Int
        let text: String
        let onchain: Bool
        let readText: String?
        let happenedText: String?
        let source: String?
        let link: URL?
    }
    struct Group: Identifiable, Sendable, Equatable { let id: GroupID; let label: String; let empty: String; let facts: [Fact] }

    /// The six groups, always, in ring order; a group with no facts says so.
    static func orbitGroups(_ hub: EvidenceHub?, now: Date) -> [Group] {
        var facts: [GroupID: [Fact]] = [:]
        for (i, r) in (hub?.rows ?? []).enumerated() {
            let d = describe(r)
            facts[d.group, default: []].append(.init(id: i, text: d.text, onchain: r.onchain, readText: ago(r.readMs, now: now).map { "read \($0)" },
                                                    happenedText: ago(r.atMs, now: now).map { "happened \($0)" }, source: r.source, link: r.link))
        }
        // The engine did not trace the funding: an empty Funders group says why, not "not checked yet".
        let note = hub?.fundingNote
        return groups.map { g in
            let mine = facts[g.id] ?? []
            return Group(id: g.id, label: g.label, empty: g.id == .funders && mine.isEmpty && note != nil ? note! : g.empty, facts: mine)
        }
    }

    // MARK: The gate

    struct GateLine: Identifiable, Sendable, Equatable { let id: Int; let words: String; let when: String?; let links: [(label: String, url: URL)]
        static func == (a: GateLine, b: GateLine) -> Bool { a.id == b.id && a.words == b.words && a.when == b.when && a.links.map(\.label) == b.links.map(\.label) }
    }
    struct GateView: Sendable {
        let headline: String
        let lines: [GateLine]
        let others: [(label: String, when: String?, url: URL?)]
        let creatorLink: URL?
        let readText: String?
    }

    /// "3 min earlier", "2 h earlier"; nil when either time is missing or the other coin is not earlier.
    static func earlierBy(_ this: Double?, _ that: Double?) -> String? {
        guard let this, let that, that < this else { return nil }
        let min = max(1, Int(((this - that) / 60_000).rounded()))
        if min < 60 { return "\(min) min earlier" }
        let h = Int((Double(min) / 60).rounded())
        return h < 48 ? "\(h) h earlier" : "\(Int((Double(h) / 24).rounded())) days earlier"
    }

    static func gateView(_ g: EvidenceHub.Gate?, now: Date) -> GateView? {
        guard let g else { return nil }
        var lines: [GateLine] = []
        func add(_ words: String, _ when: String?, _ links: [(label: String, url: URL)]) { lines.append(.init(id: lines.count, words: words, when: when, links: links)) }
        for it in g.items {
            switch it {
            case let .earlierLookalike(words, coin, launched, link, creator, creatorLink):
                var links: [(String, URL)] = []
                if let link { links.append((coin.map { "see the earlier coin \(gateShort($0))" } ?? "see the earlier coin", link)) }
                if let creatorLink { links.append((creator.map { "its creator \(gateShort($0))" } ?? "its creator", creatorLink)) }
                add(words, earlierBy(g.launchedAtMs, launched).map { "launched \($0)" }, links.map { (label: $0.0, url: $0.1) })
            case let .sameCreatorRelaunch(words, coins):
                add(words, nil, coins.compactMap { c in c.link.map { (label: "see \(gateShort(c.coin))", url: $0) } })
            case let .plain(words): add(words, nil, [])
            }
        }
        let headline = g.status == "not read yet" ? "Not checked yet." : (!lines.isEmpty ? "Observed at launch:" : g.words.first ?? "Nothing matching was found at launch.")
        // A line the items did not carry (the file's own words) still shows once.
        if g.status != "not read yet", !lines.isEmpty {
            let seen = Set(lines.map(\.words))
            for w in g.words where !seen.contains(w) { add(w, nil, []) }
        }
        let others = g.otherCoins.map { c in (label: gateShort(c.coin), when: ago(c.launchedAtMs, now: now).map { "launched \($0)" }, url: c.link) }
        let read = ago(g.readMs, now: now)
        return GateView(headline: headline, lines: lines, others: others, creatorLink: g.creatorLink,
                        readText: read.map { "read \($0)\(g.source.map { " · \($0)" } ?? "")" } ?? g.source.map { "source: \($0)" })
    }

    // MARK: PINRai's reading

    struct ReceiptLine: Identifiable, Sendable { let id: Int; let text: String; let onchain: Bool; let when: String?; let url: URL? }
    struct PinraiLine: Identifiable, Sendable { let id: Int; let words: String; let reviewed: Bool; let receipts: [ReceiptLine] }
    struct PinraiView: Sendable { let headline: String; let lines: [PinraiLine]; let counts: String?; let readText: String? }

    static func pinraiView(_ p: EvidenceHub.Pinrai?, now: Date) -> PinraiView? {
        guard let p else { return nil }
        let lines = p.items.enumerated().map { i, it in
            PinraiLine(id: i, words: it.words, reviewed: it.reviewed, receipts: it.receipts.enumerated().map { j, r in
                let text = [r.source, r.value?.words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ": ")
                return ReceiptLine(id: j, text: text.isEmpty ? "see the source" : text, onchain: r.onchain, when: ago(r.asOfMs, now: now), url: r.link)
            })
        }
        let headline = p.status == "off" ? "PINRai is switched off."
            : p.status == "not read yet" ? "Not read yet."
            : !lines.isEmpty ? "Observed in the evidence:" : "Read, and no sign of the developer's intent was found in the evidence."
        // The model name and the "set aside / waiting" counts stay on /control; an older server that still sends them is read and ignored.
        let readAgo = ago(p.readMs, now: now)
        return PinraiView(headline: headline, lines: p.status == "read" ? lines : [], counts: nil, readText: readAgo.map { "read \($0)" })
    }
}
