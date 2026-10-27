import Foundation

/// Coin names and tickers with the invisible characters taken out (the site's `visibletext.ts`; the team, 2026-10-25: the Arena showed "Blind Ape" with a hidden U+2060
/// inside). Out go the format characters (zero-width space, joiners and non-joiners, the word joiner, the byte order mark, direction marks and overrides, the soft
/// hyphen, invisible maths operators), the variation selectors and tags, and the characters that draw as a blank (Hangul fillers, the braille blank, a combining
/// grapheme joiner). A zero-width joiner between two emoji stays, so an emoji built from parts still draws as one, and variation selector 16 stays straight after an
/// emoji. Control characters become spaces, runs of space become one, and the ends are trimmed.
enum Invisible {
    private static let blanks: Set<UInt32> = Set([0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0]).union(0x180B...0x180F)

    /// A pictographic character (the emoji family; digits and # * are not).
    private static func isPicto(_ s: Unicode.Scalar) -> Bool { s.properties.isEmoji && s.value > 0x238C }
    private static func isVariationSelector(_ s: Unicode.Scalar) -> Bool { (0xFE00...0xFE0F).contains(s.value) }

    static func strip(_ text: String) -> String {
        let chars = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, c) in chars.enumerated() {
            if c.value == 0x200D {
                // Kept only inside an emoji sequence: an emoji before it (a variation selector between is fine), and one after it.
                var p = i - 1
                while p >= 0, isVariationSelector(chars[p]) { p -= 1 }
                if p >= 0, isPicto(chars[p]), i + 1 < chars.count, isPicto(chars[i + 1]) { out.append(c) }
                continue
            }
            if c.value == 0xFE0F, i > 0, isPicto(chars[i - 1]) { out.append(c); continue }
            if c.properties.generalCategory == .format || isVariationSelector(c) || blanks.contains(c.value)
                || (0xE0000...0xE007F).contains(c.value) || (0xE0100...0xE01EF).contains(c.value) { continue }
            out.append(c)
        }
        let spaced = String(out).unicodeScalars.map { ($0.value < 0x20 || (0x7F...0x9F).contains($0.value)) ? " " : Character($0) }
        return String(spaced).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
