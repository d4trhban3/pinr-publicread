import Foundation
import Testing
@testable import PINR

/// The evidence hub on the coin page: the wire reading and the site's words (world/orbit.ts).
@Suite("Evidence hub")
struct EvidenceTests {
    static let now = Date(timeIntervalSince1970: 2_000_000_000)
    static let ms = now.timeIntervalSince1970 * 1000

    static let json = """
    {"evidence":{"contract":"evidence/1","asOfMs":\(ms),
     "rows":[
       {"from":{"kind":"coin","id":"MintMintMintMint1111"},"to":{"kind":"wallet","id":"CreatorCreator2222"},"what":"created by","value":null,"unit":null,"atMs":\(ms - 600_000),"firstReadMs":null,"readMs":\(ms - 300_000),"source":"Pump.fun","link":"https://pump.fun/coin/x","onchain":false},
       {"from":{"kind":"wallet","id":"HolderHolder3333"},"to":{"kind":"coin","id":"MintMintMintMint1111"},"what":"holds","value":{"amount":1500000,"dev":true,"sniper":false},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":"Solana chain","link":"http://insecure.example/x","onchain":true},
       {"from":{"kind":"a","id":"b"},"to":{"kind":"c","id":"d"},"what":"something new","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":false},
       {"bad":true}
     ],
     "gate":{"status":"held","words":["Another coin with the same name and ticker launched earlier."],
       "items":[{"kind":"earlier_lookalike","words":"Another coin with the same name and ticker launched earlier.","same":"name and ticker","coin":"EarlierEarlier4444","launchedAtMs":\(ms - 180_000),"link":"https://pump.fun/coin/e","creator":"OtherOther5555","creatorLink":"https://solscan.io/account/o"}],
       "creator":{"id":"CreatorCreator2222","link":"https://solscan.io/account/c","launchCount":9,"otherCoins":[{"coin":"SecondSecond6666","launchedAtMs":\(ms - 86_400_000),"link":"https://pump.fun/coin/s"}]},
       "launchedAtMs":\(ms),"source":"Jupiter","readMs":\(ms - 60_000)},
     "pinrai":{"status":"read","readMs":\(ms - 120_000),"model":null,"dropped":2,"pending":null,
       "items":[{"kind":"x","words":"The coin lists an X account that belongs to another project.","reviewed":false,
                 "receipts":[{"source":"X","value":"@other","link":"https://x.com/other","asOfMs":\(ms - 3_600_000),"onchain":false}]}]}}}
    """

    private func hub() throws -> EvidenceHub {
        try #require(JSONDecoder().decode(WireEvidence.self, from: Data(Self.json.utf8)).hub)
    }

    @Test("A bad row is dropped alone; an insecure link is not kept")
    func reading() throws {
        let h = try hub()
        #expect(h.rows.count == 3)
        #expect(h.rows[0].link?.absoluteString == "https://pump.fun/coin/x")
        #expect(h.rows[1].link == nil && h.rows[1].onchain)
    }

    @Test("A small real amount is never 0 (site e1d7d0dd)")
    func smallAmountsWritten() {
        #expect(EvidenceWords.amount(0.001) == "0.001" && EvidenceWords.amount(0.00099895) == "0.000999")
        #expect(EvidenceWords.amount(0.0000001) == "0.0000001" && EvidenceWords.amount(2.5) == "2.5" && EvidenceWords.amount(0) == "0")
    }

    @Test("`evidence: null` is no hub")
    func none() throws {
        #expect(try JSONDecoder().decode(WireEvidence.self, from: Data(#"{"evidence":null}"#.utf8)).hub == nil)
    }

    @Test("Rows fall into the site's six groups in its words; an unknown row shows under Links")
    func groups() throws {
        let g = EvidenceWords.orbitGroups(try hub(), now: Self.now)
        #expect(g.map(\.label) == ["Creator", "Funders", "Holders", "Pool", "Socials", "Links"])
        #expect(g[0].facts.first?.text == "Created by Creato…2222")
        #expect(g[0].facts.first?.readText == "read 5 min ago" && g[0].facts.first?.happenedText == "happened 10 min ago")
        #expect(g[2].facts.first?.text == "Holder…3333 holds 1.50M of it · the source marks it: dev")
        #expect(g[4].facts.isEmpty && g[4].empty.hasSuffix("not checked yet."))
        #expect(g[5].facts.first?.text == "something new")
    }

