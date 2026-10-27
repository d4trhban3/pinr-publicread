import Testing
@testable import PINR

@Suite("Ad corners: PINR's own placeholders")
struct AdCornerTests {
    @Test("All 16 slots are numbered PINR placeholders, as on the site, and none names a brand")
    func placeholders() {
        let corners: [(Room, String)] = [(.adNW, "A"), (.adNE, "B"), (.adSW, "C"), (.adSE, "D")]
        for (room, letter) in corners {
            let slots = AdRoom.areas[room] ?? []
            #expect(slots.map(\.0) == (1...4).map { "Ad space \(letter)\($0)" })
            #expect(slots.map(\.1) == ["Wide placeholder", "Square placeholder", "Square placeholder", "Wide placeholder"])
        }
        let words = AdRoom.areas.values.flatMap { $0.flatMap { [$0.0, $0.1] } }.joined(separator: " ").lowercased()
        for brand in ["solana", "base", "bnb", "alchemy", "dexscreener", "jupiter", "phantom", "uniswap", "insightx",
                      "bubblemaps", "rugcheck", "goplus", "pump", "clanker", "four.meme", "farcaster"] {
            #expect(!words.contains(brand), "\(brand)")
        }
    }
}
