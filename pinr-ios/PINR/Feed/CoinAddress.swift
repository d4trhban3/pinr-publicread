import Foundation

/// A coin's address, and the links that name one (decision D3 of the crew's changes: the site opens `pinr.io/?coin=<address>`).
enum CoinAddress {
    /// An exact Solana (base58, 32 to 44 characters) or EVM (0x and 40 hex digits) address.
    static func isAddress(_ s: String) -> Bool {
        s.range(of: #"^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$"#, options: .regularExpression) != nil
    }

    /// The address a link names, or nil: `pinr://coin/<address>`, or `https://pinr.io/?coin=<address>`. Anything else in the link is ignored.
    static func parse(_ url: URL) -> String? {
        let candidate: String?
        switch url.scheme?.lowercased() {
        case "pinr":
            candidate = url.host?.lowercased() == "coin" ? url.pathComponents.dropFirst().first : nil
        case "https":
            guard url.host?.lowercased() == "pinr.io" || url.host?.lowercased() == "www.pinr.io" else { return nil }
            candidate = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "coin" }?.value
        default:
            candidate = nil
        }
        return candidate.flatMap { isAddress($0) ? $0 : nil }
    }
}