    @Test("The gate: the headline, how much earlier the look-alike launched, and the links")
    func gate() throws {
        let v = try #require(EvidenceWords.gateView(try hub().gate, now: Self.now))
        #expect(v.headline == "Observed at launch:")
        #expect(v.lines.count == 1 && v.lines[0].when == "launched 3 min earlier")
        #expect(v.lines[0].links.map(\.label) == ["see the earlier coin Earl…4444", "its creator Othe…5555"])
        #expect(v.others.first?.label == "Seco…6666" && v.others.first?.when == "launched 1 day ago")
        #expect(v.readText == "read 1 min ago · Jupiter")
        #expect(EvidenceWords.gateView(nil, now: Self.now) == nil)
    }

    @Test("The gate with nothing found, and not read yet")
    func gateEmpty() {
        let none = EvidenceHub.Gate(status: "passed", words: ["Nothing matching was found at launch."], items: [], creatorLink: nil, otherCoins: [], launchedAtMs: nil, source: nil, readMs: nil)
        #expect(EvidenceWords.gateView(none, now: Self.now)?.headline == "Nothing matching was found at launch.")
        let unread = EvidenceHub.Gate(status: "not read yet", words: [], items: [], creatorLink: nil, otherCoins: [], launchedAtMs: nil, source: nil, readMs: nil)
        #expect(EvidenceWords.gateView(unread, now: Self.now)?.headline == "Not checked yet.")
    }

    @Test("PINRai: its words, receipts with ● or ○, counts; off and not read show only the headline")
    func pinrai() throws {
        let v = try #require(EvidenceWords.pinraiView(try hub().pinrai, now: Self.now))
        #expect(v.headline == "Observed in the evidence:" && v.counts == nil)
        #expect(v.lines[0].receipts[0].text == "X: @other" && !v.lines[0].receipts[0].onchain && v.lines[0].receipts[0].when == "1 h ago")
        let off = EvidenceHub.Pinrai(status: "off", readMs: nil, model: nil, items: [.init(words: "x", reviewed: true, receipts: [])], dropped: nil, pending: nil)
        let o = try #require(EvidenceWords.pinraiView(off, now: Self.now))
        #expect(o.headline == "PINRai is switched off." && o.lines.isEmpty)
    }

