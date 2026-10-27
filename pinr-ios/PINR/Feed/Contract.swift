import Foundation

/// The feed server's answer to `/api/contract`: which data contract it speaks, and the four
/// labels that always mean "no score" (pinr-live/contract/DATA-CONTRACT.md).
struct ContractInfo: Decodable, Equatable {
    let contract: String
    let noScoreLabels: [String]
}

enum Contract {
    /// The major contract version this app understands. The site refuses any other major
    /// version and says "Mismatch"; so does the app.
    static let supportedMajor = "1"

    /// The labels the contract names. If the feed names a different set, the app and the
    /// feed disagree on what "no score" means, and that is a mismatch too.
    static let expectedNoScoreLabels: Set<String> = ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"]

    /// True when the app can show this feed's data.
    static func accepts(_ info: ContractInfo) -> Bool {
        acceptsVersion(info.contract) && Set(info.noScoreLabels) == expectedNoScoreLabels
    }

    /// True when a version string's major part is the one this app understands
    /// (every `/api/tokens` answer carries it too).
    static func acceptsVersion(_ version: String) -> Bool {
        version.split(separator: ".", omittingEmptySubsequences: false).first.map(String.init) == supportedMajor
    }
}
