import SwiftUI

/// The site's own line icons (header.ts, tabbar.ts), redrawn from their 24 by 24 paths:
/// stroked, 1.6 wide, round caps, in the current colour.
enum Glyph {
    case back, pipe, diag, filter, menu, compassTab, discover, deepscan, wallet

    func view(size: CGFloat) -> some View {
        GlyphShape(glyph: self)
            .stroke(style: StrokeStyle(lineWidth: 1.6 * 24 / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }
}

struct GlyphShape: Shape {
    let glyph: Glyph

    func path(in rect: CGRect) -> Path {
        var p = Path()
        switch glyph {
        case .back: // M19 12H5M11 6l-6 6 6 6
            p.move(to: .init(x: 19, y: 12)); p.addLine(to: .init(x: 5, y: 12))
            p.move(to: .init(x: 11, y: 6)); p.addLine(to: .init(x: 5, y: 12)); p.addLine(to: .init(x: 11, y: 18))
        case .pipe: // three dots joined by an elbow path
            for c in [CGPoint(x: 5, y: 6), CGPoint(x: 12, y: 12), CGPoint(x: 19, y: 18)] {
                p.addEllipse(in: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4))
            }
            p.move(to: .init(x: 7, y: 6)); p.addLine(to: .init(x: 10.5, y: 6))
            p.addQuadCurve(to: .init(x: 12, y: 7.5), control: .init(x: 12, y: 6)); p.addLine(to: .init(x: 12, y: 10))
            p.move(to: .init(x: 12, y: 14)); p.addLine(to: .init(x: 12, y: 16))
            p.addQuadCurve(to: .init(x: 14, y: 18), control: .init(x: 12, y: 18)); p.addLine(to: .init(x: 17, y: 18))
        case .diag: // M3 12h4l2.2-6 4.2 12 2.2-6H21
            p.move(to: .init(x: 3, y: 12)); p.addLine(to: .init(x: 7, y: 12)); p.addLine(to: .init(x: 9.2, y: 6))
            p.addLine(to: .init(x: 13.4, y: 18)); p.addLine(to: .init(x: 15.6, y: 12)); p.addLine(to: .init(x: 21, y: 12))
        case .filter: // M3.5 5h17l-6.4 7.6V19l-4.2-2v-4.4z
            p.move(to: .init(x: 3.5, y: 5)); p.addLine(to: .init(x: 20.5, y: 5)); p.addLine(to: .init(x: 14.1, y: 12.6))
            p.addLine(to: .init(x: 14.1, y: 19)); p.addLine(to: .init(x: 9.9, y: 17)); p.addLine(to: .init(x: 9.9, y: 12.6)); p.closeSubpath()
        case .menu: // M4 7h16M4 12h16M4 17h16
            for y in [7.0, 12, 17] { p.move(to: .init(x: 4, y: y)); p.addLine(to: .init(x: 20, y: y)) }
        case .compassTab: // circle r9 and the needle
            p.addEllipse(in: CGRect(x: 3, y: 3, width: 18, height: 18))
            p.move(to: .init(x: 15.6, y: 8.4)); p.addLine(to: .init(x: 13.5, y: 13.5)); p.addLine(to: .init(x: 8.4, y: 15.6))
            p.addLine(to: .init(x: 10.5, y: 10.5)); p.closeSubpath()
        case .discover: // the magnifying glass (tabbar.ts): lens r6.5 at 10.5, handle
            p.addEllipse(in: CGRect(x: 4, y: 4, width: 13, height: 13))
            p.move(to: .init(x: 15.5, y: 15.5)); p.addLine(to: .init(x: 21, y: 21))
        case .deepscan: // the pie chart (tabbar.ts): M12 3a9 9 0 109 9h-9z and the slice M15 3.5a8.5 8.5 0 015.5 5.5H15z
            p.move(to: .init(x: 12, y: 3))
            for step in 1 ... 54 { // the big arc, counter-clockwise from the top round to the right (270 degrees)
                let a = (-90.0 - Double(step) * 5) * .pi / 180
                p.addLine(to: .init(x: 12 + 9 * cos(a), y: 12 + 9 * sin(a)))
            }
            p.addLine(to: .init(x: 12, y: 12)); p.closeSubpath()
            p.move(to: .init(x: 15, y: 3.5)); p.addQuadCurve(to: .init(x: 20.5, y: 9), control: .init(x: 19.07, y: 4.93))
            p.addLine(to: .init(x: 15, y: 9)); p.closeSubpath()
        case .wallet:
            p.move(to: .init(x: 4, y: 7.5)); p.addQuadCurve(to: .init(x: 6.5, y: 5), control: .init(x: 4, y: 5)); p.addLine(to: .init(x: 17, y: 5)); p.addLine(to: .init(x: 17, y: 8))
            p.move(to: .init(x: 4, y: 7.5)); p.addLine(to: .init(x: 4, y: 17)); p.addQuadCurve(to: .init(x: 6, y: 19), control: .init(x: 4, y: 19))
            p.addLine(to: .init(x: 19, y: 19)); p.addLine(to: .init(x: 19, y: 8)); p.addLine(to: .init(x: 6.5, y: 8))
            p.addQuadCurve(to: .init(x: 4, y: 7.5), control: .init(x: 4, y: 8))
            p.addEllipse(in: CGRect(x: 14.9, y: 12.4, width: 2.2, height: 2.2))
        }
        return p.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
    }
}

/// The pair and launchpad marks on a coin's picture (world/marks.ts), drawn from the site's shapes.
enum Mark: String {
    case sol, eth, bnb, usdt, usdc, pump, clanker, bankr, flap, fourmeme

