import Charts
import SwiftUI

/// A Discover card in the site's look at phone width (ui/discover.ts, style.css `.drow`): glass with a 26-point
/// radius. Top: the PINR tile's content on the left (picture with its badge, name, $ticker · age, the ribbon, MC
/// and ATH) and the score with what it rests on at the right. Then the lite chart with its options, the move and
/// the volume, and the two ways in: PINRterminal and Deep Scan.
struct DiscoverCard: View {
    let token: Token
    let client: CoinClient
    var open: (Token) -> Void = { _ in }

    @Environment(FeedStore.self) private var store
    @State private var tradesSeen = -1
    @State private var tf: Timeframe?
    @State private var candlesStyle = false
    @State private var set: CandleSet?
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                left
                Spacer(minLength: 6)
                right
            }
            if token.label != .vamp {
                options
                chart.frame(height: 150)
                    .task(id: tf) { if let tf { await load(tf) } }
                    // the chart moves with the stream's price and the coin's own trades between reads.
                    .onChange(of: store.lastHeard) {
                        guard let tf, let current = set, let next = LiveCandle.advance(current, tf, id: token.id, store: store, seen: &tradesSeen) else { return }
                        set = next
                    }
                HStack {
                    Text(Format.change(token.change24hPct, windowHours: token.changeWindowHours))
                        .font(Typo.mono(13, .bold))
                        .foregroundStyle((token.change24hPct ?? 0) >= 0 ? Brand.lime : Brand.mandarin)
                    Spacer()
                    Text("VOL \(Format.usdCompact(token.volume24hUsd))").font(Typo.mono(12)).foregroundStyle(Brand.paper.opacity(0.8))
                }
            }
            HStack(spacing: 10) {
                Button { open(token) } label: {
                    HStack(spacing: 6) {
                        WordmarkImage().scaledToFit().frame(height: 12)
                        Text("terminal").font(Typo.sans(14, .semibold)).foregroundStyle(Brand.lime)
                    }
                    .frame(maxWidth: .infinity).frame(height: 40)
                    .background(Capsule().fill(Brand.lime.opacity(0.08)))
                    .overlay(Capsule().strokeBorder(Brand.lime.opacity(0.6), lineWidth: 1))
                }
                .accessibilityLabel("Open in PINRterminal")
                Button { open(token) } label: {
                    HStack(spacing: 6) {
                        Glyph.deepscan.view(size: 17)
                        Text("Deep Scan").font(Typo.sans(14, .semibold))
                    }
                    .foregroundStyle(Brand.paper)
                    .frame(maxWidth: .infinity).frame(height: 40)
                    .background(Capsule().fill(Brand.fg.opacity(0.07)))
                    .contentShape(Capsule())
                }
                .accessibilityLabel("Open its DeepScan")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .glass(26)
        .accessibilityIdentifier("dcard-\(token.id)")
    }

    private var left: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                TokenPicture(token: token, size: 46)
                VStack(alignment: .leading, spacing: 3) {
                    Text(Format.title(token)).font(Typo.sans(14, .semibold)).foregroundStyle(Brand.paper).lineLimit(1)
                    Text([Format.ticker(token), age].compactMap { $0 }.joined(separator: " · "))
                        .font(Typo.mono(10)).foregroundStyle(Brand.mute).lineLimit(1)
                }
            }
            .padding(.bottom, 6)
            // R4: a little larger than a tile's ribbon, both ways.
            RibbonView(ribbon: Ribbon(token.flow), dash: 5, tileHeight: 100).frame(width: 140, height: 16)
            if token.label == nil {
                VStack(alignment: .leading, spacing: 4) {
                    FactRow(label: "MC", value: Format.usdCompact(token.valuationUsd), size: 10.5)
                    FactRow(label: "ATH", value: Format.usdCompact(token.athUsd), size: 10.5)
                }
            }
        }
    }

    private var right: some View {
        VStack(alignment: .trailing, spacing: 3) {
            if let label = token.label {
                Text(label.rawValue).font(Typo.sans(15, .bold)).foregroundStyle(Brand.mandarin)
            } else if let s = token.score {
                Text(String(s)).font(Typo.sans(42, .semibold)).tracking(-1.6).monospacedDigit()
                    .foregroundStyle(Brand.score(s)).opacity(token.coverage < 30 ? 0.6 : 1)
            } else {
                Text(Format.dash).font(Typo.sans(42, .semibold)).foregroundStyle(Brand.mute)
            }
            Rectangle().fill(Brand.fg.opacity(0.12)).frame(width: 80, height: 1).padding(.vertical, 3)
            Group {
                if Ranking.isRead(token) {
                    Text(Format.coverage(token.coverage)).font(Typo.mono(11, .medium)).foregroundStyle(Brand.paper)
                    Text("coverage")
                    Text("Chain only")
                    if Advice.shows(token) { Text(Advice.line).font(Typo.sans(9.5)) }
                    if let a = token.asOf { Text("scored " + Self.scoredAgo(a)) }
                } else {
                    Text("not scored yet")
                }
                if token.flow?.isCount == true { Text("by count") }
            }
            .font(Typo.mono(9.5))
            .foregroundStyle(Brand.mute)
        }
        .multilineTextAlignment(.trailing)
    }

    /// "just now", "41 min ago", "5 h ago", "2 days ago" (the site's scoredAgo).
    static func scoredAgo(_ d: Date, now: Date = Date()) -> String {
        let min = max(0, Int(now.timeIntervalSince(d) / 60))
        if min < 1 { return "just now" }
        if min < 60 { return "\(min) min ago" }
        let h = min / 60
        if h < 24 { return "\(h) h ago" }
        let days = h / 24
        return "\(days) \(days == 1 ? "day" : "days") ago"
    }

    /// The coin's age, short: "41m", "3h", "2d" (the site's ageText).
    private var age: String? {
        guard let l = token.launchedAt else { return nil }
        let m = max(0, Date().timeIntervalSince(l) / 60)
        if m < 60 { return "\(max(1, Int(m.rounded())))m" }
        if m < 60 * 48 { return "\(Int((m / 60).rounded()))h" }
        return "\(Int((m / 1440).rounded()))d"
    }

    // MARK: - The lite chart

    private var options: some View {
        HStack(spacing: 6) {
            chip("Live", on: tf == nil) { tf = nil }
            ForEach([Timeframe.m15, .h1, .h4, .d1]) { t in chip(t.rawValue, on: tf == t) { tf = t } }
            chip(candlesStyle ? "Line" : "Candles", on: false) { candlesStyle.toggle() }.padding(.leading, 4)
        }
    }

    private func chip(_ text: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(Typo.mono(12, .medium)).padding(.horizontal, 10).frame(height: 26)
                .foregroundStyle(on ? Brand.lime : Brand.paper.opacity(0.85))
                .background(Capsule().fill(on ? Brand.lime.opacity(0.16) : Brand.fg.opacity(0.07)))
                .overlay(Capsule().strokeBorder(on ? Brand.lime.opacity(0.45) : .clear, lineWidth: 1))
        }
    }

    @ViewBuilder private var chart: some View {
        if let tf {
            if let set, set.drawable, let range = set.range {
                LitePlot(points: set.shown.map(\.close), candles: candlesStyle ? set.shown : nil, range: range,
                         log: set.logScale, label: (set.asOfText ?? set.source).map { "\(tf.rawValue) · \($0)" })
            } else {
                note(loading ? "loading…" : failed ? "chart not read yet" :
                        set?.status == .busy ? "chart not read yet" : "no candles for this size")
            }
        } else if let c = LiteChart(token) {
            let lo = c.points.min()!, hi = max(c.points.max()!, lo * 1.0001)
            LitePlot(points: c.points, candles: nil, range: lo...hi, log: c.logScale, label: c.label)
        } else {
            note("no price history yet")
        }
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Typo.mono(11)).foregroundStyle(Brand.mute.opacity(0.7)).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load(_ t: Timeframe) async {
        loading = true; set = nil
        do { set = try await client.candles(token.address, t); failed = false } catch { failed = true }
        loading = false
        // The site's card: while the chart is busy or stale, ask again every 8 seconds until the card goes or changes size.
        while !Task.isCancelled, set?.status == .busy || set?.status == .stale {
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let next = try? await client.candles(token.address, t), !Task.isCancelled else { return }
            if next.status == .busy, set?.status == .stale { continue }
            set = next
        }
    }
}

