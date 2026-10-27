import Foundation
import Observation

/// The terminal's watchlist (the star) and price alerts (the bell), kept on this device only, as on the site
/// (pinr-live/src/world/watchlist.ts). A coin is known by its address. Alerts are checked while PINR is open.
struct PriceAlert: Codable, Equatable, Identifiable, Sendable {
    let id: String
    /// The coin's address.
    let key: String
    let ticker: String
    /// The price to watch for, in USD.
    let level: Double
    /// "up": when the price rises to the level or above; "down": when it falls to it or below.
    let dir: String
    let created: Double
}

enum Watch {
    static let maxWatch = 100
    static let maxAlerts = 50

    /// Which way an alert at `level` points from the price now; nil when it cannot be said or the price is already there.
    static func alertDir(level: Double, current: Double?) -> String? {
        guard level.isFinite, level > 0, let c = current, c.isFinite, c > 0, level != c else { return nil }
        return level > c ? "up" : "down"
    }

    static func toggle(_ list: [String], _ key: String) -> [String] {
        guard !key.isEmpty else { return list }
        return list.contains(key) ? list.filter { $0 != key } : Array(([key] + list).prefix(maxWatch))
    }

    static func add(_ alerts: [PriceAlert], _ a: PriceAlert) -> [PriceAlert] {
        Array(([a] + alerts.filter { !($0.key == a.key && $0.level == a.level && $0.dir == a.dir) }).prefix(maxAlerts))
    }

    /// Every alert against the prices now; a coin with no price fires nothing (a missing price is never a move).
    static func check(_ alerts: [PriceAlert], price: (String) -> Double?) -> (fired: [PriceAlert], waiting: [PriceAlert]) {
        var fired: [PriceAlert] = [], waiting: [PriceAlert] = []
        for a in alerts {
            let p = price(a.key)
            let hit = p.map { $0.isFinite && $0 > 0 && (a.dir == "up" ? $0 >= a.level : $0 <= a.level) } ?? false
            if hit { fired.append(a) } else { waiting.append(a) }
        }
        return (fired, waiting)
    }

    /// "Alert: $STREAM rose to $0.002000 (+1 more)" (the site's toast).
    static func toast(_ fired: [PriceAlert]) -> String? {
        guard let a = fired.first else { return nil }
        return "Alert: \(a.ticker) \(a.dir == "up" ? "rose to" : "fell to") \(Format.price(a.level))" + (fired.count > 1 ? " (+\(fired.count - 1) more)" : "")
    }
}

@MainActor
@Observable
final class WatchStore {
    private(set) var watch: [String]
    private(set) var alerts: [PriceAlert]
    /// The newest alert that fired, shown for ten seconds.
    private(set) var toast: String?
    private var toastUntil = Date.distantPast
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        watch = (defaults.stringArray(forKey: "pinr.watchlist") ?? []).filter { !$0.isEmpty }
        alerts = (defaults.data(forKey: "pinr.alerts").flatMap { try? JSONDecoder().decode([PriceAlert].self, from: $0) } ?? [])
            .filter { $0.level.isFinite && $0.level > 0 && ($0.dir == "up" || $0.dir == "down") }
    }

    func isWatched(_ address: String) -> Bool { watch.contains(address) }

    func toggle(_ address: String) {
        watch = Watch.toggle(watch, address)
        defaults.set(watch, forKey: "pinr.watchlist")
    }

    /// Adds an alert; returns the site's message when it cannot be set.
    func addAlert(for t: Token, level: Double) -> String? {
        guard t.priceUsd != nil else { return "No price yet for this token, so an alert cannot be set." }
        guard let dir = Watch.alertDir(level: level, current: t.priceUsd) else { return "Enter a price different from the current one." }
        let a = PriceAlert(id: "a\(UUID().uuidString.prefix(8))", key: t.address, ticker: t.ticker == nil ? Format.title(t) : Format.ticker(t), level: level, dir: dir,
                           created: Date().timeIntervalSince1970 * 1000)
        alerts = Watch.add(alerts, a)
        save()
        return nil
    }

    func remove(_ a: PriceAlert) { alerts.removeAll { $0.id == a.id }; save() }

    /// Called with each new reading of the feed.
    func check(_ tokens: [Token]) {
        if Date() > toastUntil { toast = nil }
        guard !alerts.isEmpty else { return }
        let prices = Dictionary(tokens.map { ($0.address, $0.priceUsd) }, uniquingKeysWith: { a, _ in a })
        let (fired, waiting) = Watch.check(alerts, price: { prices[$0] ?? nil })
        guard !fired.isEmpty else { return }
        alerts = waiting
        save()
        toast = Watch.toast(fired)
        toastUntil = Date().addingTimeInterval(10)
    }

    private func save() { defaults.set(try? JSONEncoder().encode(alerts), forKey: "pinr.alerts") }
}
