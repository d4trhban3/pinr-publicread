import SwiftUI

/// the PvP Arena (north-east room). Each contested coin's versions side by side, ranked strictly by the last 30 minutes' volume, then
/// X presence, then the chart (the server ranks them: `/api/arena`, the engine's pvp-1 battle groups). Observed figures only: a dash is a figure no source
/// gave, never a zero; "earliest launch" is what the launch times show, not a judgement. A "+" after a figure means only the newest 500 trades are kept.
struct ArenaMember: Identifiable, Sendable, Equatable {
    let address: String
    let name: String?, ticker: String?, chain: String?, launchpad: String?
    let imageURL: URL?
    let launchedAt: Date?
    let recentTrades: Int, recentUsd: Double
    /// True when the figures are a floor: only the newest 500 trades are kept.
    let recentAtLeast: Bool
    let volume24h: Double?, change24h: Double?, valuation: Double?
    let xPosts: Int?, hasX: Bool
    let earliest: Bool
    /// False when the 30-minute figures were not read yet (the site's `recentKnown`); a missing field counts as read.
    var recentKnown = true
    var id: String { address.lowercased() }

    /// "$20.9K+ · 500+ tx" when the count is a floor, else "$1.2K · 327 tx".
    var recentText: String {
        if !recentKnown { return Format.dash }
        let plus = recentAtLeast ? "+" : ""
        // No volume read in the window is a dash, as on the site and Android (never "$0.00").
        let usd = recentUsd > 0 ? Format.usdCompact(recentUsd) + plus : Format.dash
        return "\(usd) · \(recentTrades)\(plus) tx"
    }
    var xText: String { xPosts.map { "\($0) post\($0 == 1 ? "" : "s")" } ?? (hasX ? "linked" : Format.dash) }
}

struct ArenaGroup: Identifiable, Sendable, Equatable {
    let id: String
    let title: String, ticker: String
    let members: [ArenaMember]
}

struct WireArena: Decodable, Sendable {
    let groups: [ArenaGroup]

    private struct M: Decodable {
        let address: String?, name: String?, ticker: String?, imageUrl: String?, chain: String?, launchpad: String?
        let launchedAtMs: Double?, recentTrades: Double?, recentUsd: Double?, recentAtLeast: Bool?, recentKnown: Bool?
        let volume24hUsd: Double?, xPosts: Double?, hasX: Bool?, change24hPct: Double?, valuationUsd: Double?, earliest: Bool?
    }
    private struct G: Decodable { let id: String?, title: String?, ticker: String?; let members: [Lenient<M>]? }
    private enum Key: String, CodingKey { case groups }

    init(from decoder: Decoder) throws {
        let list = (try? decoder.container(keyedBy: Key.self).decodeIfPresent([Lenient<G>].self, forKey: .groups)) ?? nil
        groups = (list ?? []).compactMap(\.value).compactMap { g in
            guard let id = g.id else { return nil }
            let members: [ArenaMember] = (g.members ?? []).compactMap(\.value).compactMap { m in
                guard let a = m.address, !a.isEmpty else { return nil }
                func fin(_ v: Double?) -> Double? { v.flatMap { $0.isFinite ? $0 : nil } }
                return ArenaMember(address: a, name: m.name.map(Invisible.strip).flatMap { $0.isEmpty ? nil : $0 }, ticker: m.ticker.map(Invisible.strip).flatMap { $0.isEmpty ? nil : $0 }, chain: m.chain, launchpad: m.launchpad,
                                   imageURL: m.imageUrl.flatMap(httpsURL), launchedAt: fin(m.launchedAtMs).map { Date(timeIntervalSince1970: $0 / 1000) },
                                   recentTrades: Int(fin(m.recentTrades) ?? 0), recentUsd: fin(m.recentUsd) ?? 0, recentAtLeast: m.recentAtLeast == true,
                                   volume24h: fin(m.volume24hUsd), change24h: fin(m.change24hPct), valuation: fin(m.valuationUsd),
                                   xPosts: fin(m.xPosts).map { Int($0) }, hasX: m.hasX == true, earliest: m.earliest == true, recentKnown: m.recentKnown != false)
            }
            return members.isEmpty ? nil : ArenaGroup(id: id, title: g.title.map(Invisible.strip) ?? Format.dash, ticker: g.ticker.map(Invisible.strip) ?? "", members: members)
        }
    }
}

