// The "PINRads" tab on /control: the applications visitors sent from pinr.io's ad spaces, newest first, read from the engine's control
// service (GET /api/control/pinrads; pictures from /api/control/pinrads/picture?id=). Read-only: nothing here publishes, replies or deletes. Every
// field is set as text (an applicant's words never become markup), and a link is shown only when it is https.
(function () {
  "use strict";
  if (typeof document === "undefined") return;
  const EVERY_MS = 30000;
  const panel = document.createElement("section");
  panel.id = "adspanel";
  panel.hidden = true;
  document.body.append(panel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const when = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  };
  function row(a) {
    const r = el("div", "adrow");
    if (typeof a.picture === "string" && /^[0-9a-f]{12}\.webp$/.test(a.picture)) {
      const img = el("img", "adpic");
      img.alt = "";
      img.loading = "lazy";
      img.src = `/api/control/pinrads/picture?id=${a.picture.slice(0, 12)}`;
      r.append(img);
    } else r.append(el("div", "adpic adnopic", "no picture"));
    const body = el("div", "adbody");
    body.append(el("b", "", `${a.name || "—"}`), el("span", "admeta", `Ad space ${a.slot || "—"} · ${when(a.at)}`));
    let href = null;
    try {
      const u = new URL(String(a.link || ""));
      if (u.protocol === "https:") href = u.href;
    } catch {
      href = null;
    }
    if (href) {
      const l = el("a", "adlink", href);
      l.href = href;
      l.target = "_blank";
      l.rel = "noopener noreferrer nofollow";
      body.append(l);
    } else body.append(el("span", "admeta", a.link ? `link (not https): ${a.link}` : "no link"));
    body.append(el("span", "", `Contact: ${a.contact || "—"}`));
    r.append(body);
    return r;
  }
  async function paint() {
    if (panel.hidden) return;
    const head = el("div", "askhead");
    const close = el("button", "", "close");
    close.onclick = () => (panel.hidden = true);
    head.append(el("b", "", "PINRads applications"), close);
    const note = el("p", "admeta", "Sent from pinr.io's ad spaces. Read-only here: nothing is published, and no reply goes out from this page.");
    let list;
    try {
      const r = await fetch("/api/control/pinrads", { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      const apps = j && Array.isArray(j.applications) ? j.applications : null;
      if (!apps) list = el("p", "admeta", "The applications are not read yet. This page asks again shortly.");
      else if (!apps.length) list = el("p", "admeta", "No applications yet.");
      else {
        list = el("div", "adlist");
        list.append(el("span", "admeta", `${typeof j.total === "number" ? j.total : apps.length} in all; the newest ${apps.length} shown.`), ...apps.map(row));
      }
    } catch {
      list = el("p", "admeta", "The applications are not read yet. This page asks again shortly.");
    }
    if (!panel.hidden) panel.replaceChildren(head, note, list);
  }
  const header = document.querySelector("header");
  if (header) {
    const b = document.createElement("button");
    b.id = "bAds";
    b.textContent = "PINRads";
    b.title = "Ad space applications sent from pinr.io";
    b.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        for (const id of ["routespanel", "logpanel", "keypanel"]) {
          const p = document.getElementById(id);
          if (p) p.hidden = true; // one side panel at a time
        }
        void paint();
      }
    };
    const after = document.getElementById("bKey") || document.getElementById("bLog");
    if (after && after.parentNode === header) after.after(b);
    else header.insertBefore(b, header.querySelector(".sp") || null);
    for (const id of ["bRoutes", "bLog", "bKey"]) {
      const other = document.getElementById(id);
      if (other) other.addEventListener("click", () => (panel.hidden = true));
    }
  }
  setInterval(() => void paint(), EVERY_MS);
})();
