import Foundation

/// A chain's name as the page shows it ("Base", "BNB Chain", "Solana"), never the feed's raw id ("base", "bsc"); the site's
/// pinr-live/src/world/chainname.ts. An id not known here is shown as it came.
enum ChainName {
    static func of(_ id: String) -> String {
        switch id.trimmingCharacters(in: .whitespaces).lowercased() {
        case "solana": "Solana"
        case "base": "Base"
        case "bsc", "bnb": "BNB Chain"
        case "ethereum", "eth": "Ethereum"
        default: id
        }
    }
}
