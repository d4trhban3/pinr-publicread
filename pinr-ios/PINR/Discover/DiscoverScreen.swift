import SwiftUI

/// The Discover room (west on the map), in the site's look: the PINR wordmark with its badge, "clean up the
/// trenches" and the blurb, the search pill, the market pulse with Refresh, the four tabs, then 30 cards. As on
/// the site the list is a snapshot: re-ranked on a tab, a search, Refresh or pull to refresh.
struct DiscoverRoom: View {
    let insets: RoomInsets
    @Environment(FeedStore.self) private var store
    @Environment(Camera.self) private var camera
    @Environment(CoinSelection.self) private var selection
    @Environment(ModerationStore.self) private var moderation
    @State private var tab: DiscoverTab = .trending
    @State private var query = ""
    @State private var order: [String] = []
    @State private var lastKnown: [String: Token] = [:]
    @State private var rankedWholeSet = false
    @State private var rankedAt = Date()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12, pinnedViews: [.sectionHeaders]) {
                hero
                Section {
                    pulse
                    content
                } header: {
                    search
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, insets.top)
            .padding(.bottom, insets.bottom)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { rerank() }
        .onChange(of: tab) { rerank(); if tab == .basebnb { Task { await store.loadChainCoins(); rerank() } } }
        .onChange(of: query) { rerank() }
        // An exact address no list holds is asked of the feed, and shown as the one result.
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard CoinAddress.isAddress(q), !store.byId.keys.contains(q.lowercased()), let t = await store.find(q) else { return }
            order = [t.id]; lastKnown[t.id] = t
        }
        .onChange(of: moderation.hidden) { rerank() }
        .onChange(of: store.all.isEmpty) { if order.isEmpty { rerank() } }
        .onChange(of: wholeSetRead) { if wholeSetRead && !rankedWholeSet { rankedWholeSet = true; rerank() } }
        .onAppear { if order.isEmpty { rerank() } }
    }

    private var hero: some View {
        VStack(spacing: 10) {
            WordmarkImage().scaledToFit().frame(width: 190)
                .overlay(alignment: .bottomTrailing) {
                    Image("pinr-chk-light").resizable().scaledToFit().frame(width: 40).offset(x: 22, y: 8)
                }
                .padding(.top, 24)
                .accessibilityLabel("PINR")
            Text("clean up the trenches").font(Typo.sans(20, .semibold)).foregroundStyle(Brand.paper)
            Text("Deep scans contract architecture, custody protocol, quote pairing synergy, launchpad reward protocols, and social media posts to help traders see what the developer did, real efforts, and strategy for the endgame.")
                .font(Typo.sans(13)).foregroundStyle(Brand.paper.opacity(0.72)).multilineTextAlignment(.center)
                .lineSpacing(3).padding(.horizontal, 8)
        }
        .padding(.bottom, 8)
    }

    /// The search pill, pinned under the header while the list scrolls, as on the site.
    private var search: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 18)).foregroundStyle(Brand.paper.opacity(0.8))
            TextField("", text: $query, prompt: Text("Ticker, name, CA, X, social, or website").foregroundStyle(Brand.mute))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(Typo.sans(15)).foregroundStyle(Brand.paper)
                .accessibilityIdentifier("discover-search")
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Brand.mute) }
                    .accessibilityLabel("Clear the search")
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
        .glass(26)
        .padding(.vertical, 6)
    }

    private var pulse: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(Brand.lime).frame(width: 7, height: 7)
                Text("TRENCHES MARKET PULSE").font(Typo.mono(11, .bold)).tracking(2.2).foregroundStyle(Brand.paper)
            }
            HStack {
                TimelineView(.periodic(from: .now, by: 5)) { _ in
                    Text("Engine feed · updated \(Format.ago(store.lastHeard ?? rankedAt))")
                        .font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
                }
                Spacer()
                Button("Refresh") { rerank() }
                    .font(Typo.mono(11, .medium)).foregroundStyle(Brand.paper)
                    .padding(.horizontal, 12).frame(height: 26)
                    .background(Capsule().fill(Brand.fg.opacity(0.07)))
            }
            if query.isEmpty {
                // The site's tabs (style.css .dtabs): four equal pills in one row, 40 high, 13-point type; a long
                // name wraps inside its pill rather than the row scrolling.
                HStack(spacing: 6) {
                    ForEach(DiscoverTab.allCases) { t in
                        Button { tab = t } label: {
                            // The site's pill has no side padding, so "Fresh Launches" stays on one line.
                            Text(t.label).font(Typo.sans(12, .medium)).multilineTextAlignment(.center)
                                .lineLimit(1).minimumScaleFactor(0.6)
                                .frame(maxWidth: .infinity).frame(height: 40)
                                .foregroundStyle(t == tab ? Brand.onLive : Brand.mute)
                                .background(Capsule().fill(t == tab ? Brand.lime : Brand.glass))
                                .overlay(Capsule().strokeBorder(t == tab ? .clear : Brand.fg.opacity(0.12), lineWidth: 1))
                                .contentShape(Capsule())
                        }
                        .accessibilityIdentifier("dtab-\(t.rawValue)")
                        .accessibilityAddTraits(t == tab ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 2)
                Text("\(tab.hint) · \(current.count)").font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
            } else {
                Text("Every coin, biggest first · \(current.count)").font(Typo.mono(10.5)).foregroundStyle(Brand.mute)
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder private var content: some View {
        let cards = current
        if case .mismatch = store.state {
            Notice(text: "The feed speaks a different data contract than this app. Results are not shown until the two agree.")
        } else if cards.isEmpty {
            if store.all.isEmpty || (tab == .basebnb && query.isEmpty && !store.chainCoinsLoaded) { ProgressView().tint(Brand.lime).padding(.top, 60) }
            else { Notice(text: query.isEmpty ? emptyText : "No coin matches “\(query)”.") }
        } else {
            let client = CoinClient(baseURL: store.baseURL, session: .shared)
            ForEach(cards) { t in
                DiscoverCard(token: t, client: client) { tok in selection.id = tok.id; camera.go(.terminal) }
                    .contextMenu { HideButton(token: t) }
            }
        }
    }

    private var wholeSetRead: Bool { store.restTotal.map { store.restLoaded >= $0 } ?? false }

    private var current: [Token] {
        let live = store.byId
        return order.compactMap { live[$0] ?? lastKnown[$0] }
    }

    private var emptyText: String {
        switch tab {
        case .fresh: "No coins under an hour old right now."
        case .pinrscore: "No scored coins yet."
        case .basebnb: "No Base or BNB Chain coins yet."
        case .movers, .trending: "Nothing to show yet."
        }
    }

    private func rerank() {
        // The Base/BNB tab reads those coins on their own, so it fills in a second or two; the rest of the sweep adds nothing it lacks.
        var pool = store.all
        if tab == .basebnb, query.isEmpty { let have = Set(pool.map(\.id)); pool += store.chainCoins.filter { !have.contains($0.id) } }
        let ranked = DiscoverRanking.rank(tab, moderation.visible(pool), query: query)
        order = ranked.map(\.id)
        lastKnown = Dictionary(ranked.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        rankedAt = Date()
    }
}
