import Foundation
import Testing
@testable import PINR

@Suite("Checklist 6: the Pool section reads the evidence file's pool rows")
struct PoolRowsTests {
    private let base = #"{"available":true,"facts":[],"checks":[],"read":[],"links":[],"channels":[],"pool":{"state":"none","source":null,"asOfMs":null,"events":[]},"poolRows":[{"what":"liquidity locked","value":1,"unit":"share of pool value","source":"Base chain","onchain":true,"link":null},{"what":"trades in pool (Uniswap v4)","value":null,"unit":null,"source":"Base chain","onchain":true,"link":"https://basescan.org/tx/0xabc"}]}"#

    @Test("A Base coin with pool state none still carries its two pool rows; a row with no link has none, and a bad link is dropped")
    func baseRows() throws {
        let d = try JSONDecoder().decode(WireDossier.self, from: Data(base.utf8)).dossier
        #expect(d.pool?.state == "none")
        #expect(d.poolRows.map(\.what) == ["liquidity locked", "trades in pool (Uniswap v4)"])
        #expect(d.poolRows[0].link == nil)
        #expect(d.poolRows[1].link?.host == "basescan.org")
    }

    @Test("A dossier without poolRows has none (an older feed)")
    func none() throws {
        let d = try JSONDecoder().decode(WireDossier.self, from: Data(#"{"available":true,"facts":[],"checks":[],"read":[],"links":[],"channels":[]}"#.utf8)).dossier
        #expect(d.poolRows.isEmpty)
    }
}