/// The site's lite chart: three faint gridlines, a light line with a soft fill under it (lime when it ends up,
/// mandarin when down) and a dot at the last price; or candles; whose data it is in the corner.
struct LitePlot: View {
    let points: [Double]
    let candles: [Candle]?
    let range: ClosedRange<Double>
    let log: Bool
    let label: String?

    var body: some View {
        let rising = (points.last ?? 0) >= (points.first ?? 0)
        let tone = rising ? Brand.lime : Brand.mandarin
        ZStack(alignment: .bottomTrailing) {
            Chart {
                if let candles {
                    ForEach(Array(candles.enumerated()), id: \.offset) { i, k in
                        RuleMark(x: .value("i", i), yStart: .value("l", k.low), yEnd: .value("h", k.high))
                            .foregroundStyle(k.close >= k.open ? Brand.lime : Brand.mandarin).lineStyle(StrokeStyle(lineWidth: 1))
                        RectangleMark(x: .value("i", i), yStart: .value("o", min(k.open, k.close)), yEnd: .value("c", max(k.open, k.close)),
                                      width: .fixed(max(1.5, 220 / Double(candles.count))))
                            .foregroundStyle(k.close >= k.open ? Brand.lime : Brand.mandarin)
                    }
                } else {
                    ForEach(Array(points.enumerated()), id: \.offset) { i, v in
                        AreaMark(x: .value("i", i), yStart: .value("base", range.lowerBound), yEnd: .value("p", v))
                            .foregroundStyle(LinearGradient(colors: [tone.opacity(0.32), tone.opacity(0)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("i", i), y: .value("p", v)).foregroundStyle(Brand.paper.opacity(0.9))
                            .lineStyle(StrokeStyle(lineWidth: 1.3))
                    }
                    if let last = points.last {
                        PointMark(x: .value("i", points.count - 1), y: .value("p", last)).foregroundStyle(tone).symbolSize(28)
                    }
                }
            }
            .chartYScale(domain: range, type: log ? .log : .linear)
            .chartXAxis(.hidden)
            .chartYAxis { AxisMarks(values: .automatic(desiredCount: 3)) { _ in AxisGridLine().foregroundStyle(Brand.fg.opacity(0.08)) } }
            .chartLegend(.hidden)
            if let label { Text(label).font(Typo.mono(9)).foregroundStyle(Brand.mute).padding(4) }
        }
    }
}
