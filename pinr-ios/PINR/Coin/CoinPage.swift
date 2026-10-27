import Charts
import SwiftUI

/// The PINRterminal + DeepScan room for one coin, in the site's look at phone width (ui/terminal.ts and
/// ui/deepscan.ts): the token bar, the timeframes, the candle chart with its price axis and last-price tag, volume,
/// the PINR Index line pane, then "DeepScan ↓" and the dossier below it. Every figure is a measured reading or a dash.
struct CoinPage: View {
    let token: Token
    let insets: RoomInsets
    let client: CoinClient
    @Environment(FeedStore.self) private var store
    @State private var dossier: Dossier?
    @State private var dossierFailed = false
    @State private var hub: EvidenceHub?
    @State private var hubLoaded = false
    @State private var tvSymbol: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    TokenBar(token: token).padding(.bottom, 10)
                    if token.label == .vamp {
                        Notice(text: "This coin is a copy (VAMP). A copy carries no data: only its label.")
                    } else {
                        TerminalChart(token: token, client: client)
                        ChartLinksRow(items: ChartLinks.links(address: token.address, chain: token.chain, launchpad: token.launchpad, tvSymbol: tvSymbol))
                    }
                    Pill(text: "DeepScan ↓") { withAnimation { proxy.scrollTo("deepscan", anchor: .top) } }
                        .frame(maxWidth: .infinity).padding(.vertical, 18).id("chart")
                    Rule()
                    VStack(alignment: .leading, spacing: 0) {
                        Pill(text: "↑ Chart") { withAnimation { proxy.scrollTo("chart", anchor: .bottom) } }
                            .frame(maxWidth: .infinity).padding(.vertical, 14)
                        DeepScanBody(token: token, dossier: dossier, failed: dossierFailed, client: client, all: store.all, hub: hub, hubLoaded: hubLoaded)
                    }
                    .id("deepscan")
                }
                .padding(.horizontal, 10)
            }
            // The header and footer are kept clear as safe areas, so "DeepScan ↓" lands the dossier just under the header.
            .safeAreaPadding(.top, insets.top)
            .safeAreaPadding(.bottom, insets.bottom)
            .scrollIndicators(.hidden)
            .refreshable { async let h: Void = loadHub(); await loadDossier(); await h }
        }
        .task(id: token.id) { dossier = nil; hub = nil; hubLoaded = false; tvSymbol = nil; async let t: Void = loadTV(); async let h: Void = loadHub(); await loadDossier(); await h; await t }
    }

    private func loadTV() async { tvSymbol = await client.tvSymbol(token.address) }

    private func loadHub() async {
        if let h = try? await client.evidence(token.address) { hub = h; hubLoaded = true } else if hub == nil { hubLoaded = true }
    }

    private func loadDossier() async {
        do { dossier = try await client.dossier(token.address); dossierFailed = false } catch { dossierFailed = dossier == nil }
    }
}

/// The site's outlined lime pill ("DeepScan ↓", "↑ Chart").
struct Pill: View {
    let text: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text).font(Typo.sans(15, .semibold)).foregroundStyle(Brand.lime)
                .padding(.horizontal, 20).frame(height: 40)
                .background(Capsule().fill(Brand.lime.opacity(0.1)))
                .overlay(Capsule().strokeBorder(Brand.lime.opacity(0.55), lineWidth: 1))
                .contentShape(Capsule())
        }
    }
}

/// A hairline between sections, as the site's.
struct Rule: View {
    var body: some View { Rectangle().fill(Brand.fg.opacity(0.1)).frame(height: 1) }
}

