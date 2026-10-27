import Foundation

/// Where a list stands in the feed's change stream (`stream: {boot, seq}` on `/api/tokens`, a design decision): the
/// server's boot and the last change the list already includes.
struct StreamPosition: Decodable, Equatable, Sendable {
    let boot: String
    let seq: Int
}

/// The app's copy of the first page, kept current by `/api/stream` (the same rules as `ListCopy` in
/// pinr-live/src/world/livefeed.ts): the page is read once, then each `changes` message is applied to it.
/// A message from another boot, or one that skips a number (something was missed), asks for a fresh read.
/// Rows are kept as the feed sent them, so a message that carries only the changed fields (price, score,
/// launchpad) is merged field by field; a field the feed sends as null is taken away.
struct StreamCopy {
    private(set) var position: StreamPosition?
    /// The first page's coins, lower-cased addresses, in the order the feed sent them (new coins come last).
    private(set) var order: [String] = []
    private var rows: [String: [String: Any]] = [:]

    enum Outcome {
        /// Nothing to do (a message this copy already includes, or one that could not be read).
        case ignored
        /// The copy cannot follow: another boot, a skipped number, or the server said so. Read the lists again.
        case reset
        /// `changed` first-page coins changed (rebuild them), `gone` left it; `rest` and `restGone` are the scored set's rows.
        case applied(changed: [String], gone: [String], rest: [[String: Any]], restGone: [String], ticks: [LiveTick])
    }

    /// Takes the first page as the feed sent it (the `tokens` array) and where the list stands.
    mutating func load(rows list: [[String: Any]], position: StreamPosition?) {
        order = []
        rows = [:]
        for row in list {
            guard let address = row["address"] as? String else { continue }
            let key = address.lowercased()
            if rows[key] == nil { order.append(key) }
            rows[key] = row
        }
        self.position = position
    }

    /// Forgets the position (so nothing is applied until the lists are read again).
    mutating func clear() { position = nil }

    mutating func apply(_ data: Data) -> Outcome {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let boot = object["boot"] as? String, let seq = (object["seq"] as? NSNumber)?.intValue else { return .ignored }
        guard let position, boot == position.boot else { return .reset }
        if seq <= position.seq { return .ignored }
        if seq > position.seq + 1 { return .reset }
        func list(_ name: String) -> [[String: Any]] { (object[name] as? [[String: Any]]) ?? [] }
        func addresses(_ name: String) -> [String] { ((object[name] as? [Any]) ?? []).compactMap { ($0 as? String)?.lowercased() } }
        var changed: [String] = []
        var priced: [(String, Double)] = []
        for row in list("seen") {
            guard let address = row["address"] as? String else { continue }
            let key = address.lowercased()
            if rows[key] == nil { order.append(key) }
            rows[key] = row
            changed.append(key)
            if let p = (row["priceUsd"] as? NSNumber)?.doubleValue, p > 0, p.isFinite { priced.append((key, p)) }
        }
        for part in list("score") + list("graduation") + list("tick") {
            guard let address = part["address"] as? String else { continue }
            let key = address.lowercased()
            guard var row = rows[key] else { continue }
            for (field, value) in part { if value is NSNull { row[field] = nil } else { row[field] = value } }
            rows[key] = row
            changed.append(key)
            if let p = (part["priceUsd"] as? NSNumber)?.doubleValue, p > 0, p.isFinite { priced.append((key, p)) }
        }
        let gone = addresses("gone")
        if !gone.isEmpty {
            let goneSet = Set(gone)
            for key in gone { rows[key] = nil }
            order.removeAll { goneSet.contains($0) }
        }
        self.position = StreamPosition(boot: boot, seq: seq)
        var seen = Set<String>()
        let unique = changed.filter { rows[$0] != nil && seen.insert($0).inserted }
        // The prices this message carries for coins on the first page (a chart folds those, never a price it merely holds).
        let at = Date()
        var ticks: [LiveTick] = priced.map { LiveTick(address: $0.0, at: at, price: $0.1, usd: nil) }
        ticks += list("trades").compactMap { t -> LiveTick? in
            guard let address = t["address"] as? String, let ms = (t["atMs"] as? NSNumber)?.doubleValue,
                  let price = (t["priceUsd"] as? NSNumber)?.doubleValue, let usd = (t["usd"] as? NSNumber)?.doubleValue,
                  price > 0, price.isFinite, ms.isFinite else { return nil }
            let side = (t["side"] as? String)?.lowercased()
            return LiveTick(address: address.lowercased(), at: Date(timeIntervalSince1970: ms / 1000), price: price, usd: usd, isBuy: side == "buy" ? true : side == "sell" ? false : nil)
        }
        return .applied(changed: unique, gone: gone, rest: list("rest"), restGone: addresses("restGone"), ticks: ticks)
    }

    /// One first-page coin as a token the app can read, from its merged row.
    func wire(_ key: String) -> WireToken? { rows[key].flatMap(Self.wire) }

    static func wire(_ row: [String: Any]) -> WireToken? {
        guard JSONSerialization.isValidJSONObject(row), let data = try? JSONSerialization.data(withJSONObject: row) else { return nil }
        return try? JSONDecoder().decode(WireToken.self, from: data)
    }

    /// The raw rows of a first-page answer (`/api/tokens`), for `load`.
    static func rows(of answer: Data) -> [[String: Any]] {
        ((try? JSONSerialization.jsonObject(with: answer)) as? [String: Any])?["tokens"] as? [[String: Any]] ?? []
    }
}

/// Server-Sent Events, one line at a time (the feed sends one `data:` line per message). `event:` names the next
/// message; comment lines (`:`), `id:` and `retry:` carry nothing the app needs.
struct SSELines {
    private var event: String?

    /// The message this line completes, if it does: its event name (`message` when none was sent) and data.
    mutating func take(_ line: String) -> (event: String, data: String)? {
        if line.hasPrefix("event:") {
            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            return nil
        }
        guard line.hasPrefix("data:") else { return nil }
        defer { event = nil }
        return (event ?? "message", line.dropFirst(5).trimmingCharacters(in: .whitespaces))
    }
}
