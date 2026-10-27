import Foundation

/// The engine's note is a list of parts joined by ";". A part that only says the engine hit a "technical error" or is "retrying" is a status, not a finding about the
/// coin, so it is never shown (the site's `STATUS_NOTE`, livefeed.ts: /^technical error\b|\bretrying\b/i). What is left is shown as the note; nothing left, no note.
enum EngineNote {
    static func shown(_ note: String?) -> String? {
        guard let note else { return nil }
        let kept = note.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.range(of: #"^technical error\b|\bretrying\b"#, options: [.regularExpression, .caseInsensitive]) == nil }
        return kept.isEmpty ? nil : kept.joined(separator: "; ")
    }
}
