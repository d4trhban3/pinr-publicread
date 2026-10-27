import SwiftUI
import UIKit

/// Step 6: the DeepScan dossier in the site's look and order (ui/deepscan.ts): the score, Recent trades, Checks,
/// Evidence, The read, Social and callouts, Social (not scored), Similar tokens, Stats, and the fine print. Plain
/// sections under bold headings, divided by hairlines; one tinted word per check; every figure with its source line.
struct DeepScanBody: View {
    let token: Token
    let dossier: Dossier?
    let failed: Bool
    let client: CoinClient
    let all: [Token]
    var hub: EvidenceHub? = nil
    var hubLoaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScoreBlock(token: token)
            Rule()
            if token.label != .vamp { TradesSection(token: token, client: client); Rule() }
            if token.label != .vamp { PoolSectionView(dossier: dossier, launchpad: token.launchpad); Rule() }
            if token.label != .vamp { EvidenceHubBlock(hub: hub, loaded: hubLoaded); Rule() }
            if let d = dossier {
                if !d.available {
                    Section("DeepScan") { Text("PINR has no dossier for this coin yet. Nothing is shown in its place.").modifier(Prose()) }
                    Rule()
                }
                checks(d); Rule()
                evidence(d); Rule()
                if !d.read.isEmpty {
                    Section("The read") { ForEach(Array(d.read.enumerated()), id: \.offset) { Text($0.element).modifier(Prose(paper: true)) } }
                    Rule()
                }
                callouts(d); Rule()
                social(d); Rule()
            } else {
                Section("DeepScan") { Text(failed ? "Not read yet. PINR asks again shortly." : "Loading…").modifier(Prose()) }
                Rule()
            }
            SimilarSection(token: token, all: all); Rule()
            StatsSection(token: token, client: client)
            Text("Everything on this page is a measured reading or a dash. A dash means it was not measured. PINR is a research tool, not investment advice.")
                .font(Typo.sans(11)).foregroundStyle(Brand.mute).padding(.vertical, 18)
        }
    }

    private func checks(_ d: Dossier) -> some View {
        Section("Checks") {
            if d.flagged {
                Text("This token carries a label, so its checks are not shown.").modifier(Prose())
            } else if d.checks.isEmpty {
                Text(Format.dash).modifier(Prose())
            } else {
                ForEach(d.checks.filter { $0.name != "Social link" }) { c in
                    Row { Text(c.name).font(Typo.sans(14)).foregroundStyle(Brand.paper) } trailing: { BandChip(band: c.band, reason: c.reason) }
                }
            }
        }
    }

    private func evidence(_ d: Dossier) -> some View {
        Section("Evidence") {
            if d.facts.isEmpty { Text(Format.dash).modifier(Prose()) }
            // A copy (VAMP) never shows the fee (the contract): it has no data anywhere, only its label.
            ForEach(d.facts.filter { token.label != .vamp || !Dossier.feeFactIds.contains($0.id) }) { f in
                Row {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(f.label).font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.85))
                        // The fee's sentences are long ("5% · not a launchpad rewards fee"): they get the whole width, under the label.
                        if Dossier.feeFactIds.contains(f.id) {
                            Text(verbatim: f.value).font(Typo.mono(13, .bold)).foregroundStyle(Brand.paper).fixedSize(horizontal: false, vertical: true)
                        }
                        SourceLine(receipt: f.receipt, notRead: f.notRead)
                        ForEach(Array(f.lines.enumerated()), id: \.offset) { _, line in
                            // verbatim: the sentence is shown as written, never read as markup
                            Text(verbatim: line).font(Typo.sans(12)).foregroundStyle(Brand.paper.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
                        }
                        if let more = f.moreLinks {
                            HStack(spacing: 6) {
                                Text(verbatim: more.lead).font(Typo.mono(10)).foregroundStyle(Brand.mute)
                                ForEach(more.links) { l in
                                    Link(destination: l.url) { Text(verbatim: l.label).font(Typo.mono(10)).underline().foregroundStyle(Brand.paper.opacity(0.85)) }
                                }
                            }
                            .lineLimit(1).minimumScaleFactor(0.8)
                        }
                    }
                } trailing: {
                    HStack(spacing: 8) {
                        if f.highFee { Chip(text: "High fee", tone: .weak) }
                        if !Dossier.feeFactIds.contains(f.id) {
                            Text(f.value).font(Typo.mono(13, .bold)).foregroundStyle(Brand.paper).lineLimit(1).truncationMode(.middle)
                        }
                        if let copy = f.copy { CopyChip(value: copy) }
                    }
                }
            }
        }
    }

    private func callouts(_ d: Dossier) -> some View {
        Section("Social and callouts") {
            Caps("Where this token lists itself")
            ForEach(d.channels) { c in
                Row { Text(c.label).font(Typo.sans(14)).foregroundStyle(Brand.paper) } trailing: {
                    switch c.status {
                    case .listed:
                        if let u = c.url { Link(destination: u) { Chip(text: c.postBy.map { "A post by @\($0) · open" } ?? "Listed · open", tone: .good) } }
                    case .notListed: Chip(text: "Not listed", tone: .weak)
                    case .unknown: Chip(text: "Not read", tone: .none)
                    }
                }
            }
            if let link = d.checks.first(where: { $0.name == "Social link" }) {
                Row { Text("Links lead back to the token").font(Typo.sans(14)).foregroundStyle(Brand.paper) } trailing: { BandChip(band: link.band, reason: nil) }
            }
            Caps("Not measured yet").padding(.top, 10)
            ForEach(["Follower counts and how old the accounts are", "How active the posts are, and who engages with them",
                     "Callouts: other accounts or tapes mentioning the token"], id: \.self) { t in
                HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); Text(t) }.font(Typo.sans(13)).foregroundStyle(Brand.paper).padding(.vertical, 2)
            }
            Text("PINR does not read these yet. They are shown as not measured, never as zero, and they do not move the score.")
                .modifier(Prose()).padding(.top, 6)
        }
    }

    private func social(_ d: Dossier) -> some View {
        Section("Social (not scored)") {
            Text("Social presence unchecked until the X API is connected. This score reads the chain only. Nothing here moves the score.")
                .font(Typo.sans(11)).foregroundStyle(Brand.mute)
            if let s = d.social {
                Text(Dossier.totalsSentence(s.totals)).modifier(Prose(paper: true))
                ForEach(s.flags, id: \.self) { Text($0).font(Typo.sans(13)).foregroundStyle(Brand.mandarin) }
                ForEach(s.claims) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.line).font(Typo.sans(13)).foregroundStyle(Brand.paper)
                        HStack(spacing: 8) {
                            Chip(text: Dossier.resultWords[c.result] ?? "", tone: c.result == "MATCHES" ? .good : c.result == "DIVERGES" ? .weak : .none)
                            if c.removed { Text("post removed").font(Typo.mono(10)).foregroundStyle(Brand.mute) }
                            else if let u = c.postURL { Link("post", destination: u).font(Typo.mono(10)).foregroundStyle(Brand.lime).underline() }
                        }
                    }
                    .padding(.vertical, 6)
                }
                ForEach(s.gaps, id: \.self) { Text("Not read: " + $0).font(Typo.mono(10)).foregroundStyle(Brand.mute) }
            } else {
                Text("No social scan has been run for this coin yet. Nothing is claimed either way.").modifier(Prose())
            }
        }
    }
}