/// The token bar: the coin in a glass pill on the left, the price and its 24-hour move on the right.
private struct TokenBar: View {
    let token: Token
    @Environment(WatchStore.self) private var watch
    @Environment(ModerationStore.self) private var moderation
    @Environment(CoinSelection.self) private var selection
    @Environment(Camera.self) private var camera
    @State private var alerting = false

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            HStack(spacing: 8) {
                TokenPicture(token: token, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Format.title(token)).font(Typo.sans(15, .bold)).foregroundStyle(Brand.paper).lineLimit(1)
                    Text(Format.ticker(token)).font(Typo.mono(10)).foregroundStyle(Brand.mute).lineLimit(1)
                }
            }
            .padding(.leading, 8).padding(.trailing, 14).frame(height: 46)
            .background(Capsule().fill(Brand.glass))
            .overlay(Capsule().strokeBorder(Brand.fg.opacity(0.1), lineWidth: 1))
            .layoutPriority(1)
            // Long-press the coin to hide it, as on a tile; the page then goes back.
            .contextMenu {
                Button(role: .destructive) { moderation.hide(token); selection.id = nil; camera.back() } label: {
                    Label("Hide this coin", systemImage: "eye.slash")
                }
            }
            // The star keeps the coin on this device's watchlist; the bell sets a price alert (the site's token bar).
            Button { watch.toggle(token.address) } label: {
                Image(systemName: watch.isWatched(token.address) ? "star.fill" : "star").font(.system(size: 17))
                    .foregroundStyle(watch.isWatched(token.address) ? Brand.lime : Brand.paper.opacity(0.85))
                    .frame(width: 34, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel(watch.isWatched(token.address) ? "Remove from watchlist" : "Add to watchlist")
            Button { alerting = true } label: {
                Image(systemName: watch.alerts.contains { $0.key == token.address } ? "bell.fill" : "bell").font(.system(size: 17))
                    .foregroundStyle(watch.alerts.contains { $0.key == token.address } ? Brand.lime : Brand.paper.opacity(0.85))
                    .frame(width: 34, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Price alerts")
            .sheet(isPresented: $alerting) { AlertSheet(token: token).presentationDetents([.medium]).presentationBackground(Brand.panel) }
            Spacer(minLength: 4)
            if token.label != .vamp {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.price(token.priceUsd)).font(Typo.sans(24, .bold)).monospacedDigit().foregroundStyle(Brand.paper)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if let c = token.change24hPct {
                        Text("\(c >= 0 ? "▲" : "▼") \(Format.change(abs(c)).dropFirst()) 24h")
                            .font(Typo.mono(11, .medium)).foregroundStyle(c >= 0 ? Brand.lime : Brand.mandarin)
                    }
                }
            }
        }
    }
}

// MARK: - Step 5: the terminal chart

