import SwiftUI

/// The PINR room (north on the map): the top of the chosen filter's ranking as tiles, 4 across on a phone, over
/// the live background. The ranking is taken when a filter is chosen, on pull to refresh, and again every 10 seconds
/// while the feed has changed, so a coin the stream brings joins the page as it does on the site; the
/// filter lives behind the header's funnel; each tile's own figures stay live.
struct PinrRoom: View {
    let insets: RoomInsets
    @Environment(FeedStore.self) private var store
    @Environment(PinrPrefs.self) private var prefs
    @Environment(CoinSelection.self) private var selection
    @Environment(ModerationStore.self) private var moderation
    @Environment(Camera.self) private var camera
    @State private var order: [String] = []
    @State private var lastKnown: [String: Token] = [:]
    @State private var rankedWholeSet = false
    @State private var rerankCount = 0

    var body: some View {
        GeometryReader { geo in
            let gap: CGFloat = 10
            // Turned to landscape, twice as many across, so a tile keeps about its upright size.
            let perRow = geo.size.width > geo.size.height ? prefs.perRow * 2 : prefs.perRow
            let cols = CGFloat(perRow)
            let w = floor((geo.size.width - 20 - gap * (cols - 1)) / cols)
            ScrollView {
                VStack(spacing: 0) {
                    content(tileWidth: w, gap: gap, perRow: perRow)
                }
                .padding(.horizontal, 10)
                .padding(.top, insets.top)
                .padding(.bottom, insets.bottom)
            }
            .scrollIndicators(.hidden)
            .refreshable { rerank() }
        }
        .onChange(of: prefs.filter) { rerank() }
        .onChange(of: prefs.roster) { rerank() }
        .onChange(of: moderation.hidden) { rerank() }
        .onChange(of: moderation.filterNames) { rerank() }
        .onChange(of: store.all.isEmpty) { if order.isEmpty { rerank() } }
        .onChange(of: wholeSetRead) { if wholeSetRead && !rankedWholeSet { rankedWholeSet = true; rerank() } }
        .onAppear { if order.isEmpty { rerank() } }
        .task {
            // the design's purpose is to watch coins arrive: take the ranking again when the feed has changed since the last one.
            var ranked: Date?
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if let heard = store.lastHeard, heard != ranked {
                    ranked = heard
                    rerank()
                }
            }
        }
    }

    @ViewBuilder private func content(tileWidth w: CGFloat, gap: CGFloat, perRow: Int) -> some View {
        let tiles = current
        if case .mismatch = store.state {
            Notice(text: "The feed speaks a different data contract than this app. Results are not shown until the two agree.")
        } else if tiles.isEmpty {
            if store.all.isEmpty { ProgressView().tint(Brand.lime).padding(.top, 120) } else { Notice(text: emptyText) }
        } else {
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(w), spacing: gap), count: perRow), spacing: gap + 2) {
                ForEach(tiles) { t in
                    // As on the site, a tile opens its coin in PINRterminal + DeepScan.
                    Button { selection.id = t.id; camera.go(.terminal) } label: { TileView(token: t, width: w) }
                        .buttonStyle(PressScale())
                        .contextMenu { HideButton(token: t) }
                }
            }
        }
    }

    private var wholeSetRead: Bool { store.restTotal.map { store.restLoaded >= $0 } ?? false }

    private var current: [Token] {
        order.compactMap { store.byId[$0] ?? lastKnown[$0] }
    }

    private var emptyText: String {
        switch prefs.filter {
        case .new: "No coins under an hour old right now."
        case .movers: "No score has moved since the app opened."
        case .pinrindex: "No scored coins yet."
        case .trending: "Nothing to show yet."
        }
    }

    /// Takes the ranking again. The ranking of the whole set (42 to 57 ms for 44,000 coins) runs away from the main thread
    /// ; a newer call makes an older one's answer be dropped.
    private func rerank() {
        rerankCount += 1
        let mine = rerankCount
        let tokens = moderation.visible(store.all)
        let filter = prefs.filter, moved = store.moved, limit = prefs.roster
        Task {
            let ranked = await Task.detached(priority: .userInitiated) {
                Ranking.rankFeatured(filter, tokens.filter(\.hasSomethingToShow), moved: moved, limit: limit)
            }.value
            guard mine == rerankCount else { return }
            order = ranked.map(\.id)
            lastKnown = Dictionary(ranked.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }
}

struct Notice: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typo.sans(13))
            .foregroundStyle(Brand.paper.opacity(0.75))
            .multilineTextAlignment(.center)
            .padding(.top, 60)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
    }
}
