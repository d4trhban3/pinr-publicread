import SwiftUI

/// "Not investment advice" beside a score, as on the site (ui/scorenotice.ts ADVICE_LINE): tiles wide enough to carry
/// it, Discover's score block, DeepScan's score section. Only where the coin has a number. Public copy: change it only by
/// a decision, and on the site first.
enum Advice {
    static let line = "Not investment advice"
    /// The site shows it on tiles from 145 px wide; narrower tiles carry it one tap away (Discover, DeepScan).
    static let minTileWidth: CGFloat = 145

    static func shows(_ t: Token) -> Bool { t.label == nil && t.score != nil }
}