/// The site's terminal chart at phone width: timeframes and the style switch, the O/H/L/C readout of the newest
/// candle, candles (lime up, mandarin down) with the price axis on the right and a lime tag at the last price,
/// volume below, the PINR Index line pane, and the score and flag events as dashed lines.
private struct TerminalChart: View {
    let token: Token
    let client: CoinClient
    @Environment(FeedStore.self) private var store
    @State private var tradesSeen = -1
    @State private var tf: Timeframe = .m1
    @State private var candles = true
    @State private var set: CandleSet?
    @State private var failed = false
    @State private var events: [ChartEvent] = []
    @State private var metric: Metric?
    @State private var metricRead = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 2) {
                ForEach(Timeframe.allCases) { t in
                    Button { tf = t } label: {
                        Text(t.rawValue).font(Typo.sans(13, .semibold))
                            .foregroundStyle(t == tf ? Brand.onLive : Brand.paper.opacity(0.85))
                            .padding(.horizontal, 7).frame(height: 30)
                            .background(Capsule().fill(t == tf ? Brand.lime : .clear))
                            .contentShape(Capsule())
                    }
                    .accessibilityIdentifier("tf-\(t.rawValue)")
                }
                Spacer(minLength: 4)
                Button { candles.toggle() } label: {
                    Text(candles ? "Candles" : "Line").font(Typo.sans(13, .semibold)).foregroundStyle(Brand.paper)
                        .padding(.horizontal, 12).frame(height: 30)
                        .background(Capsule().fill(Brand.fg.opacity(0.08)))
                        .contentShape(Capsule())
                }
            }
            if let set, set.drawable, let k = set.shown.last {
                let move = k.open > 0 ? (k.close - k.open) / k.open * 100 : 0
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        ohlc("O", k.open); ohlc("H", k.high); ohlc("L", k.low); ohlc("C", k.close)
                        Text(Format.change(move)).foregroundStyle(move >= 0 ? Brand.lime : Brand.mandarin)
                        Text("Vol \(Format.usdCompact(k.volume))").foregroundStyle(Brand.mute)
                    }
                    .lineLimit(1).minimumScaleFactor(0.7)
                    // Figures from stale candles say when they were read, never pass as current.
                    if let a = set.asOfText { Text("Last candle \(a)").foregroundStyle(Brand.mandarin) }
                }
                .font(Typo.mono(10))
            }
            priceChart.frame(height: 300)
            if let set, set.drawable { volume(set).frame(height: 70) }
            if let set, set.status == .stale, let a = set.asOfText {
                Text("Showing the chart \(a). PINR asks again shortly.").font(Typo.mono(10)).foregroundStyle(Brand.mandarin)
            }
            metricPane.frame(height: 90)
            HStack {
                Spacer()
                if let set, set.drawable, let s = set.asOfText ?? set.source { Text("\(tf.rawValue) · \(s)").font(Typo.mono(9)).foregroundStyle(Brand.mute) }
            }
        }
        .task(id: "\(token.id)-\(tf.rawValue)") {
            await load()
            // The site's rule: while the source is busy (or the chart is stale) ask again every 8 seconds.
            while !Task.isCancelled, failed || [.busy, .error, .stale].contains(set?.status) {
                try? await Task.sleep(for: .seconds(8))
                if Task.isCancelled { break }
                await load(keep: true)
            }
        }
        // the chart moves with the stream's price and the coin's own trades between reads.
        .onChange(of: store.lastHeard) {
            guard let current = set, let next = LiveCandle.advance(current, tf, id: token.id, store: store, seen: &tradesSeen) else { return }
            set = next
        }
        .task(id: token.id) {
            events = (try? await client.events(token.address)) ?? []
            metric = try? await client.metric(token.address); metricRead = true
        }
    }

    private func ohlc(_ l: String, _ v: Double) -> some View {
        HStack(spacing: 2) { Text(l).foregroundStyle(Brand.mute); Text(Format.price(v)).foregroundStyle(Brand.lime) }
    }

    @ViewBuilder private var priceChart: some View {
        if let set, set.drawable, let range = set.range {
            let c = set.shown
            let last = c.last!.close
            Chart {
                ForEach(c, id: \.time) { k in
                    if candles {
                        RuleMark(x: .value("t", k.time), yStart: .value("l", k.low), yEnd: .value("h", k.high))
                            .foregroundStyle(k.close >= k.open ? Brand.lime : Brand.mandarin).lineStyle(StrokeStyle(lineWidth: 1))
                        RectangleMark(x: .value("t", k.time), yStart: .value("o", min(k.open, k.close)), yEnd: .value("c", max(k.open, k.close)),
                                      width: .fixed(max(1.5, 260 / Double(c.count))))
                            .foregroundStyle(k.close >= k.open ? Brand.lime : Brand.mandarin)
                    } else {
                        LineMark(x: .value("t", k.time), y: .value("c", k.close)).foregroundStyle(Brand.lime)
                    }
                }
                ForEach(events.filter { e in c.first.map { e.time >= $0.time } ?? false }) { e in
                    RuleMark(x: .value("e", e.time)).foregroundStyle(toneColor(e.tone).opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
                RuleMark(y: .value("last", last)).foregroundStyle(Brand.mandarin.opacity(0.8)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .annotation(position: .trailing, alignment: .center, spacing: 2) {
                        Text(Format.price(last).dropFirst()).font(Typo.mono(9, .semibold)).foregroundStyle(Brand.onLive)
                            .padding(.horizontal, 3).padding(.vertical, 1).background(RoundedRectangle(cornerRadius: 2).fill(Brand.lime))
                    }
            }
            // The site's terminal chart keeps a linear price axis (the log rule is the lite chart's only).
            .chartYScale(domain: range, type: .linear)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Price chart, \(tf.rawValue) candles\(set.asOfText.map { ", \($0)" } ?? ""). Last price \(Format.price(last)). High \(Format.price(c.map(\.high).max())), low \(Format.price(c.map(\.low).min())).")
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel(format: .dateTime.hour().minute()).font(Typo.mono(10)).foregroundStyle(Brand.mute) } }
            .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 8)) { v in
                AxisGridLine().foregroundStyle(Brand.fg.opacity(0.05))
                AxisValueLabel { if let d = v.as(Double.self) { Text(Format.price(d).dropFirst()).font(Typo.mono(9.5)).foregroundStyle(Brand.paper.opacity(0.8)) } } } }
            .chartPlotStyle { $0.background(Color.clear) }
        } else {
            VStack(spacing: 8) {
                Text(note).font(Typo.mono(11)).foregroundStyle(Brand.mute)
                if set?.status == .busy || failed {
                    Button("Try again") { Task { await load() } }.font(Typo.mono(11, .semibold)).foregroundStyle(Brand.lime)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func volume(_ set: CandleSet) -> some View {
        Chart(set.shown, id: \.time) { k in
            BarMark(x: .value("t", k.time), y: .value("v", k.volume), width: .fixed(max(1, 230 / Double(set.shown.count))))
                .foregroundStyle((k.close >= k.open ? Brand.lime : Brand.mandarin).opacity(0.55))
        }
        .chartXAxis(.hidden)
        .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 2)) { v in
            AxisValueLabel { if let d = v.as(Double.self) { Text(Format.usdCompact(d).dropFirst()).font(Typo.mono(9)).foregroundStyle(Brand.mute) } } } }
    }

    @ViewBuilder private var metricPane: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("PINR Index line").font(Typo.mono(11, .bold)).foregroundStyle(Brand.lime)
                if metric == nil { Text(metricRead ? "not available for this token yet" : "loading…").font(Typo.mono(11)).foregroundStyle(Brand.mute) }
                else if let m = metric, !m.timeframe.isEmpty { Text(m.timeframe).font(Typo.mono(10)).foregroundStyle(Brand.mute) }
            }
            if let m = metric {
                Chart {
                    ForEach(Array(m.histogram.enumerated()), id: \.offset) { _, p in
                        BarMark(x: .value("t", p.t), y: .value("h", p.v)).foregroundStyle((p.v >= 0 ? Brand.lime : Brand.mandarin).opacity(0.4))
                    }
                    ForEach(Array(m.series.enumerated()), id: \.offset) { _, p in
                        LineMark(x: .value("t", p.t), y: .value("v", p.v), series: .value("s", "series")).foregroundStyle(Brand.lime)
                    }
                    ForEach(Array(m.signal.enumerated()), id: \.offset) { _, p in
                        LineMark(x: .value("t", p.t), y: .value("v", p.v), series: .value("s", "signal")).foregroundStyle(Brand.lilac)
                    }
                    ForEach(m.levels, id: \.self) { l in RuleMark(y: .value("l", l)).foregroundStyle(Brand.fg.opacity(0.15)) }
                }
                .chartXAxis(.hidden)
                .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 2)) { _ in AxisValueLabel().font(Typo.mono(9)).foregroundStyle(Brand.mute) } }
            } else {
                Spacer()
            }
        }
        .padding(.top, 6)
        .overlay(alignment: .top) { Rule() }
    }

    private var note: String {
        if failed { return "Price history not read yet. PINR asks again shortly." }
        guard let set else { return "loading…" }
        switch set.status {
        case .busy: return "Chart not read yet. PINR asks again shortly."
        case .error: return "Price history not read yet. PINR asks again shortly."
        default: return "no candles for this size"
        }
    }

    /// `keep`: a quiet retry keeps what is on screen until the new answer is in.
    private func load(keep: Bool = false) async {
        if !keep { set = nil }
        do {
            let next = try await client.candles(token.address, tf)
            // A busy answer to a retry does not wipe a stale chart that is still showing its read time.
            if keep, next.status == .busy, set?.status == .stale { failed = false; return }
            set = next; failed = false
        } catch { if !keep || set?.status != .stale { failed = true } }
    }
}