    @Test("Base and BNB rows land in their groups in plain words, with Zora's owners_can always shown (the site's orbit test)")
    func baseBnb() throws {
        let j = #"""
        {"evidence":{"contract":"evidence/1","asOfMs":1,"rows":[
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds","value":{"share":0.99997700085,"note":"Four.meme launchpad (its curve holds the unsold supply)"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds","value":{"share":2.29991407603e-5},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"holds (dev team)","value":{"wallets":9948.97,"share":0.87},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"count","id":"holders"},"what":"holders counted","value":1234,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"dev moves","value":{"members":1,"acquired":22999.14},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"dev team: reward admin","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"what":"bought at launch","value":{"eth":0.5,"tokens":9948.97},"unit":"ETH / tokens","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"contract","id":"launch service"},"what":"is a contract (a launch service, not a person)","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"owned by (contract owner)","value":{"can":"change the buy and sell tax rates; withdraw tokens","template":"AgentTokenV4 (verified)"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"creator rewards paid to","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"tax paid to","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"launchpad","id":"Four.meme"},"what":"launched on","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"pool","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"trades in pool (Uniswap v4)","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"locker","id":"Clanker locker"},"what":"liquidity locked","value":1,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"contract","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"liquidity held by Zora's hook","value":{"locked_share":1,"owners_can":"move it into another pool on Zora's approved list; no one can withdraw it"},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"check","id":"tax"},"what":"trading tax","value":{"buy_pct":1,"sell_pct":3},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"pool","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"trades in pool","value":{"lp_burned_share":1},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"zora","id":"basefolio"},"what":"creator's Zora profile","value":null,"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"to":{"kind":"x","id":"https://x.com/777humdrum777"},"what":"creator's linked account","value":{"username":"777humdrum777","followers":805},"unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"contract","id":"0x654be32783991bb995720b3bb1d29295dd92fe03"},"what":"copy of the template","value":"FlapTaxTokenV3 (verified, no mint/pause/blacklist)","unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"token","id":"0x811e5292e33c3f65edc2a9564ce4362290c34444"},"to":{"kind":"check","id":"GoPlus"},"what":"GoPlus security check (a lead)","value":"nothing flagged","unit":null,"atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true}
        ]}}
        """#
        let h = try #require(JSONDecoder().decode(WireEvidence.self, from: Data(j.utf8)).hub)
        let g = Dictionary(uniqueKeysWithValues: EvidenceWords.orbitGroups(h, now: Self.now).map { ($0.id, $0.facts.map(\.text)) })
        #expect(g[.holders] == ["0x654b…fe03 holds 99.99% of the supply · Four.meme launchpad (its curve holds the unsold supply)", "0x654b…fe03 holds 0.0023% of the supply", "The dev team's wallets hold 87% of it", "1,234 wallets hold this coin"])
        #expect(g[.creator] == ["The creator's tokens moved · 1 wallet, 23.0K tokens acquired", "Dev team wallet, reward admin: 0x654b…fe03", "0x654b…fe03 bought at launch · 9.9K tokens for 0.5 ETH", "0x654b…fe03 is a contract (a launch service, not a person)", "Contract owner: 0x654b…fe03 · AgentTokenV4 (verified) · the owner can: change the buy and sell tax rates; withdraw tokens", "Creator rewards go to 0x654b…fe03", "Tax goes to 0x654b…fe03"])
        #expect(g[.pool] == ["Launched on Four.meme", "Trades in the Uniswap v4 pool 0x654b…fe03", "Liquidity locked: 100% of the pool · Clanker locker", "Zora's hook holds 100% of the pool's liquidity; its owners can move it into another pool on Zora's approved list; no one can withdraw it", "Trading tax: buy 1%, sell 3%", "Trades in the pool 0x654b…fe03 · 100% of its LP tokens burned"])
        #expect(g[.socials] == ["Creator's Zora profile @basefolio", "Creator's linked account @777humdrum777 · 805 followers"])
        #expect(g[.links] == ["Contract is a copy of FlapTaxTokenV3 (verified, no mint/pause/blacklist)", "GoPlus check (a lead): nothing flagged"])
    }

    @Test("A small funding is never rounded to zero: 0.001 BNB reads 0.001, 0.0234 reads 0.023, 2.5 stays 2.5")
    func smallAmounts() throws {
        let j = #"""
        {"evidence":{"contract":"evidence/1","asOfMs":1,"rows":[
        {"from":{"kind":"wallet","id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111"},"to":{"kind":"wallet","id":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222"},"what":"funded","value":0.001,"unit":"BNB","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111"},"to":{"kind":"wallet","id":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222"},"what":"funded","value":0.000999,"unit":"ETH","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true},
        {"from":{"kind":"wallet","id":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111"},"to":{"kind":"wallet","id":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222"},"what":"funded","value":2.5,"unit":"BNB","atMs":null,"firstReadMs":null,"readMs":null,"source":null,"link":null,"onchain":true}
        ]}}
        """#
        let h = try #require(JSONDecoder().decode(WireEvidence.self, from: Data(j.utf8)).hub)
        let t = EvidenceWords.orbitGroups(h, now: Self.now)[1].facts.map(\.text)
        #expect(t == ["0xaaaa…1111 sent 0.001 BNB to 0xbbbb…2222", "0xaaaa…1111 sent 0.000999 ETH to 0xbbbb…2222", "0xaaaa…1111 sent 2.5 BNB to 0xbbbb…2222"])
    }
}
