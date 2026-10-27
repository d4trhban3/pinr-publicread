import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { avatarColors, cleanAddress, detectChain, parseProfile, shortAddr, VIEW_ONLY_POINTS, VIEW_ONLY_TITLE } from "./wallet";
import { AD_AREAS } from "../ui/pages";

const EVM = "0x22AF33fe49fd1fa80c7149773dde5890d3c76f3b";
const SOL = "3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW";

describe("wallet profile rules", () => {
  it("tells EVM and Solana addresses apart and refuses anything else", () => {
    expect(detectChain(EVM)).toBe("evm");
    expect(detectChain(SOL)).toBe("solana");
    for (const bad of ["", "0x123", "hello", EVM + "0", "0x" + "g".repeat(40), " " + SOL + "x!"]) expect(detectChain(bad)).toBeNull();
  });
  it("cleans addresses: EVM lower-cased, whitespace trimmed", () => {
    expect(cleanAddress(`  ${EVM}  `)).toEqual({ address: EVM.toLowerCase(), chain: "evm" });
    expect(cleanAddress(SOL)).toEqual({ address: SOL, chain: "solana" });
    expect(cleanAddress("nope")).toBeNull();
  });
  it("shortens long addresses only", () => {
    expect(shortAddr(EVM)).toBe("0x22AF…6f3b");
    expect(shortAddr("abc")).toBe("abc");
  });
  it("reads a saved lookup and rejects a damaged one; a profile an earlier version saved comes back as the plain address", () => {
    expect(parseProfile({ chain: "evm", address: EVM, at: 5 })).toEqual({ chain: "evm", address: EVM.toLowerCase(), at: 5 });
    expect(parseProfile({ kind: "connected", chain: "evm", address: EVM, via: "MetaMask", at: 5 })).toEqual({ chain: "evm", address: EVM.toLowerCase(), at: 5 });
    expect(parseProfile({ address: SOL })).toMatchObject({ chain: "solana" });
    expect(parseProfile({ chain: "solana", address: EVM })).toBeNull();
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile({ address: "x" })).toBeNull();
  });
  it("gives every address a steady avatar", () => {
    expect(avatarColors(EVM)).toEqual(avatarColors(EVM.toLowerCase()));
    expect(avatarColors(EVM)).not.toEqual(avatarColors(SOL));
  });
  it("never shows the word \"safe\" (public copy rule): the wording and the pages' own strings", () => {
    const shown = [VIEW_ONLY_TITLE, ...VIEW_ONLY_POINTS].join(" ");
    expect(shown).not.toMatch(/\bsafe\b/i);
    for (const f of ["../ui/wallet.ts", "../ui/pages.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      // only the strings between quotes that a visitor can read: look for the word inside a quoted piece of text
      const quoted = src.match(/"[^"\n]*"|`[^`\n]*`/g) ?? [];
      expect(quoted.filter((q) => /\bsafe\b/i.test(q) && !/safe-area|assertSafe/i.test(q)), f).toEqual([]);
    }
  });
  it("the view-only wording says what it must", () => {
    const text = VIEW_ONLY_POINTS.join(" ").toLowerCase();
    expect(text).toContain("public wallet address");
    expect(text).toContain("does not connect to your wallet");
    expect(text).toContain("seed phrase");
    expect(text).toContain("on this device only");
  });
});

/**
 * PINR is view-only: nothing in the site connects to a wallet. Checked against the code itself: no source file mentions a wallet
 * connection library, a wallet request, or a call that signs, sends, approves or switches, and the page has no way to connect.
 */
describe("the site cannot connect to a wallet, sign or send", () => {
  const root = join(import.meta.dirname, "..", "..");
  const FORBIDDEN = [
    "@walletconnect", "walletconnect", "reown", "REOWN", "window.ethereum", "eth_requestAccounts", "eth_accounts", "wallet_requestPermissions", "navigator.solana", "window.solana", "solana.connect", "EIP6963", "eip6963",
    "eth_sendTransaction", "personal_sign", "eth_sign", "eth_signTypedData", "signTransaction", "signAllTransactions", "signMessage", "signAndSendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_watchAsset", "sendTransaction",
  ];
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "fixtures" ? [] : sources(join(dir, e.name))) : /\.(ts|css|html)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
  const files = [...sources(join(root, "src")), ...sources(join(root, "server")), join(root, "index.html")];
  it("has no wallet connection or signing code in any source file", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const bad of FORBIDDEN) expect(src.includes(bad), `${f.replace(root, "")} mentions ${bad}`).toBe(false);
    }
  });
  it("does not depend on a wallet connection library", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => /walletconnect|reown|wagmi|ethers|web3|solana/i.test(d))).toEqual([]);
  });
  it("the page offers no way to connect: only a lookup and the file list holds no connection module", () => {
    const names = readdirSync(join(root, "src", "ui")).filter((n) => /wallet/i.test(n));
    expect(names).toEqual(["wallet.ts"]);
    const page = readFileSync(join(root, "src", "ui", "wallet.ts"), "utf8");
    expect(page).not.toMatch(/Connect a wallet|Disconnect|Open in Phantom|\bconnect\(/);
  });
});

describe("the ad corners hold PINR's own placeholders only", () => {
  const BRANDS = ["Solana", "Base", "BNB", "Alchemy", "DexScreener", "Jupiter", "Phantom", "Uniswap", "InsightX", "Bubblemaps", "RugCheck", "GoPlus", "pump.fun", "Clanker", "four.meme", "Farcaster"];
  it("names no real project, and every slot is a numbered PINR ad space", () => {
    const all = Object.values(AD_AREAS).flat();
    expect(all).toHaveLength(16); // four ad areas again: the PvP Arena moved north (2026-10-25)
    for (const s of all) {
      expect(s.name).toMatch(/^Ad space [A-D][1-4]$/);
      expect(s.kind).toMatch(/placeholder$/);
      for (const b of BRANDS) expect(`${s.name} ${s.kind}`.toLowerCase().includes(b.toLowerCase()), `${s.name} names ${b}`).toBe(false);
    }
    expect(new Set(all.map((s) => s.name)).size).toBe(16);
  });
});