// MARK: - The pieces

/// A section: a bold heading, then its rows.
private struct Section<Content: View>: View {
    let title: String
    let content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Typo.sans(21, .bold)).foregroundStyle(Brand.paper).padding(.bottom, 6)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 20)
    }
}

/// A row with a hairline under it: the left side and what sits at the right.
private struct Row<L: View, R: View>: View {
    let leading: L
    let trailing: R
    init(@ViewBuilder _ leading: () -> L, @ViewBuilder trailing: () -> R) { self.leading = leading(); self.trailing = trailing() }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                leading
                Spacer(minLength: 8)
                trailing
            }
            .padding(.vertical, 11)
            .accessibilityElement(children: .combine)
            Rectangle().fill(Brand.fg.opacity(0.07)).frame(height: 1).accessibilityHidden(true)
        }
    }
}

private struct Prose: ViewModifier {
    var paper = false
    func body(content: Content) -> some View {
        content.font(Typo.sans(13.5)).foregroundStyle(paper ? Brand.paper : Brand.mute).lineSpacing(3)
    }
}

/// Small spaced capitals, as the site's sub-headings ("WHERE THIS TOKEN LISTS ITSELF").
private struct Caps: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View { Text(text.uppercased()).font(Typo.mono(10.5, .bold)).tracking(1.2).foregroundStyle(Brand.mute).padding(.bottom, 2) }
}

