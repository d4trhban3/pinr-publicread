import SwiftUI

/// The PINR page's choices, kept on the device as on the site: the filter, tiles per row, and how many tiles.
@MainActor
@Observable
final class PinrPrefs {
    var filter: PinrFilter = .trending
    /// Tiles across on a phone: 2, 3 or 4; a phone starts on 4 (the site's A1 fix).
    var perRow: Int = UserDefaults.standard.object(forKey: "pinr.cols") as? Int ?? 4 {
        didSet { UserDefaults.standard.set(perRow, forKey: "pinr.cols") }
    }
    var roster: Int = UserDefaults.standard.object(forKey: "pinr.roster") as? Int ?? Ranking.pageSize {
        didSet { UserDefaults.standard.set(roster, forKey: "pinr.roster") }
    }
    static let rowChoices = [2, 3, 4]
    static let rosterChoices = [60, 90, 120, 160, 200]
}

/// One PINR tile in the site's look (cards.ts and style.css `.card`): black glass with a bright rim; the picture
/// wearing its pair and launchpad badge; the name (the whole width on a narrow tile, cut with an ellipsis), the
/// $ticker in the small mono; MC and ATH; the ribbon; then the score at the bottom left on the mandarin-to-lime
/// scale and the coverage at the bottom right. the design's list exactly; no "Early" word.
struct TileView: View {
    let token: Token
    /// The tile's width on screen; sizes follow it, as the site's levels do.
    var width: CGFloat = 86
    var large = false

    private var k: CGFloat { max(0.8, width / 86) }

    var body: some View {
        // A short tile takes the first rows that fit, as the site's overflow does: a fee outside the rewards norm comes
        // first (ATH, then MC, are dropped before it); a rewards fee comes last, so it is the first row dropped.
        ViewThatFits(in: .vertical) {
            column(rows: 3)
            column(rows: 2)
        }
        .frame(width: width, height: width * 1.52, alignment: .topLeading)
        .glass(14 * k)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("tile-\(token.id)")
    }

