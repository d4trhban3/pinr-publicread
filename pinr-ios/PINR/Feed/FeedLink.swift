import Foundation
import Observation

/// The app's link to the feed server: where it is, and whether it answers in a contract the
/// app understands. Read-only: the app only ever asks the feed for data, never sends any.
@MainActor
@Observable
final class FeedLink {
    enum State: Equatable {
        case connecting
        case live(contract: String)
        case offline(reason: String)
        case mismatch(contract: String)
    }

    private(set) var state: State = .connecting
    private(set) var lastHeard: Date?
    let baseURL: URL?

    private let session: URLSession

    init(baseURL: URL? = FeedLink.configuredBaseURL(), session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// The feed's address comes from the build: this Mac's feed server in test builds, the
    /// planned server over HTTPS in release builds (Config/Debug.plist, Config/Release.plist).
    nonisolated static func configuredBaseURL(bundle: Bundle = .main) -> URL? {
        #if DEBUG
        let release = false
        #else
        let release = true
        #endif
        return feedURL(bundle.object(forInfoDictionaryKey: "PINRFeedURL") as? String, release: release)
    }

    /// A release build reads only an HTTPS address (step 10: https://pinr.io, so its calls go to https://pinr.io/api/…);
    /// anything else leaves it without a feed rather than reading in the clear. Test builds may read this Mac.
    nonisolated static func feedURL(_ text: String?, release: Bool) -> URL? {
        guard let text, let url = URL(string: text), let scheme = url.scheme?.lowercased(), url.host() != nil else { return nil }
        if release { return scheme == "https" ? url : nil }
        return scheme == "https" || scheme == "http" ? url : nil
    }

    /// Asks the feed once which contract it speaks.
    func check() async {
        guard let baseURL else {
            state = .offline(reason: "No feed address in this build")
            return
        }
        var request = URLRequest(url: baseURL.appending(path: "api/contract"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 8
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                state = .offline(reason: "The feed answered \(code)")
                return
            }
            let info = try JSONDecoder().decode(ContractInfo.self, from: data)
            lastHeard = Date()
            state = Contract.accepts(info) ? .live(contract: info.contract) : .mismatch(contract: info.contract)
        } catch is DecodingError {
            state = .offline(reason: "The feed's answer could not be read")
        } catch {
            state = .offline(reason: "The feed cannot be reached")
        }
    }

    /// Checks now, then every 15 seconds while the app is open.
    func watch() async {
        while !Task.isCancelled {
            await check()
            try? await Task.sleep(for: .seconds(15))
        }
    }
}
