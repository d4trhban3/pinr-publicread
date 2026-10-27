import Foundation
import Testing
@testable import PINR

@Suite("The feed's contract")
struct ContractTests {
    private func decode(_ json: String) throws -> ContractInfo {
        try JSONDecoder().decode(ContractInfo.self, from: Data(json.utf8))
    }

    @Test("The feed server's real answer is accepted")
    func acceptsTheServersAnswer() throws {
        let info = try decode(#"{"contract":"1.0","noScoreLabels":["VAMP","BOT/RUG","MAYHEM","HONEYPOT"]}"#)
        #expect(Contract.accepts(info))
    }

    @Test("A later minor version is accepted", arguments: ["1.1", "1.9", "1"])
    func acceptsMinorVersions(version: String) {
        let info = ContractInfo(contract: version, noScoreLabels: ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"])
        #expect(Contract.accepts(info))
    }

    @Test("A different major version is a mismatch", arguments: ["2.0", "0.9", "10.1", "", "v1.0"])
    func refusesOtherMajors(version: String) {
        let info = ContractInfo(contract: version, noScoreLabels: ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"])
        #expect(!Contract.accepts(info))
    }

    @Test("A different set of no-score labels is a mismatch")
    func refusesOtherLabels() {
        #expect(!Contract.accepts(ContractInfo(contract: "1.0", noScoreLabels: ["VAMP", "BOT/RUG", "MAYHEM"])))
        #expect(!Contract.accepts(ContractInfo(contract: "1.0", noScoreLabels: ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT", "NEW"])))
        #expect(!Contract.accepts(ContractInfo(contract: "1.0", noScoreLabels: [])))
    }

    @Test("An answer missing a field cannot be read")
    func missingFieldFails() {
        #expect(throws: DecodingError.self) { try decode(#"{"contract":"1.0"}"#) }
        #expect(throws: DecodingError.self) { try decode(#"{"noScoreLabels":[]}"#) }
    }
}

@Suite("The app's shape")
struct ShapeTests {
    @Test("The footer's five rooms in the site's order")
    func footer() {
        #expect(Room.footer == [.discover, .pinr, .terminal, .wallet])
    }

    @Test("The test build points at this Mac's feed server")
    func debugFeedAddress() {
        #expect(FeedLink.configuredBaseURL()?.absoluteString == "http://127.0.0.1:8787")
    }
}

@Suite("The site's design")
struct DesignTests {
    @Test("The map: PINR north, Discover west, the guide at the centre, Wallet east, DeepScan south, ads in the corners")
    func compass() {
        #expect(Room.arena.cell == (1, 0) && Room.discover.cell == (0, 1) && Room.pinr.cell == (1, 1))
        #expect(Room.wallet.cell == (2, 1) && Room.terminal.cell == (1, 2))
        #expect([Room.adNW, .adNE, .adSW, .adSE].map(\.cell.c) == [0, 2, 0, 2])
        #expect(Room.allCases.filter(\.isAd).count == 4)
    }

    @Test("The camera puts a room exactly on screen; the whole map fits")
    func camera() {
        let l = MapLayout(screen: CGSize(width: 390, height: 844))
        let o = l.roomOrigin(.wallet)
        #expect(o.x == -2 * (390 + l.gap) && o.y == -(844 + l.gap))
        #expect(l.world.width * l.mapScale <= 390 && l.world.height * l.mapScale <= 844)
    }

    @Test("Badge marks follow the site's pairOf and padOf")
    func marks() throws {
        #expect(Mark.pair(try token(#"{"address":"A","coverage":1,"quotePair":"X / WSOL"}"#)) == .sol)
        #expect(Mark.pair(try token(#"{"address":"A","coverage":1,"quotePair":"X / HIMS"}"#)) == nil)
        #expect(Mark.pair(try token(#"{"address":"A","coverage":1,"chain":"base"}"#)) == .eth)
        #expect(Mark.pad(try token(#"{"address":"A","coverage":1,"launchpad":"PumpSwap"}"#)) == .pump)
        #expect(Mark.pad(try token(#"{"address":"A","coverage":1,"launchpad":"letsbonk"}"#)) == nil)
    }

    @Test("The compass blade points at the room, as compass.ts: bearing + 180; upright at the centre")
    func compassNeedle() {
        #expect(Compass.needle(.arena) == 180 && Compass.needle(.wallet) == 270 && Compass.needle(.terminal) == 360)
        #expect(Compass.needle(.discover) == 450 && Compass.needle(.adNE) == 225 && Compass.needle(.pinr) == 0)
    }

    @Test("Scored-ago words match the site's")
    func scoredAgo() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(DiscoverCard.scoredAgo(now.addingTimeInterval(-20), now: now) == "just now")
        #expect(DiscoverCard.scoredAgo(now.addingTimeInterval(-41 * 60), now: now) == "41 min ago")
        #expect(DiscoverCard.scoredAgo(now.addingTimeInterval(-5 * 3600), now: now) == "5 h ago")
        #expect(DiscoverCard.scoredAgo(now.addingTimeInterval(-26 * 3600), now: now) == "1 day ago")
    }

    @Test("The guide carries the approved sections, in order")
    func guide() {
        #expect(GuideCopy.sections.map(\.title) == ["Where everything is", "Why the site is laid out this way", "What a score is, and is not",
                                                     "How PINR scans", "The data, one kind at a time", "What PINR does for each kind of trader",
                                                     "What PINR does not do"])
    }
}
