/**
 * TradingView Advanced Charts on the coin page (the full TradingView chart on every coin), behind a switch. OFF until TradingView grants the library
 * . The library is NOT in this repo: when it
 * is granted it is placed under `public/charting_library/` (its own licence says how) and `TV_ADVANCED` is set to true, and nothing else changes: the
 * datafeed (world/tvdatafeed.ts) is ready. Public pages only; the logo is never hidden (`logo` is not disabled below).
 */
export const TV_ADVANCED = false;
/** Where the library's script is served from once it is dropped in. */
export const LIBRARY_PATH = "/charting_library/";
export const LIBRARY_SCRIPT = `${LIBRARY_PATH}charting_library.standalone.js`;

/** The options handed to the library for one coin's chart. Kept here so a test can hold them to the licence's rules. */
export function widgetOptions(symbol: string, datafeed: unknown, container: HTMLElement | string, theme: "dark" | "light"): Record<string, unknown> {
  return {
    symbol,
    interval: "15",
    container,
    datafeed,
    library_path: LIBRARY_PATH,
    locale: "en",
    theme,
    autosize: true,
    timezone: "Etc/UTC",
    // The licence: TradingView's logo stays visible, so it is never listed in disabled_features; one coin per page, so no symbol picker.
    disabled_features: ["header_symbol_search", "symbol_search_hot_key", "header_compare", "use_localstorage_for_settings"],
    enabled_features: [],
    overrides: {},
  };
}

/** Loads the library's script once; resolves with the global it defines. Only called with the switch on. */
export function loadLibrary(doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((doc.defaultView as unknown as { TradingView?: unknown } | null)?.TradingView) return resolve();
    const s = doc.createElement("script");
    s.src = LIBRARY_SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("the TradingView library could not be loaded"));
    doc.head.append(s);
  });
}
