import Foundation
import Testing
@testable import PINR

/// the design's choices code, against the two samples and the refusals in `pinr-live/EXPORT-CODE-FORMAT.md`
/// (shared with the site), so a code made on the site imports on the phone and the other way round.
@Suite("Choices code, the format shared with the site")
struct ChoicesCodeTests {
    static let sampleA = "PINR1.eyJ2IjoxLCJ3IjpbIjB4MjJhZjMzZmU0OWZkMWZhODBjNzE0OTc3M2RkZTU4OTBkM2M3NmYzYiJdLCJoIjpbIjNrem1oZGd1ZThrcWxrZzdxNDVxanM4Y3ptZDd1dWhmd2Rla24yNGpwdW1wIiwiajdmMmJwZjlzYmRzcHo4am1objl4dnJ4dG96aG5nZXFhZHJ2YnJkcHVtcCJdLCJmIjpmYWxzZX0"
    static let sampleB = "PINR1.eyJ2IjoxLCJ3IjpbIjNpZFlOcVhFNGZBSkpOVUh1akdUYlFOSEN6aEg1Mkh3WnlHb1hCSjJiem5XIiwiMHgyMmFmMzNmZTQ5ZmQxZmE4MGM3MTQ5NzczZGRlNTg5MGQzYzc2ZjNiIl0sImgiOltdLCJmIjp0cnVlLCJ4IjoiYSBrZXkgYSByZWFkZXIgZG9lcyBub3Qga25vdyJ9"
    static let evm = "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b"
    static let coins = ["3kzmhdgue8kqlkg7q45qjs8czmd7uuhfwdekn24jpump", "j7f2bpf9sbdspz8jmhn9xvrxtozhngeqadrvbrdpump"]

    @Test("Sample A: the choices make exactly the agreed code, and the code reads back to them")
    func sampleA() {
        // Hidden coins are written sorted and lower-case, whatever order or case they are kept in.
        #expect(ChoicesCode.make(wallets: [Self.evm], hidden: [Self.coins[1], Self.coins[0].uppercased()], filter: false) == Self.sampleA)
        #expect(ChoicesCode.read(Self.sampleA) == .success(.init(wallets: [Self.evm], hidden: Self.coins, filter: false)))
        #expect(ChoicesCode.read("  \(Self.sampleA)\n") == .success(.init(wallets: [Self.evm], hidden: Self.coins, filter: false)))
    }

    @Test("Sample B: an unknown key is ignored; the Solana wallet comes first")
    func sampleB() {
        let c = try? ChoicesCode.read(Self.sampleB).get()
        #expect(c == .init(wallets: ["3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW", Self.evm], hidden: [], filter: true))
    }

    @Test("Refusals: empty, another version's prefix, a damaged character, plain text, a list, a newer v")
    func refusals() {
        let payload = String(Self.sampleA.dropFirst("PINR1.".count))
        #expect(ChoicesCode.read("PINR1.") == .failure(.notACode))
        #expect(ChoicesCode.read("PINR2." + payload) == .failure(.notACode))
        #expect(ChoicesCode.read("PINR1." + payload.prefix(20) + "!" + payload.dropFirst(21)) == .failure(.notACode))
        #expect(ChoicesCode.read("hello") == .failure(.notACode))
        #expect(ChoicesCode.read(code(#"[1,2,3]"#)) == .failure(.notACode))
        #expect(ChoicesCode.read(code(#"{"v":2,"w":[],"h":[],"f":true}"#)) == .failure(.newer))
        #expect(ChoicesCode.read(code(#"{"w":[],"h":[],"f":true}"#)) == .failure(.notACode))
        #expect(ChoicesCode.read(code(#"{"v":true}"#)) == .failure(.notACode))
        #expect(ChoicesCode.Refusal.notACode.text == "That is not a PINR code.")
        #expect(ChoicesCode.Refusal.newer.text == "This code is from a newer PINR.")
    }

    @Test("Bad entries are dropped, not the whole code; the limits hold; a filter that is not true or false is left out")
    func dropsBadEntries() {
        let c = try? ChoicesCode.read(code(#"{"v":1,"w":["hello",7,"0xABCDEF0123456789abcdef0123456789ABCDEF01"],"h":["",null,"ABC"],"f":"yes"}"#)).get()
        #expect(c == .init(wallets: ["0xabcdef0123456789abcdef0123456789abcdef01"], hidden: ["abc"], filter: nil))
        let many = ChoicesCode.make(wallets: [], hidden: (0..<1_200).map { "coin\($0)" }, filter: true)
        #expect((try? ChoicesCode.read(many).get())?.hidden.count == 1_000)
    }

    @Test("What a code holds, in the site's words")
    func summary() {
        #expect(ChoicesCode.summary(.init(wallets: [Self.evm], hidden: Self.coins, filter: false)) == "1 wallet, 2 hidden coins, name filter off")
        #expect(ChoicesCode.summary(.init(wallets: [], hidden: ["a"], filter: nil)) == "0 wallets, 1 hidden coin, name filter unchanged")
    }

    /// A code around any JSON text, to test what a reader does with it.
    private func code(_ json: String) -> String {
        "PINR1." + Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

@Suite("Importing a choices code on this phone", .serialized)
@MainActor
struct ChoicesImportTests {
    @Test("Hidden coins are added and never un-hidden; the filter takes the code's value; the profile becomes the first wallet")
    func importRules() throws {
        let d = try #require(UserDefaults(suiteName: "pinr.test.choices.\(UUID().uuidString)"))
        let moderation = ModerationStore(defaults: d)
        let wallet = WalletStore(defaults: d)
        moderation.add(["keepme"])
        _ = wallet.view("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")

        let r = ChoicesCode.apply(try ChoicesCode.read(ChoicesCodeTests.sampleA).get(), moderation: moderation, wallet: wallet)
        #expect(r.hiddenAdded == 2 && r.walletChanged)
        #expect(moderation.hidden == Set(ChoicesCodeTests.coins + ["keepme"]))
        #expect(moderation.filterNames == false)
        #expect(wallet.address == ChoicesCodeTests.evm)

        // A code with no wallet and no filter keeps the current ones.
        let again = ChoicesCode.apply(.init(wallets: [], hidden: ChoicesCodeTests.coins, filter: nil), moderation: moderation, wallet: wallet)
        #expect(again.hiddenAdded == 0 && !again.walletChanged)
        #expect(wallet.address == ChoicesCodeTests.evm && moderation.filterNames == false)

        // This phone's own code reads back to what it holds.
        let mine = try ChoicesCode.read(ChoicesCode.current(moderation: moderation, wallet: wallet)).get()
        #expect(mine == .init(wallets: [ChoicesCodeTests.evm], hidden: moderation.hidden.sorted(), filter: false))
    }
}
