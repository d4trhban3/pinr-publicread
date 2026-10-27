> [!WARNING]
> **Work in progress.** PINR is live at pinr.io but early and unfinished. It runs on free nodes that can only fully scan a few coins a minute, so most coins are read but not fully scanned. Readings can be incomplete or wrong because PINR needs more data. Paid data streams are what get it to full coverage, and community funding pays for those.

# PINR

PINR is an evidence hub for memecoins. For any token it lays out every link, wallet, funder, holder and trade behind it, each one with its receipt: where the fact was read, and when, so anyone can check it at the source.

PINR is a doctor, not a judge. It shows what was observed and never gives verdicts: it never calls a coin good or bad, never tells anyone to buy or sell, and makes no promises about any coin. It is read-only. It never connects to, signs for, or moves anything in anyone's wallet.

Live at **https://pinr.io**.

> **Early and unfinished.** This is a working project, not a finished product. Things change often, some parts are rough, and some tests exercise code that is not in this copy.

## What is in this repository

This is a redacted public copy of the PINR source.

| Folder | What it is |
|---|---|
| `pinr-live/` | The website (Vite + TypeScript) and its feed server (`server/`, Node), which reads the engine's output and public market data and serves it to the page. |
| `engine/` | The scanner and evidence readers (mostly Python): chain readers for Solana, BNB Chain and Base, launchpad readers, the feed exporter, the control service (`control/`), live trade readers (`livews/`) and ops scripts (`ops/`). |
| `pinr-ios/` | The iPhone app (SwiftUI). |
| `pinr-android/` | The Android app (Kotlin, Jetpack Compose). |
| `pinrbot/` | A small relay script used by PINR's bot tooling. |

### What is withheld

- **PINR's proprietary analysis rules.** The rules, weights, thresholds and tuning behind PINR's analysis, including its bot-detection and social checks, are not included. The affected functions keep their names and signatures, but their bodies raise `NotImplementedError("redacted: …")` and their settings are blanked. Files and functions touched this way say so at the top.
- **Model prompts and calibration** for PINR's AI readers.
- **Internal documents**: planning notes, decision logs, data contracts, handover notes and team instructions.
- **Secrets and private configuration**: API keys, node URLs, access settings and signing material. Use the `.env.example` files as a template for your own.
- **Data**: scan outputs, caches, logs and databases, and most brand art.

Because of this, the engine will not produce scores on its own, and a few tests that depended on the withheld parts were removed.

## Run the website locally

You need Node.js 20 or newer.

```sh
cd pinr-live
npm install
cp .env.example .env        # optional: every setting has a default
npm run feed:sample         # terminal 1: the feed server on a small made-up sample (no network for market data)
npm run dev                 # terminal 2: the site, at the address Vite prints
```

`npm run feed` runs the feed server against a real engine output folder instead of the sample. `npm test` runs the site and server tests.

The engine's Python suites run from their own folders, for example `cd engine/scanner && python3 test_basic.py`.

## Status

PINR is a work in progress. The site at https://pinr.io is live, but it is early and unfinished.

- PINR currently runs on free nodes, which can only fully scan a few coins a minute.
- Most coins are read but not fully scanned, so readings can be incomplete or wrong.
- Every fact shown still carries its receipt, so you can check it at the source.
- Bug reports are welcome: if a reading looks off, tell us.

## Help fund the data

Full coverage needs paid data streams: RPC nodes and indexers that can scan every coin, not just a few a minute. Community funding is what pays for those.

If you want to help fund the data streams, reach out via [@PINRofficial](https://x.com/PINRofficial) on X. Founder: d4rthban3.

## Feedback

Questions, bug reports and ideas are welcome on X: [@PINRofficial](https://x.com/PINRofficial) and [@PINRsupport](https://x.com/PINRsupport).

## License

Copyright © PINR. **All rights reserved.** No open-source license is granted: you may read this code, but copying, modifying or redistributing it requires permission. See `NOTICE`.