/// The site's tinted word chips.
struct Chip: View {
    enum Tone { case good, fair, weak, clear, none }
    let text: String
    let tone: Tone

    var body: some View {
        Text(text).font(Typo.sans(12, .semibold)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(fg).padding(.horizontal, 10).frame(height: 24)
            .background(Capsule().fill(bg))
    }

    private var fg: Color {
        switch tone {
        case .good: Brand.lime
        case .fair: Brand.amber
        case .weak: Brand.mandarin
        case .clear: Brand.paper
        case .none: Brand.mute
        }
    }

    private var bg: Color {
        switch tone {
        case .good: Brand.lime.opacity(0.14)
        case .fair: Brand.amber.opacity(0.16)
        case .weak: Brand.mandarin.opacity(0.16)
        case .clear, .none: Brand.fg.opacity(0.09)
        }
    }

    /// Which tint a check's word wears (the site's bandClass).
    static func tone(_ b: Dossier.Band) -> Tone {
        switch b {
        case .strong: .good
        case .fair: .fair
        case .weak: .weak
        case .clear: .clear
        case .noData, .notRead: .none
        }
    }
}

/// One check's word; "Not read" carries its reason in the same chip, as on the site.
struct BandChip: View {
    let band: Dossier.Band
    let reason: String?

    var body: some View {
        Chip(text: band == .notRead ? ([band.rawValue, reason].compactMap { $0 }.joined(separator: " · ")) : band.rawValue, tone: Chip.tone(band))
    }
}

struct CopyChip: View {
    let value: String
    @State private var copied = false

    var body: some View {
        Button { UIPasteboard.general.string = value; copied = true } label: {
            Text(copied ? "Copied" : "Copy").font(Typo.sans(12, .semibold)).foregroundStyle(Brand.paper)
                .padding(.horizontal, 10).frame(height: 26).background(Capsule().fill(Brand.fg.opacity(0.1)))
        }
        .accessibilityLabel("Copy the address")
    }
}

/// "Solana chain · read 3 h ago · View", or "no source" when the receipt is not whole.
struct SourceLine: View {
    let receipt: Dossier.Fact.Receipt?
    /// The engine has not read this figure yet (the transfer fee).
    var notRead = false

