/**
 * PINRads: a click on an empty ad space opens this page, an application for that space. It sends the project's
 * name, link, picture and contact, and the slot, to PINR's own server, which keeps it for the operator (listed on /control). Nothing is published
 * from here and no payment is taken; the words say so and promise no placement or result. A full page over the view, like the PINR guide.
 */
import { AD_PICTURE_MAX_BYTES, AD_SLOTS, formProblem, type AdApplication, type AdSlot } from "../world/adsform";

export interface AdsApplyPage {
  el: HTMLElement;
  /** Open the page for one slot (pre-filled). */
  open(slot: AdSlot): void;
  show(on: boolean): void;
  isOpen(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLElement {
  const wrap = el("label", "adfield");
  wrap.append(el("span", "adlabel", label), input);
  if (hint) wrap.append(el("span", "adhint", hint));
  return wrap;
}

const readPicture = (f: File): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error("unreadable"));
    r.readAsDataURL(f);
  });

export function createAdsApplyPage(onClose: () => void, send: (a: AdApplication) => Promise<{ ok: true } | { ok: false; words: string }>): AdsApplyPage {
  const root = el("div");
  root.id = "adspanel";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Apply for an ad space");
  const scroller = el("div", "sscroll");
  root.append(scroller);
  const top = el("div", "stop");
  const back = el("button", "sback");
  back.type = "button";
  back.setAttribute("aria-label", "Close the ad application");
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  back.addEventListener("click", onClose);
  top.append(back, el("h1", "stitle", "PINRads"));
  scroller.append(top);

  const page = el("div", "gdpage adpage");
  scroller.append(page);
  const intro = el("section", "dssec gdsec");
  intro.append(
    el("h2", "dsh", "Apply for an ad space"),
    el("p", "gdp", "Tell us about your project and the space you would like. Your application goes to the PINR team only."),
    el("p", "gdp", "Nothing is published from this form and no payment is taken. Applying does not mean an ad will be placed, and PINR makes no promise about where or how an ad would be shown or what it would bring."),
  );

  const form = el("form", "adform");
  form.noValidate = true;
  const slot = el("select");
  for (const s of AD_SLOTS) slot.append(new Option(`Ad space ${s}`, s));
  const name = el("input");
  name.type = "text";
  name.maxLength = 60;
  name.autocomplete = "organization";
  const link = el("input");
  link.type = "url";
  link.maxLength = 200;
  link.placeholder = "https://";
  const picture = el("input");
  picture.type = "file";
  picture.accept = "image/png,image/jpeg,image/webp,image/gif";
  const contact = el("input");
  contact.type = "text";
  contact.maxLength = 120;
  contact.autocomplete = "email";
  const status = el("p", "adstatus");
  status.setAttribute("role", "status");
  const submit = el("button", "adsend", "Send application");
  submit.type = "submit";
  form.append(
    field("Ad space", slot),
    field("Project name", name),
    field("Link", link, "Your project's website or main page."),
    field("Picture", picture, "Optional. PNG, JPEG, WebP or GIF, up to 3 MB. PINR keeps a small copy."),
    field("Contact", contact, "An email, Telegram or X handle, so the team can reply."),
    submit,
    status,
  );
  intro.append(form);
  const done = el("section", "dssec gdsec addone");
  done.hidden = true;
  const again = el("button", "adsend", "Send another");
  again.type = "button";
  done.append(el("h2", "dsh", "Application received"), el("p", "gdp", "Thank you. The PINR team reads every application and replies through the contact you gave. Nothing has been published."), again);
  page.append(intro, done);

  let sending = false;
  const say = (words: string, bad: boolean): void => {
    status.textContent = words;
    status.classList.toggle("bad", bad);
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sending) return;
    const a = { slot: slot.value as AdSlot, name: name.value.trim(), link: link.value.trim(), contact: contact.value.trim() };
    const problem = formProblem(a);
    if (problem) return say(problem, true);
    const f = picture.files?.[0] ?? null;
    if (f && f.size > AD_PICTURE_MAX_BYTES) return say("The picture can be at most 3 MB.", true);
    sending = true;
    submit.disabled = true;
    say("Sending…", false);
    void (async () => {
      try {
        const pic = f ? await readPicture(f) : null;
        const res = await send({ ...a, picture: pic });
        if (res.ok) {
          intro.hidden = true;
          done.hidden = false;
          scroller.scrollTop = 0;
        } else say(res.words, true);
      } catch {
        say("The application was not sent. Check your connection and try again.", true);
      } finally {
        sending = false;
        submit.disabled = false;
      }
    })();
  });
  again.addEventListener("click", () => {
    form.reset();
    say("", false);
    done.hidden = true;
    intro.hidden = false;
  });

  document.body.append(root);
  let open = false;
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) onClose();
  });
  return {
    el: root,
    open(s) {
      slot.value = s;
      say("", false);
      done.hidden = true;
      intro.hidden = false;
    },
    show(on) {
      open = on;
      root.classList.toggle("on", on);
      if (on) scroller.scrollTop = 0;
    },
    isOpen: () => open,
  };
}
