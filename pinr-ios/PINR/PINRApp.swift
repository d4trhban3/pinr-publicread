import SwiftUI

@main
struct PINRApp: App {
    @State private var feed = FeedLink()
    @State private var store = FeedStore()
    @State private var camera = Camera()
    @State private var look = Look()
    @State private var prefs = PinrPrefs()
    @State private var selection = CoinSelection()
    @State private var watch = WatchStore()
    @State private var wallet = WalletStore()
    @State private var moderation = ModerationStore()
    @Environment(\.colorScheme) private var system

    var body: some Scene {
        WindowGroup {
            WorldShell()
                .environment(feed)
                .environment(store)
                .environment(camera)
                .environment(look)
                .environment(prefs)
                .environment(selection)
                .environment(watch)
                .environment(wallet)
                .environment(moderation)
                .onChange(of: store.all) { watch.check(store.all) }
                .task { await feed.watch() }
                // A link to one coin (`pinr://coin/<address>`, or the site's `?coin=<address>`) opens that coin's page.
                .onOpenURL { url in
                    guard let address = CoinAddress.parse(url) else { return }
                    Task { if let t = await store.find(address) { selection.id = t.id; camera.go(.terminal) } }
                }
                .task { await store.run() }
                .preferredColorScheme(look.choice)
                .tint(Brand.lime)
                #if DEBUG
                // Test builds only: launched with -PINRLandscape, the app turns to landscape (for the layout pass).
                .task {
                    guard UserDefaults.standard.bool(forKey: "PINRLandscape"),
                          let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
                }
                #endif
        }
    }
}
