/**
 * The Whitepaper page: a full page over the view, opened ONLY from the Whitepaper symbol in the header (it is not on
 * the site map and not in the menu). Same black glass as Settings. The text is not written yet, so it says so.
 */
export interface Whitepaper {
  el: HTMLElement;
  show(on: boolean): void;
  isOpen(): boolean;
}

export function createWhitepaper(onClose: () => void): Whitepaper {
  const root = document.createElement("div");
  root.id = "paperpage";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Whitepaper");
  root.innerHTML = `
    <div class="sscroll">
      <div class="stop">
        <button class="sback" type="button" aria-label="Close whitepaper">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
        </button>
        <h1 class="stitle">Whitepaper</h1>
      </div>
      <section class="ssec">
        <div class="scard wpcard">
          <svg class="wpicon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>
          <div class="wpsoon">Coming soon</div>
        </div>
        <p class="snote">The PINR whitepaper will be read here.</p>
      </section>
    </div>`;
  root.querySelector(".sback")!.addEventListener("click", onClose);
  document.body.append(root);
  let open = false;
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) onClose();
  });
  return {
    el: root,
    show(on) {
      open = on;
      root.classList.toggle("on", on);
      if (on) root.querySelector(".sscroll")!.scrollTop = 0;
    },
    isOpen: () => open,
  };
}