    var body: some View {
        if let r = receipt {
            HStack(spacing: 4) {
                Text("\(r.source) · read \(DiscoverCard.scoredAgo(r.readAt)) ·").font(Typo.mono(10)).foregroundStyle(Brand.mute)
                Link(destination: r.link) { Text("View").font(Typo.mono(10)).underline().foregroundStyle(Brand.paper.opacity(0.85)) }
            }
            .lineLimit(1).minimumScaleFactor(0.8)
        } else {
            Text(notRead ? "not read yet" : "no source").font(Typo.mono(10)).foregroundStyle(Brand.mute)
        }
    }
}

/// The score: the site's ring in the score's colour with the number inside, and what it rests on beside it.
private struct ScoreBlock: View {
    let token: Token

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            ZStack {
                Circle().stroke(Brand.fg.opacity(0.09), lineWidth: 9)
                if let s = token.score {
                    Circle().trim(from: 0, to: Double(s) / 100)
                        .stroke(Brand.score(s), style: StrokeStyle(lineWidth: 9, lineCap: .round)).rotationEffect(.degrees(-90))
                }
                VStack(spacing: 2) {
                    if let label = token.label {
                        Text(label.rawValue).font(Typo.sans(16, .bold)).foregroundStyle(Brand.mandarin)
                    } else if let s = token.score {
                        Text(String(s)).font(Typo.sans(34, .semibold)).monospacedDigit().foregroundStyle(Brand.score(s))
                    } else {
                        Text(Format.dash).font(Typo.sans(34, .semibold)).foregroundStyle(Brand.mute)
                    }
                    Text("PINR INDEX").font(Typo.mono(8.5, .medium)).tracking(1.2).foregroundStyle(Brand.mute)
                }
            }
            .frame(width: 108, height: 108)
            VStack(alignment: .leading, spacing: 8) {
                Text(loadedLine).font(Typo.mono(12)).foregroundStyle(Brand.paper.opacity(0.85))
                if Advice.shows(token) { Text(Advice.line).font(Typo.sans(12, .semibold)).foregroundStyle(Brand.paper) }
                // The feed's note ("Not scored yet" on a seen coin) is not said twice beside the line above it.
                if let note = EngineNote.shown(token.note), token.label == nil, note != loadedLine { Text(note).font(Typo.sans(12)).foregroundStyle(Brand.paper) }
                Text("Social presence unchecked until the X API is connected. This score reads the chain only.")
                    .font(Typo.sans(11.5)).foregroundStyle(Brand.mute)
            }
        }
        .padding(.vertical, 18)
    }

    private var loadedLine: String {
        guard Ranking.isRead(token) else { return "Not scored yet" }
        var s = "\(Format.coverage(token.coverage)) of the readings loaded"
        if let a = token.asOf { s += " · scored \(DiscoverCard.scoredAgo(a))" }
        return s
    }
}

/// Recent trades from the tape: the buy and sell bars, then the newest trades; the site's wording while it loads.
private struct TradesSection: View {
    let token: Token
    let client: CoinClient
    @Environment(FeedStore.self) private var store
    @State private var tape: Tape?
    @State private var failed = false
    /// Trades the stream brought for this coin since the page opened, newest first: shown on top at once; the next tape
    /// read, every 10 s, takes over the ones it holds.
    @State private var live: [Trade] = []
    @State private var seen = -1

    /// The tape's trades with the live ones that are newer than its newest on top.
    private var rows: [Trade] {
        let newest = tape?.trades.first?.time ?? .distantPast
        return live.filter { $0.time > newest } + (tape?.trades ?? [])
    }

    var body: some View {
        Section("Recent trades") {
            if let tape, !tape.none {
                if let f = tape.summary { PressureBars(flow: f).padding(.bottom, 4) }
                if !tape.complete { Text("Some trades may be missing: the newest trades do not reach back the whole hour.").modifier(Prose()) }
                ForEach(rows.prefix(20)) { t in
                    Row {
                        HStack(spacing: 10) {
                            Text(t.buy ? "Buy" : "Sell").font(Typo.mono(12, .bold)).foregroundStyle(t.buy ? Brand.lime : Brand.mandarin).frame(width: 38, alignment: .leading)
                            Text(Format.usd(t.usd)).font(Typo.mono(12)).foregroundStyle(Brand.paper)
                        }
                    } trailing: { Text(Format.ago(t.time)).font(Typo.mono(11)).foregroundStyle(Brand.mute) }
                }
                Text("Pump.fun's trade list").font(Typo.mono(9.5)).foregroundStyle(Brand.mute).padding(.top, 4)
            } else {
                Text(note).modifier(Prose())
            }
        }
        .onChange(of: store.tickCount) {
            // The stream's trades for this coin, each put on top as it arrives (one redraw for the message).
            let fresh = seen < 0 ? 0 : min(store.tickCount - seen, store.recentTicks.count)
            seen = store.tickCount
            guard fresh > 0 else { return }
            var added = false
            for (n, t) in store.recentTicks.suffix(fresh).enumerated() where t.address == token.id {
                guard let usd = t.usd, usd > 0, let buy = t.isBuy else { continue }
                live.insert(Trade(time: t.at, buy: buy, usd: usd, index: -(store.tickCount - fresh + n + 1)), at: 0)
                added = true
            }
            if added { live = Array(live.prefix(40)) }
        }
        .task(id: token.id) {
            live = []; seen = store.tickCount
            while !Task.isCancelled {
                do { tape = try await client.tape(token.address); failed = false } catch { failed = true }
                try? await Task.sleep(for: .seconds(tape?.none == false ? 10 : 3))
            }
        }
    }