    private func column(rows: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            TokenPicture(token: token, size: 26 * k)
            VStack(alignment: .leading, spacing: 2 * k) {
                Text(Format.title(token))
                    .font(Typo.fsans(10 * k, .semibold))
                    .tracking(-0.12)
                    .foregroundStyle(Brand.paper)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(Format.ticker(token))
                    .font(Typo.fmono(6.5 * k))
                    .foregroundStyle(Brand.mute)
                    .lineLimit(1)
            }
            .padding(.top, 4 * k)
            if token.label == nil {
                VStack(alignment: .leading, spacing: 2 * k) {
                    ForEach(Array(TileFacts.rows(mc: Format.tilePlusTrades(Format.usdCompact(token.valuationUsd), token.flow, hour: token.hourTrades), ath: Format.usdCompact(token.athUsd),
                                                 fee: token.transferFee).prefix(rows).enumerated()), id: \.offset) { _, r in
                        FactRow(label: r.label, value: r.value, size: 7.5 * k, minScale: r.label == "Fee" || r.label == "MC" ? 0.5 : 0.8)
                    }
                }
                .padding(.top, 6 * k)
            }
            RibbonView(ribbon: Ribbon(token.flow), dash: 2.2 * k, tileHeight: width * 1.52)
                .frame(height: 12 * k)
                .padding(.top, 2 * k)
            Spacer(minLength: 2)
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                ScoreText(token: token, size: 21 * k)
                Spacer(minLength: 0)
                // "Not investment advice" only on tiles wide enough to carry it (the site: from its 145 px tile up).
                CoverageStack(token: token, size: 7.5 * k, advice: width >= Advice.minTileWidth)
            }
        }
        .padding(.horizontal, 6 * k)
        .padding(.vertical, 7 * k)
    }

    private var spoken: String {
        var parts = [Format.title(token), Format.ticker(token)]
        if let label = token.label { parts.append("labelled \(label.rawValue), no score") }
        else if let s = token.score { parts.append("PINRscore \(s), coverage \(Format.coverage(token.coverage))") }
        else { parts.append(Ranking.isRead(token) ? "no score" : "not scored yet") }
        if token.label == nil {
            parts.append("market cap \(Format.usdCompact(token.valuationUsd))")
            if let ath = token.athUsd { parts.append("all-time high \(Format.usdCompact(ath))") }
            if let fee = token.transferFee?.short { parts.append("transfer fee \(fee)") }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// The coin's picture (a circle; a soft disc with its initial until it has one), wearing the dark badge pill with
/// its pair and launchpad marks at the lower right, as on the site (`.pbadge`). A copy (VAMP) shows neither.
struct TokenPicture: View {
    let token: Token
    let size: CGFloat

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Circle().fill(RadialGradient(colors: [Brand.fg.opacity(0.22), Brand.fg.opacity(0.06)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.6))
                Text(String(Format.title(token).prefix(1)).uppercased()).font(Typo.fsans(size * 0.46, .semibold)).foregroundStyle(Brand.mute)
                if token.label != .vamp, !NameFilter.masks(token), let url = token.imageURL {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() } else { Color.clear }
                    }
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().strokeBorder(Brand.fg.opacity(0.18), lineWidth: 1))
            let marks = token.label == .vamp ? [] : [Mark.pair(token), Mark.pad(token)].compactMap { $0 }
            if !marks.isEmpty {
                HStack(spacing: size * 0.04) {
                    ForEach(marks, id: \.rawValue) { MarkView(mark: $0).frame(width: size * 0.4, height: size * 0.4) }
                }
                .padding(.horizontal, size * 0.06)
                .padding(.vertical, size * 0.04)
                .background(Capsule().fill(Color(red: 8 / 255, green: 10 / 255, blue: 16 / 255).opacity(0.92)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
                .offset(x: size * 0.24, y: size * 0.16)
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

/// Kept for the tests: the badge's marks, in words.
enum Badge {
    static func text(for t: Token) -> String? {
        guard t.label != .vamp else { return nil }
        let pair = t.quotePair?.split(separator: "/").last.map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
        let pad = t.launchpad.map(short)
        let parts = [pair, pad].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func short(_ launchpad: String) -> String {
        let l = launchpad.lowercased()
        if l.contains("pump") { return "pump" }
        if l.contains("bonk") { return "bonk" }
        if l.contains("launchlab") || l.contains("raydium") { return "LL" }
        return String(launchpad.prefix(5))
    }
}

/// The score on the site's scale: mandarin at 25 and below, lime at 95 and above; a label (never with a number)
/// in mandarin and smaller; a dash when there is no number.
struct ScoreText: View {
    let token: Token
    var size: CGFloat = 24

    init(token: Token, size: CGFloat) { self.token = token; self.size = size }
    init(token: Token, large: Bool) { self.token = token; self.size = large ? 30 : 24 }

    var body: some View {
        if let label = token.label {
            Text(label.rawValue)
                .font(Typo.fsans(size * 0.42, .bold))
                .foregroundStyle(Brand.mandarin)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        } else if let s = token.score {
            Text(String(s))
                .font(Typo.fsans(size, .semibold))
                .tracking(-size * 0.04)
                .monospacedDigit()
                .foregroundStyle(Brand.score(s))
        } else {
            Capsule().fill(Brand.mute.opacity(0.7)).frame(width: size * 0.8, height: size * 0.12).padding(.bottom, size * 0.3)
        }
    }
}

/// The coverage as on the site: the percentage over the word "coverage", both in the small mono.
struct CoverageStack: View {
    let token: Token
    let size: CGFloat
    var advice = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 1.5) {
            if Ranking.isRead(token) {
                Text(Format.coverage(token.coverage)).font(Typo.fmono(size, .medium)).foregroundStyle(Brand.paper.opacity(0.85))
                Text("coverage").font(Typo.fmono(size * 0.74)).foregroundStyle(Brand.mute)
                if advice && Advice.shows(token) {
                    Text(Advice.line).font(Typo.fsans(size * 0.78, .medium)).foregroundStyle(Brand.mute)
                        .minimumScaleFactor(0.6).padding(.top, 1)
                }
            } else {
                // The site's unscored tile (cards.ts): a dash where the percentage goes, and the word "unscored".
                Text(Format.dash).font(Typo.fmono(size, .medium)).foregroundStyle(Brand.paper.opacity(0.85))
                Text("unscored").font(Typo.fmono(size * 0.74)).foregroundStyle(Brand.mute)
            }
        }
        .lineLimit(1)
    }
}

/// "MC $32.30M": the label in mute, the figure in the text colour, both mono, as the site's `.frow`.
struct FactRow: View {
    let label: String
    let value: String
    var size: CGFloat = 11
    /// How far the row may shrink to stay on one line; the fee's words ("5% not rewards") are the longest a tile carries.
    var minScale: CGFloat = 0.8

    var body: some View {
        // One text, so the whole row shrinks together to stay on one line (two texts in a stack truncated the second with "…").
        (Text(label).font(Typo.fmono(size)).foregroundColor(Brand.mute) + Text(" ") + Text(value).font(Typo.fmono(size * 1.12, .medium)).foregroundColor(Brand.paper))
            .lineLimit(1)
            .minimumScaleFactor(minScale)
    }
}

/// The coverage bar used on the coin page (kept from the earlier steps).
struct CoverageLine: View {
    let token: Token

    var body: some View {
        if Ranking.isRead(token) {
            HStack(spacing: 6) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Brand.fg.opacity(0.1))
                        Capsule().fill(Brand.lilac).frame(width: g.size.width * token.coverage / 100)
                    }
                }
                .frame(height: 3)
                Text(Format.coverage(token.coverage)).font(Typo.fmono(11)).foregroundStyle(Brand.mute).monospacedDigit()
            }
        } else {
            Text("Not scored yet").font(.caption2).foregroundStyle(Brand.mute)
        }
    }
}

