import Foundation
import Observation
import SwiftUI

/// The wallet rules, as the site's (pinr-live/src/world/wallet.ts). THE PROMISE: the app only ever learns a PUBLIC
/// address, typed, pasted or scanned. Nothing here connects to a wallet, signs, sends, approves or switches network,
/// and `scripts/check.sh` fails the build if a signing or sending call appears.
enum WalletRules {
    enum Chain: String, Codable, Sendable { case evm, solana }

    /// The site's "View-only" card, word for word.
    static let viewOnlyTitle = "View-only"
    static let viewOnlyPoints = [
        "You paste a public wallet address and PINR shows what it holds. That is public blockchain data, the same thing anyone can see on a block explorer.",
        "PINR does not connect to your wallet. It never asks for a signature, a seed phrase or a private key. If anything asks you for them, it is not PINR: stop.",
        "The address is remembered on this device only. You can clear it at any time.",
    ]
    /// The short form shown over an address (ui/wallet.ts).
    static let viewOnlyShort = "PINR only looks up this public address. It does not connect to your wallet."

    static func chain(of s: String) -> Chain? {
        if s.wholeMatch(of: /0x[0-9a-fA-F]{40}/) != nil { return .evm }
        if s.wholeMatch(of: /[1-9A-HJ-NP-Za-km-z]{32,44}/) != nil { return .solana }
        return nil
    }

    /// An address in its one proper form (EVM lower-case, Solana as given), or nil when it is not an address.
    /// A scanned code may carry a scheme ("solana:…", "ethereum:…") or a query after the address: those are dropped.
    static func clean(_ raw: String) -> (address: String, chain: Chain)? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for scheme in ["solana:", "ethereum:"] where s.lowercased().hasPrefix(scheme) { s = String(s.dropFirst(scheme.count)) }
        if let q = s.firstIndex(where: { $0 == "?" || $0 == "@" }) { s = String(s[..<q]) }
        guard let c = chain(of: s) else { return nil }
        return (c == .evm ? s.lowercased() : s, c)
    }

    /// "0x1a2b…9f0e" / "7xKX…Nq4P".
    static func short(_ a: String) -> String { a.count > 13 ? "\(a.prefix(6))…\(a.suffix(4))" : a }

    /// The site's avatar: three hues from the address (FNV-1a), the same on every device.
    static func avatarHues(_ address: String) -> (Double, Double, Double) {
        var h: UInt32 = 2_166_136_261
        for u in address.lowercased().utf16 { h ^= UInt32(u); h = h &* 16_777_619 }
        let hue = Double(h % 360)
        return (hue, (hue + 70).truncatingRemainder(dividingBy: 360), (hue + 200).truncatingRemainder(dividingBy: 360))
    }
}

/// `/api/wallet?address=` (server/wallet.ts): the tracked tokens an address holds, from public balances.
struct WalletView: Decodable, Equatable, Sendable {
    struct Holding: Decodable, Equatable, Sendable, Identifiable {
        let address: String
        let chain: String
        let name: String?
        let ticker: String?
        let balance: Double
        /// balance × price, or nil when there is no price (left out of the total)
        let usd: Double?
        let score: Int?
        let noScoreLabel: String?
        var id: String { "\(chain)-\(address)" }
    }
    /// ok: every chain answered; partial: some did not; error: none could be read
    let status: String
    let holdings: [Holding]
    let totalUsd: Double?
    let unavailable: [String]

    private enum K: String, CodingKey { case status, holdings, totalUsd, unavailable }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        status = (try? c.decode(String.self, forKey: .status)) ?? "error"
        holdings = ((try? c.decode([Lenient<Holding>].self, forKey: .holdings)) ?? []).compactMap(\.value)
            .filter { $0.balance.isFinite && $0.balance >= 0 && !$0.address.isEmpty }
            .map { h in
                // A label always wins; a score is a whole 1 to 99 or none (the contract's rules, as everywhere else).
                Holding(address: h.address, chain: h.chain, name: h.name, ticker: h.ticker, balance: h.balance,
                        usd: h.usd.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil },
                        score: h.noScoreLabel != nil ? nil : h.score.flatMap { (1...99).contains($0) ? $0 : nil }, noScoreLabel: h.noScoreLabel)
            }
        totalUsd = (try? c.decodeIfPresent(Double.self, forKey: .totalUsd)).flatMap { $0 }.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        unavailable = (try? c.decode([String].self, forKey: .unavailable)) ?? []
    }

    init(status: String, holdings: [Holding], totalUsd: Double?, unavailable: [String]) {
        self.status = status; self.holdings = holdings; self.totalUsd = totalUsd; self.unavailable = unavailable
    }
}

/// The profile kept on this device: an address and that it is only being viewed. Never a key, never a signature.
@MainActor
@Observable
final class WalletStore {
    enum Reading: Equatable { case idle, loading, loaded(WalletView), failed }

    private(set) var address: String?
    private(set) var chain: WalletRules.Chain?
    private(set) var reading: Reading = .idle
    private let defaults: UserDefaults
    private var task: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let saved = defaults.string(forKey: "pinr.wallet"), let c = WalletRules.clean(saved) { address = c.address; chain = c.chain }
    }

    /// Views an address; returns the site's message when it is not one.
    func view(_ raw: String) -> String? {
        guard let c = WalletRules.clean(raw) else { return "That is not a wallet address. Check it and try again." }
        address = c.address; chain = c.chain; reading = .idle
        defaults.set(c.address, forKey: "pinr.wallet")
        return nil
    }

    func clear() {
        task?.cancel()
        address = nil; chain = nil; reading = .idle
        defaults.removeObject(forKey: "pinr.wallet")
    }

    /// Reads the holdings now and then every 30 seconds while the room is open; a failed read retries shortly.
    func watch(_ base: URL?, session: URLSession = .shared) async {
        while !Task.isCancelled, let address {
            if reading == .idle || reading == .failed { reading = .loading }
            reading = await Self.read(base, address, session).map(Reading.loaded) ?? .failed
            try? await Task.sleep(for: .seconds(reading == .failed ? 8 : 30))
        }
    }

    nonisolated static func read(_ base: URL?, _ address: String, _ session: URLSession) async -> WalletView? {
        guard let base else { return nil }
        var url = base.appending(path: "api/wallet")
        url.append(queryItems: [URLQueryItem(name: "address", value: address)])
        var r = URLRequest(url: url); r.timeoutInterval = 25; r.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, resp) = try? await session.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(WalletView.self, from: data)
    }
}