    private var note: String {
        if failed { return "Trades are not read yet. PINR asks again shortly." }
        return TradesWords.noTradesRead
    }
}

/// Buys against sells over 5 minutes and the hour; "by count" when the figures are numbers of trades.
struct PressureBars: View {
    let flow: Token.Flow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            bar("5 min", flow.buy5m, flow.sell5m, flow.trades5m)
            bar("1 hour", flow.buy1h, flow.sell1h, flow.trades1h)
            if flow.isCount { Text("by count").font(Typo.mono(10)).foregroundStyle(Brand.mute) }
        }
    }

    private func bar(_ label: String, _ b: Double, _ s: Double, _ n: Int) -> some View {
        HStack(spacing: 8) {
            Text(label).font(Typo.mono(10)).foregroundStyle(Brand.mute).frame(width: 44, alignment: .leading)
            GeometryReader { g in
                let total = b + s
                HStack(spacing: 0) {
                    Rectangle().fill(Brand.lime).frame(width: total > 0 ? g.size.width * b / total : 0)
                    Rectangle().fill(total > 0 ? Brand.mandarin : Brand.fg.opacity(0.08))
                }
                .clipShape(Capsule())
            }
            .frame(height: 6)
            Text(flow.isCount ? "\(Int(b)) / \(Int(s))" : "\(Format.usdCompact(b)) / \(Format.usdCompact(s))")
                .font(Typo.mono(10)).foregroundStyle(Brand.paper).lineLimit(1)
            Text("\(n)").font(Typo.mono(10)).foregroundStyle(Brand.mute)
        }
    }
}

/// Similar tokens: same chain, close in size and age (measured facts only); tap one to open it.
private struct SimilarSection: View {
    let token: Token
    let all: [Token]
    @Environment(CoinSelection.self) private var selection
    @Environment(ModerationStore.self) private var moderation

    var body: some View {
        let list = moderation.visible(Similar.tokens(to: token, in: all, count: 10)).prefix(5)
        Section("Similar tokens") {
            if list.isEmpty { Text("No coin close enough in chain, size and age to compare.").modifier(Prose()) }
            ForEach(list) { t in
                Button { selection.id = t.id } label: {
                    HStack(spacing: 12) {
                        TokenPicture(token: t, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(t.ticker == nil ? Format.title(t) : Format.ticker(t)).font(Typo.sans(15, .bold)).foregroundStyle(Brand.paper).lineLimit(1)
                            Text([Format.usdCompact(t.valuationUsd), t.launchedAt.map { "\(Self.age($0)) old" }].compactMap { $0 }.joined(separator: " · "))
                                .font(Typo.mono(11)).foregroundStyle(Brand.mute)
                        }
                        Spacer()
                        if let l = t.label { Text(l.rawValue).font(Typo.sans(13, .bold)).foregroundStyle(Brand.mandarin) }
                        else if let s = t.score { Text(String(s)).font(Typo.sans(20, .semibold)).foregroundStyle(Brand.score(s)) }
                        else { Text(Format.dash).foregroundStyle(Brand.mute) }
                    }
                    .padding(.horizontal, 12).frame(height: 58)
                    .glass(18)
                }
                .buttonStyle(PressScale())
            }
        }
    }

    static func age(_ d: Date) -> String {
        let m = max(0, Date().timeIntervalSince(d) / 60)
        if m < 60 { return "\(max(1, Int(m)))m" }
        if m < 2880 { return "\(Int(m / 60))h" }
        return "\(Int(m / 1440))d"
    }
}

