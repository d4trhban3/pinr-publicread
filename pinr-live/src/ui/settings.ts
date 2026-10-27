/**
 * The Settings page: a full page laid over the view (opened from the menu), in the same black glass as the rest.
 * Only settings that really work are here: tiles per row, the live background and the moving streams.
 * The choices are remembered between visits by main.ts.
 */
import { applyChoices, currentChoices, decodeChoices, describeChoices, encodeChoices, type Choices } from "../world/choicescode";
import { moderation } from "../world/moderation";

export interface SettingsOptions {
  onBackground(on: boolean): void;
  onMotion(on: boolean): void;
  onClose(): void;
}

export interface Settings {
  el: HTMLElement;
  show(on: boolean): void;
  isOpen(): boolean;
  setBackground(on: boolean): void;
  setMotion(on: boolean): void;
  /** The line under "Moving streams": says why they are or are not showing. */
  setMotionNote(text: string): void;
  setDataStatus(text: string, warn: boolean): void;
  /** The note under the Data card. */
  setDataNote(text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createSettings(opts: SettingsOptions): Settings {
  const root = el("div", "settings");
  root.id = "settings";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Settings");
  const scroller = el("div", "sscroll");

  const top = el("div", "stop");
  const back = el("button", "sback");
  back.type = "button";
  back.setAttribute("aria-label", "Close settings");
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  back.addEventListener("click", () => opts.onClose());
  top.append(back, el("h1", "stitle", "Settings"));

  const section = (title: string): { box: HTMLElement; card: HTMLElement } => {
    const box = el("section", "ssec");
    box.append(el("h2", "shead", title));
    const card = el("div", "scard");
    box.append(card);
    return { box, card };
  };
  const line = (label: string, hint?: string): { row: HTMLElement; right: HTMLElement } => {
    const row = el("div", "srow");
    const text = el("div", "stext");
    text.append(el("b", undefined, label));
    if (hint) text.append(el("i", undefined, hint));
    const right = el("div", "sright");
    row.append(text, right);
    return { row, right };
  };
  const toggle = (on: (v: boolean) => void): { b: HTMLButtonElement; set(v: boolean): void } => {
    const b = el("button", "stoggle");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.append(el("span", "knob"));
    let value = false;
    const set = (v: boolean): void => {
      value = v;
      b.classList.toggle("on", v);
      b.setAttribute("aria-checked", String(v));
    };
    b.addEventListener("click", () => {
      set(!value);
      on(value);
    });
    return { b, set };
  };

  // Display
  const display = section("Display");
  const bg = line("Live background", "The moving art behind everything");
  const bgT = toggle((v) => opts.onBackground(v));
  bg.right.append(bgT.b);
  const mo = line("Moving streams", "Buy and sell streaks on tiles and rows");
  const moNote = mo.row.querySelector("i") as HTMLElement;
  const moT = toggle((v) => opts.onMotion(v));
  mo.right.append(moT.b);
  display.card.append(bg.row, mo.row);

  // Coin names: kept in this browser only; nothing here changes a score.
  const names = section("Coin names");
  const rude = line("Hide rude coin names", "Masks the name, ticker and picture of coins with a rude name");
  const rudeT = toggle((v) => moderation.setFilterNames(v));
  rudeT.set(moderation.filterNames);
  rude.right.append(rudeT.b);
  const hiddenRow = line("Hidden coins", "Coins you hid with the eye-slash, or by pressing and holding a tile");
  const hiddenCount = el("b", "sstatus");
  const showAgain = el("button", "sbtn", "Show them again");
  showAgain.type = "button";
  showAgain.addEventListener("click", () => moderation.unhideAll());
  hiddenRow.right.append(hiddenCount, showAgain);
  names.card.append(rude.row, hiddenRow.row);
  const syncNames = (): void => {
    rudeT.set(moderation.filterNames);
    hiddenCount.textContent = String(moderation.hiddenCount);
    showAgain.hidden = moderation.hiddenCount === 0;
  };
  moderation.onChange(syncNames);
  syncNames();

  // Your choices: one code to copy and paste into another browser or the iPhone app. No account, nothing is sent to PINR.
  const mine = section("Your choices");
  const ex = line("Copy my choices", "A short code for your hidden coins, name filter and looked-up address. It holds nothing else, and nothing is sent to PINR.");
  const copyBtn = el("button", "sbtn", "Copy code");
  copyBtn.type = "button";
  ex.right.append(copyBtn);
  const codeBox = el("textarea", "scode");
  codeBox.readOnly = true;
  codeBox.rows = 3;
  codeBox.hidden = true;
  codeBox.setAttribute("aria-label", "Your choices code");
  const im = line("Paste a code", "From another browser or the iPhone app. You will see what it holds before anything changes.");
  const paste = el("textarea", "scode");
  paste.rows = 3;
  paste.placeholder = "PINR1.…";
  paste.spellcheck = false;
  paste.autocomplete = "off";
  paste.setAttribute("aria-label", "Paste a choices code");
  const checkBtn = el("button", "sbtn", "Check code");
  checkBtn.type = "button";
  im.right.append(checkBtn);
  const outcome = el("p", "snote scodenote");
  outcome.hidden = true;
  const confirm = el("div", "sconfirm");
  confirm.hidden = true;
  const yes = el("button", "sbtn", "Import");
  yes.type = "button";
  const no = el("button", "sbtn sbtnq", "Cancel");
  no.type = "button";
  confirm.append(yes, no);
  mine.card.append(ex.row, codeBox, im.row, paste, outcome, confirm);
  let pending: Choices | null = null;
  const say = (text: string, bad = false): void => {
    outcome.hidden = text === "";
    outcome.textContent = text;
    outcome.classList.toggle("swarn", bad);
  };
  const storage = (): Storage | null => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  };
  copyBtn.addEventListener("click", async () => {
    const code = encodeChoices(currentChoices(storage(), moderation));
    codeBox.value = code;
    codeBox.hidden = false;
    codeBox.select();
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = "Copied";
    } catch {
      copyBtn.textContent = "Select and copy";
    }
    setTimeout(() => (copyBtn.textContent = "Copy code"), 2000);
  });
  checkBtn.addEventListener("click", () => {
    pending = null;
    confirm.hidden = true;
    const r = decodeChoices(paste.value);
    if (!r.ok) return say(r.reason === "newer" ? "This code is from a newer PINR." : "That is not a PINR code.", true);
    pending = r.choices;
    say(`This code holds: ${describeChoices(r.choices)}. Hidden coins are added to yours; nothing is un-hidden.`);
    confirm.hidden = false;
  });
  no.addEventListener("click", () => {
    pending = null;
    confirm.hidden = true;
    say("");
  });
  yes.addEventListener("click", () => {
    if (!pending) return;
    const r = applyChoices(pending, storage(), moderation);
    pending = null;
    confirm.hidden = true;
    paste.value = "";
    say(`Imported: ${r.hiddenAdded} new hidden ${r.hiddenAdded === 1 ? "coin" : "coins"}${r.walletChanged ? ", and the looked-up address (the page reloads to show it)" : ""}.`);
    if (r.walletChanged) setTimeout(() => location.reload(), 1500);
  });

