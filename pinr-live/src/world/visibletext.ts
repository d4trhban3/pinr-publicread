/**
 * Coin names and tickers with the invisible characters taken out (the team, 2026-10-25: the Arena showed "Blind Ape" with a
 * hidden U+2060 inside). Out go the format characters (zero-width space, joiners and non-joiners, the word joiner, the byte
 * order mark, direction marks and overrides, the soft hyphen, invisible maths operators), the variation selectors and tags,
 * and the characters that draw as a blank (Hangul fillers, the braille blank). A zero-width joiner between two emoji stays,
 * so an emoji built from parts still draws as one. Control characters become spaces, runs of space become one, and the ends
 * are trimmed. What is left is what a reader sees; a name with nothing visible left is empty.
 */
const ZWJ = "‍";
const PICTO = /\p{Extended_Pictographic}/u;
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏⠀ㅤﾠ︀-️]|\udb40[\udc00-\udc7f]|\udb40[\udd00-\uddef]/gu;

export function visibleText(s: string): string {
  let out = "";
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === ZWJ) {
      // Keep it only inside an emoji sequence (an emoji before it, ignoring a variation selector, and one after it).
      let p = i - 1;
      while (p >= 0 && /[︀-️]/.test(chars[p]!)) p--;
      if (p >= 0 && PICTO.test(chars[p]!) && i + 1 < chars.length && PICTO.test(chars[i + 1]!)) out += c;
      continue;
    }
    // Variation selector 16 asks for the colour emoji form; it stays straight after an emoji, where it does something.
    if (c === "️" && i > 0 && PICTO.test(chars[i - 1]!)) {
      out += c;
      continue;
    }
    INVISIBLE.lastIndex = 0;
    if (INVISIBLE.test(c)) continue;
    out += c;
  }
  return out.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
