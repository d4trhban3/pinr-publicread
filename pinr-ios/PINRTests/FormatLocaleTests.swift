import Foundation
import Testing
@testable import PINR

@Suite("Counts read the same on every phone")
struct FormatLocaleTests {
    @Test("A count is en-US whatever the phone's language: 1,240 and 12.4K, never 1.240")
    func countShort() {
        #expect(Format.countShort(1240) == "1,240" && Format.countShort(12_400) == "12.4K" && Format.countShort(1_200_000) == "1.2M")
    }
}
