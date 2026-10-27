import { feedDirs, loadFeed } from "./feed.ts";
import { CONTRACT_VERSION } from "./translate.ts";

/**
 * The contract check. Run after changing anything that writes results:  npm run contract:check
 * Tells you, in plain words, whether the app can read every result file, and exactly what is wrong if not.
 * Exit code 0 = every file is usable (warnings are fine); 1 = at least one file would be left out.
 */
const snap = loadFeed();
const dirs = feedDirs();
console.log(`PINR data contract v${CONTRACT_VERSION}\n`);
console.log("Folders read (in priority order):");
for (const d of dirs) console.log(`  ${d.feed ? "[drop folder]" : "[replay]     "} ${d.dir}`);
console.log(`\nFiles read: ${snap.files}   Usable tokens: ${snap.tokens.length}   Mode: ${snap.mode}`);

let errors = 0;
let warnings = 0;
for (const f of snap.problems) {
  for (const p of f.problems) {
    if (p.severity === "error") errors++;
    else warnings++;
  }
}
if (snap.problems.length) {
  console.log("");
  for (const f of snap.problems) {
    console.log(f.file);
    for (const p of f.problems) console.log(`   ${p.severity === "error" ? "ERROR  " : "warning"}  ${p.field}: ${p.message}`);
  }
}
console.log(`\n${errors === 0 ? "PASS" : "FAIL"}: ${errors} error(s) (a token left out), ${warnings} warning(s) (a field treated as missing).`);
console.log(
  errors === 0
    ? "Every file can be shown in the app."
    : "Fix the errors above: those tokens are NOT shown in the app until the file matches the contract.",
);
process.exit(errors === 0 ? 0 : 1);