func toneColor(_ tone: String) -> Color {
    tone == "good" ? Brand.lime : tone == "bad" ? Brand.mandarin : Brand.lilac
}

/// The bell's panel: the price now, a price to be alerted at, and this coin's waiting alerts (the site's alert menu).
private struct AlertSheet: View {
    let token: Token
    @Environment(WatchStore.self) private var watch
    @State private var text = ""
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Price alert · now \(Format.price(token.priceUsd).replacingOccurrences(of: Format.dash, with: "unknown"))")
                .font(Typo.sans(16, .bold)).foregroundStyle(Brand.paper)
            HStack(spacing: 8) {
                TextField("", text: $text, prompt: Text("Alert me at (USD)").foregroundStyle(Brand.mute))
                    .keyboardType(.decimalPad).font(Typo.mono(14)).foregroundStyle(Brand.paper)
                    .padding(.horizontal, 12).frame(height: 40).background(Capsule().fill(Brand.fg.opacity(0.08)))
                Button("Add alert") {
                    let level = Double(text.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")) ?? .nan
                    message = watch.addAlert(for: token, level: level)
                    if message == nil { text = "" }
                }
                .font(Typo.sans(14, .semibold)).foregroundStyle(Brand.onLive)
                .padding(.horizontal, 14).frame(height: 40).background(Capsule().fill(Brand.lime))
            }
            if let message { Text(message).font(Typo.sans(12)).foregroundStyle(Brand.mandarin) }
            ForEach(watch.alerts.filter { $0.key == token.address }) { a in
                HStack {
                    Text("\(a.dir == "up" ? "Rises to" : "Falls to") \(Format.price(a.level))").font(Typo.mono(12)).foregroundStyle(Brand.paper)
                    Spacer()
                    Button { watch.remove(a) } label: { Image(systemName: "xmark").foregroundStyle(Brand.mute) }
                        .accessibilityLabel("Remove this alert")
                }
            }
            Text("Alerts are checked while PINR is open on this device.").font(Typo.sans(11)).foregroundStyle(Brand.mute)
            Spacer()
        }
        .padding(20)
    }
}