/// The ribbon in the site's look (flow.ts, streams.ts): short trade streaks, lime for buys and mandarin for sells,
/// riding toward "now" at the right, spread a little up and down the band; bigger trades more solid, never thicker.
/// Still under reduced motion; nothing when the coin had no trades in the last hour.
struct RibbonView: View {
    let ribbon: Ribbon?
    var dash: CGFloat = 3
    /// The tile's height: a trade's size is how far from the line it rides, as a share of it.
    var tileHeight: CGFloat = 130
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: ribbon == nil || reduceMotion)) { timeline in
            Canvas { ctx, size in
                guard let ribbon else { return }
                let t = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                // Small and sparse, as on the site: a fixed number per ribbon. a trade's SIZE is its HEIGHT: a buy rides above the
                // line and a sell below it, up to 17% of the tile's height, swooping a further 60% in the last 18% of the ribbon; real trades
                // are drawn solid (size is no longer opacity), a mix counted in trades is faint and near the line.
                let mid = size.height / 2
                for i in 0..<10 {
                    let s = ribbon.streak(i, at: t)
                    let lane = Ribbon.lane(i)
                    let w = dash * (0.5 + 0.9 * lane.size)
                    let sz = ribbon.isCount ? lane.size * 0.5 * 0.5 : lane.size
                    let y = mid + Ribbon.sizeOffset(sz, buy: s.buy, u: s.u) * tileHeight + (lane.y - 0.5) * dash * 1.2 - dash * 0.275
                    let rect = CGRect(x: s.u * (size.width + w) - w, y: y, width: w, height: dash * 0.55)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: rect.height / 2),
                             with: .color((s.buy ? Brand.lime : Brand.mandarin).opacity(ribbon.isCount ? 0.35 : 0.95)))
                }
            }
        }
        .accessibilityHidden(true)
    }
}