/// Stats: the app's own figures with their source and age, the day's open, high and low from the chart source,
/// and the coin's plain facts.
private struct StatsSection: View {
    let token: Token
    let client: CoinClient
    @State private var day: CandleSet?

    var body: some View {
        Section("Stats") {
            stat("Market cap", Format.usdCompact(token.valuationUsd), token.capReceipt.map { ($0.source, $0.at) }, sourced: true)
            stat("All-time high (market cap)", Format.usdCompact(token.athUsd), token.athReceipt.map { ($0.source, $0.at) }, sourced: true)
            stat("Liquidity", Format.usdCompact(token.liquidityUsd), token.quoteReceipt.map { ($0.source, $0.at) }, sourced: true)
            stat("24h volume", Format.usdCompact(token.volume24hUsd), token.quoteReceipt.map { ($0.source, $0.at) }, sourced: true)
            // Only current or dated candles; a stale day's receipt carries its real read time.
            let last = day.map { $0.status == .ok || $0.status == .stale ? $0.candles.suffix(24) : [] } ?? []
            let src = day?.source.map { ($0, day?.asOf ?? Date()) }
            stat("24h open", last.first.map { Format.priceCompact($0.open) } ?? Format.dash, last.isEmpty ? nil : src, sourced: true)
            stat("24h high", last.map(\.high).max().map { Format.priceCompact($0) } ?? Format.dash, last.isEmpty ? nil : src, sourced: true)
            stat("24h low", last.map(\.low).min().map { Format.priceCompact($0) } ?? Format.dash, last.isEmpty ? nil : src, sourced: true)
            stat("Quote pair", token.quotePair ?? Format.dash, token.quoteReceipt.map { ($0.source, $0.at) }, sourced: true)
            stat("Age", token.launchedAt.map { SimilarSection.age($0) } ?? Format.dash, nil)
            stat("Chain", token.chain ?? Format.dash, nil)
            stat("Launchpad", token.launchpad ?? Format.dash, nil)
            stat("Coverage", Ranking.isRead(token) ? Format.coverage(token.coverage) : Format.dash, nil)
            stat("Contract", String(token.address.prefix(6)) + "…" + String(token.address.suffix(4)), nil)
        }
        .task(id: token.id) { day = try? await client.candles(token.address, .h1) }
    }

    /// the team, 26 Oct: a figure is shown only with its source named; with none it is a dash that says "not read yet".
    private func stat(_ label: String, _ value: String, _ receipt: (String, Date)?, sourced: Bool = false) -> some View {
        let f = FigureRule.shown(value, hasSource: receipt != nil, sourced: sourced)
        return Row {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(Typo.sans(13.5)).foregroundStyle(Brand.paper)
                if f.notRead {
                    Text("not read yet").font(Typo.mono(10)).foregroundStyle(Brand.mute)
                } else if value != Format.dash, let r = receipt {
                    Text("\(r.0) · read \(DiscoverCard.scoredAgo(r.1))").font(Typo.mono(10)).foregroundStyle(Brand.mute)
                }
            }
        } trailing: {
            Text(f.value).font(Typo.mono(13, .bold)).foregroundStyle(Brand.paper).lineLimit(1).truncationMode(.middle)
        }
    }
}

// MARK: - The evidence hub

/// "At launch" (the gate's result), PINRai's reading with its receipts, then the evidence rows in the site's six groups
/// (world/orbit.ts). A doctor's words: what was observed, never a verdict. ● read on chain, ○ reported by the source named.
struct EvidenceHubBlock: View {
    let hub: EvidenceHub?
    let loaded: Bool

    var body: some View {
        let now = Date()
        VStack(alignment: .leading, spacing: 0) {
            if !loaded {
                Section("Evidence") { Text("Loading…").modifier(Prose()) }
            } else if hub == nil {
                Section("Evidence") { Text("No evidence has been recorded for this coin yet.").modifier(Prose()) }
            } else {
                if let g = EvidenceWords.gateView(hub?.gate, now: now) { gate(g); Rule() }
                if let p = EvidenceWords.pinraiView(hub?.pinrai, now: now) { pinrai(p); Rule() }
                orbit(EvidenceWords.orbitGroups(hub, now: now))
            }
        }
    }