struct ArenaRoom: View {
    let insets: RoomInsets
    @Environment(FeedStore.self) private var store
    @Environment(Camera.self) private var camera
    @Environment(CoinSelection.self) private var selection
    @State private var groups: [ArenaGroup]?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("PvP Arena").font(Typo.sans(30, .bold)).foregroundStyle(Brand.paper)
                Text("Every version of a contested coin, side by side. Ranked by the last 30 minutes' volume, then X, then the chart. Observed figures, not a verdict.")
                    .font(Typo.sans(13)).foregroundStyle(Brand.mute).lineSpacing(3)
                if let groups {
                    if groups.isEmpty { Text("No contested coins right now.").font(Typo.sans(14)).foregroundStyle(Brand.mute).padding(.top, 20) }
                    ForEach(groups) { g in group(g) }
                } else {
                    Text(failed ? "The Arena is not read yet. PINR asks again shortly." : "Loading…").font(Typo.sans(14)).foregroundStyle(Brand.mute).padding(.top, 20)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, insets.top).padding(.bottom, insets.bottom)
        }
        .scrollIndicators(.hidden)
        .refreshable { await load() }
        .task {
            while !Task.isCancelled { await load(); try? await Task.sleep(for: .seconds(20)) }
        }
    }

    private func group(_ g: ArenaGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: g.title).font(Typo.sans(17, .semibold)).foregroundStyle(Brand.paper).lineLimit(1)
                Text(verbatim: g.ticker).font(Typo.mono(12)).foregroundStyle(Brand.mute).lineLimit(1)
            }
            ForEach(Array(g.members.enumerated()), id: \.element.id) { i, m in member(m, rank: i + 1) }
        }
    }

    private func member(_ m: ArenaMember, rank: Int) -> some View {
        Button { open(m) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text("\(rank).").font(Typo.mono(12, .bold)).foregroundStyle(rank == 1 ? Brand.lime : Brand.mute)
                    Text(verbatim: m.name ?? PoolWords.shortAddress(m.address)).font(Typo.sans(14, .semibold)).foregroundStyle(Brand.paper).lineLimit(1)
                    Text(verbatim: m.ticker ?? "").font(Typo.mono(11)).foregroundStyle(Brand.mute).lineLimit(1)
                    Spacer(minLength: 0)
                    if m.earliest { Text("earliest launch").font(Typo.mono(10, .medium)).foregroundStyle(Brand.lime).padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().strokeBorder(Brand.lime.opacity(0.6))) }
                }
                Text(verbatim: [m.launchpad ?? m.chain.map(ChainName.of), m.launchedAt.map { Format.ago($0).replacingOccurrences(of: " ago", with: "") + " old" }].compactMap { $0 }.joined(separator: " · "))
                    .font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
                HStack(spacing: 14) {
                    fig("30 min", m.recentText, hot: true)
                    fig("24h vol", Format.usdCompact(m.volume24h))
                    fig("X", m.xText)
                }
                HStack(spacing: 14) {
                    fig("24h", m.change24h.map { String(format: "%+.1f%%", $0) } ?? Format.dash)
                    fig("MC", Format.usdCompact(m.valuation))
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glass(14)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(m.name ?? PoolWords.shortAddress(m.address))")
    }

    private func fig(_ label: String, _ value: String, hot: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(Typo.mono(9.5)).foregroundStyle(Brand.mute)
            Text(verbatim: value).font(Typo.mono(11.5, .medium)).foregroundStyle(hot ? Brand.lime : Brand.paper).lineLimit(1).minimumScaleFactor(0.7)
        }
    }

    private func open(_ m: ArenaMember) {
        Task {
            guard let t = await store.find(m.address) else { return }
            selection.id = t.id; camera.go(.terminal)
        }
    }

    private func load() async {
        guard let base = store.baseURL else { return }
        do {
            var request = URLRequest(url: base.appending(path: "api/arena"))
            request.cachePolicy = .reloadIgnoringLocalCacheData; request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            groups = try JSONDecoder().decode(WireArena.self, from: data).groups; failed = false
        } catch { failed = groups == nil }
    }
}