  // Data
  const data = section("Data");
  const statusRow = line("Status");
  const statusText = el("b", "sstatus");
  statusRow.right.classList.add("fill");
  statusRow.right.append(statusText);
  data.card.append(statusRow.row);
  const dataNote = el("p", "snote");
  data.box.append(dataNote);

  // About
  const about = section("About");
  const ver = line("PINR", "Phone-first, living data interface");
  ver.right.append(el("span", "smono", "prototype"));
  about.card.append(ver.row);
  const priv = line("Privacy policy", "No accounts, no cookies, no analytics");
  const privLink = el("a", "sbtn", "Read");
  privLink.href = "/privacy.html";
  privLink.target = "_blank";
  privLink.rel = "noopener noreferrer";
  priv.right.append(privLink);
  about.card.append(priv.row);

  scroller.append(top, display.box, names.box, mine.box, data.box, about.box);
  root.append(scroller);
  document.body.append(root);

  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) opts.onClose();
  });

  let open = false;
  return {
    el: root,
    show(on) {
      open = on;
      root.classList.toggle("on", on);
      if (on) scroller.scrollTop = 0;
    },
    isOpen: () => open,
    setMotionNote(text) {
      moNote.textContent = text;
    },
    setDataStatus(text, warn) {
      statusText.textContent = text;
      statusText.classList.toggle("swarn", warn);
    },
    setDataNote(text) {
      dataNote.textContent = text;
    },
    setBackground: (v) => bgT.set(v),
    setMotion: (v) => moT.set(v),
  };
}