    /// The coin a pair trades against (the site's `pairOf`); another coin is not drawn.
    static func pair(_ t: Token) -> Mark? {
        if let qp = t.quotePair {
            let q = (qp.split(separator: "/").last.map(String.init) ?? qp).trimmingCharacters(in: .whitespaces).uppercased()
            switch q {
            case "SOL", "WSOL": return .sol
            case "ETH", "WETH": return .eth
            case "BNB", "WBNB": return .bnb
            case "USDT": return .usdt
            case "USDC": return .usdc
            case "": break
            default: return nil
            }
        }
        switch (t.chain ?? "").lowercased() {
        case "solana": return .sol
        case "base", "ethereum": return .eth
        case "bsc", "bnb": return .bnb
        default: return nil
        }
    }

    /// The launchpad's mark (the site's `padOf`).
    static func pad(_ t: Token) -> Mark? {
        let l = (t.launchpad ?? "").lowercased()
        if l.contains("pump") { return .pump }
        if l.contains("clanker") { return .clanker }
        if l.contains("bankr") { return .bankr }
        if l.contains("flap") { return .flap }
        if l.contains("four") { return .fourmeme }
        return nil
    }
}

/// One mark, drawn in a 24 by 24 box.
struct MarkView: View {
    let mark: Mark

    var body: some View {
        Canvas { ctx, size in
            let k = size.width / 24
            func poly(_ pts: [(Double, Double)], _ c: Color) {
                var p = Path(); p.move(to: .init(x: pts[0].0 * k, y: pts[0].1 * k))
                for q in pts.dropFirst() { p.addLine(to: .init(x: q.0 * k, y: q.1 * k)) }
                p.closeSubpath(); ctx.fill(p, with: .color(c))
            }
            func disc(_ fill: Color, _ letter: String, _ ink: Color = .white) {
                ctx.fill(Path(ellipseIn: CGRect(x: k, y: k, width: 22 * k, height: 22 * k)), with: .color(fill))
                ctx.draw(Text(letter).font(.system(size: 13 * k, weight: .bold)).foregroundStyle(ink), at: CGPoint(x: 12 * k, y: 12.4 * k))
            }
            switch mark {
            case .sol:
                poly([(7, 5.6), (20.5, 5.6), (17.5, 8.8), (4, 8.8)], Color(hex: 0x19F0A0))
                poly([(4, 10.4), (17.5, 10.4), (20.5, 13.6), (7, 13.6)], Color(hex: 0x6F8DF5))
                poly([(7, 15.2), (20.5, 15.2), (17.5, 18.4), (4, 18.4)], Color(hex: 0x9945FF))
            case .eth:
                poly([(12, 2), (18, 12), (12, 15.6), (6, 12)], Color(hex: 0x9AA4D0))
                poly([(12, 17), (18, 13.2), (12, 22), (6, 13.2)], Color(hex: 0xC3C9E8))
            case .bnb:
                for (cx, cy) in [(12.0, 5.9), (6.2, 11.7), (17.8, 11.7), (12, 17.5), (12, 11.7)] {
                    poly([(cx, cy - 2.5), (cx + 2.5, cy), (cx, cy + 2.5), (cx - 2.5, cy)], Color(hex: 0xF3BA2F))
                }
            case .usdt: disc(Color(hex: 0x26A17B), "T")
            case .usdc: disc(Color(hex: 0x2775CA), "$")
            case .pump:
                var g = ctx
                g.translateBy(x: 12 * k, y: 12 * k); g.rotate(by: .degrees(-45)); g.translateBy(x: -12 * k, y: -12 * k)
                let left = Path(roundedRect: CGRect(x: 4.5 * k, y: 7.5 * k, width: 7.5 * k, height: 9 * k), cornerSize: CGSize(width: 4.5 * k, height: 4.5 * k))
                g.fill(left, with: .color(Color(hex: 0x5FD9A0)))
                g.fill(Path(CGRect(x: 9 * k, y: 7.5 * k, width: 3 * k, height: 9 * k)), with: .color(Color(hex: 0x5FD9A0)))
                let right = Path(roundedRect: CGRect(x: 12 * k, y: 7.5 * k, width: 7.5 * k, height: 9 * k), cornerSize: CGSize(width: 4.5 * k, height: 4.5 * k))
                g.fill(right, with: .color(.white))
                g.fill(Path(CGRect(x: 12 * k, y: 7.5 * k, width: 3 * k, height: 9 * k)), with: .color(.white))
                g.stroke(Path(roundedRect: CGRect(x: 4.5 * k, y: 7.5 * k, width: 15 * k, height: 9 * k), cornerSize: CGSize(width: 4.5 * k, height: 4.5 * k)),
                         with: .color(Color(hex: 0x1D3D30)), lineWidth: 1.2 * k)
            case .clanker: disc(Color(hex: 0x6A4CFF), "C")
            case .bankr: disc(Color(hex: 0x1D1D1F), "B")
            case .flap: disc(Color(hex: 0xEF7D2D), "F")
            case .fourmeme: disc(Color(hex: 0xF3BA2F), "4", Color(hex: 0x1D1D1F))
            }
        }
        .accessibilityHidden(true)
    }
}