    private func gate(_ g: EvidenceWords.GateView) -> some View {
        Section("At launch") {
            Text(verbatim: g.headline).font(Typo.sans(13.5, .semibold)).foregroundStyle(Brand.paper)
            ForEach(g.lines) { l in
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: l.words).font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                    if let w = l.when { Text(verbatim: w).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                    ForEach(Array(l.links.enumerated()), id: \.offset) { _, k in
                        Link(destination: k.url) { Text(verbatim: k.label).font(Typo.mono(11)).underline().foregroundStyle(Brand.paper.opacity(0.85)) }
                    }
                }
                .padding(.vertical, 6)
            }
            if !g.others.isEmpty {
                Caps("The creator's other coins")
                ForEach(Array(g.others.prefix(5).enumerated()), id: \.offset) { _, c in
                    HStack(spacing: 8) {
                        if let u = c.url { Link(destination: u) { Text(verbatim: c.label).font(Typo.mono(11)).underline().foregroundStyle(Brand.paper.opacity(0.85)) } }
                        else { Text(verbatim: c.label).font(Typo.mono(11)).foregroundStyle(Brand.paper.opacity(0.85)) }
                        if let w = c.when { Text(verbatim: w).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                    }
                }
            }
            if let u = g.creatorLink { Link(destination: u) { Text("See the creator").font(Typo.mono(11)).underline().foregroundStyle(Brand.paper.opacity(0.85)) } }
            if let r = g.readText { Text(verbatim: r).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
        }
    }

    private func pinrai(_ p: EvidenceWords.PinraiView) -> some View {
        Section("PINRai") {
            Text(verbatim: p.headline).font(Typo.sans(13.5, .semibold)).foregroundStyle(Brand.paper)
            ForEach(p.lines) { l in
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: l.words).font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                    if !l.reviewed { Text("not reviewed yet").font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                    ForEach(l.receipts) { r in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(ReceiptMark.mark(onchain: r.onchain)).font(Typo.mono(11)).foregroundStyle(Brand.mute).accessibilityLabel(ReceiptMark.word(onchain: r.onchain))
                            if let u = r.url { Link(destination: u) { Text(verbatim: r.text).font(Typo.mono(11)).underline().foregroundStyle(Brand.paper.opacity(0.85)) } }
                            else { Text(verbatim: r.text).font(Typo.mono(11)).foregroundStyle(Brand.paper.opacity(0.85)) }
                            if let w = r.when { Text(verbatim: w).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                            if let n = ReceiptMark.note(onchain: r.onchain, hasLink: r.url != nil) { Text(verbatim: n).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
            if let c = p.counts { Text(verbatim: c).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
            if let r = p.readText { Text(verbatim: r).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
        }
    }

    private func orbit(_ groups: [EvidenceWords.Group]) -> some View {
        Section("Evidence trail") {
            Text("Every fact says what it is, whether it was read on chain (●) or only reported (○), and where to see it. Nothing here is a verdict.").modifier(Prose())
            ForEach(groups) { g in
                Caps(g.label).padding(.top, 8)
                if g.facts.isEmpty { Text(verbatim: g.empty).modifier(Prose()) }
                ForEach(g.facts) { f in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(ReceiptMark.mark(onchain: f.onchain)).font(Typo.mono(11)).foregroundStyle(Brand.mute).accessibilityLabel(ReceiptMark.word(onchain: f.onchain))
                            Text(verbatim: f.text).font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                        }
                        let meta = [f.source, f.readText, f.happenedText, ReceiptMark.note(onchain: f.onchain, hasLink: f.link != nil)].compactMap { $0 }.joined(separator: " · ")
                        if !meta.isEmpty { Text(verbatim: meta).font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                        if let u = f.link { Link(destination: u) { Text("See the evidence").font(Typo.mono(10.5)).underline().foregroundStyle(Brand.paper.opacity(0.85)) } }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

// MARK: - The pool

/// The Pool section (the site's `renderPool`): pool created, liquidity added and removed, the coin creator changed, bought back and burned, newest first. Each is
/// an observed fact (●) with who, how much, when (UTC) and a link to its transaction. No file: "Not checked yet."; a file with no events: "No pool events observed."
struct PoolSectionView: View {
    let dossier: Dossier?
    var launchpad: String? = nil

    var body: some View {
        Section("Pool") {
            if dossier == nil {
                Text("Loading…").modifier(Prose())
            } else if let p = dossier?.pool, p.state == "read" {
                if p.events.isEmpty { Text("No pool events observed.").modifier(Prose()) }
                ForEach(p.events) { e in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text("●").font(Typo.mono(11)).foregroundStyle(Brand.mute).accessibilityLabel("read on chain")
                            Text(verbatim: PoolWords.title(e.kind)).font(Typo.sans(13, .semibold)).foregroundStyle(Brand.paper)
                        }
                        let what = PoolWords.what(e)
                        if !what.isEmpty { Text(verbatim: what).font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.9)).fixedSize(horizontal: false, vertical: true) }
                        if e.kind == "coin creator changed" {
                            if let a = e.oldCreator, let u = PoolWords.accountURL(a, chain: p.chain) { link("from \(PoolWords.short(a))", u) }
                            if let a = e.newCreator, let u = PoolWords.accountURL(a, chain: p.chain) { link("to \(PoolWords.short(a))", u) }
                        } else if let a = e.user, let u = PoolWords.accountURL(a, chain: p.chain) { link("by \(PoolWords.short(a))", u) }
                        Text(verbatim: PoolWords.local(e.atMs)).font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
                        if let u = PoolWords.txURL(e.sig, chain: p.chain) { link("View transaction", u) }
                    }
                    .padding(.vertical, 6)
                }
                if !p.events.isEmpty {
                    Text("Observed on chain\(p.source.map { " (\($0))" } ?? "")\(p.asOfMs.map { ", read \(PoolWords.local($0))" } ?? ""). Pool history from before PINR listed the coin is not read yet.")
                        .font(Typo.mono(10)).foregroundStyle(Brand.mute)
                }
            } else if let d = dossier, !d.poolRows.isEmpty {
                // No pool-events file (Base, BNB): the pool facts the evidence file holds, each ● only with its receipt link (checklist 6).
                ForEach(d.poolRows) { r in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(ReceiptMark.mark(onchain: r.onchain)).font(Typo.mono(11)).foregroundStyle(Brand.mute).accessibilityLabel(ReceiptMark.word(onchain: r.onchain))
                            Text(verbatim: r.what.prefix(1).uppercased() + r.what.dropFirst()).font(Typo.sans(13, .semibold)).foregroundStyle(Brand.paper)
                        }
                        let shown = poolValue(r)
                        Text(verbatim: [shown, r.source ?? "source not stated"].compactMap { $0 }.joined(separator: " · ")).font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
                        if let u = r.link { link("View receipt", u) } else { Text("no receipt link yet").font(Typo.mono(10.5)).foregroundStyle(Brand.mute) }
                    }
                }
                Text("From this coin's evidence file. Pool events are not read for this coin yet.").font(Typo.mono(10)).foregroundStyle(Brand.mute)
            } else {
                Text(FigureRule.noPoolWords(launchpad)).modifier(Prose())
            }
        }
    }

    /// A pool row's figure in words: a share of pool value as a percent, any other figure with its unit.
    private func poolValue(_ r: Dossier.PoolRow) -> String? {
        guard let v = r.value else { return nil }
        if r.unit == "share of pool value", let n = Double(v) { return "\(Int((n * 100).rounded()))% of the pool's value" }
        return r.unit.map { "\(v) \($0)" } ?? v
    }

    private func link(_ text: String, _ url: URL) -> some View {
        Link(destination: url) { Text(verbatim: text).font(Typo.mono(11)).underline().foregroundStyle(Brand.paper.opacity(0.85)) }
    }
}
