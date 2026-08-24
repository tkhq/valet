/**
 * See docs on injectDeckRuntime below. Kept out of the canvas path —
 * only exports/downloads (real browsers) ever receive this script.
 */
/**
 * Standalone deck viewer injected into slides HTML exports and downloads: one slide
 * at a time on a scaled 1920×1080 stage, arrow/space/page-key navigation,
 * an s-key speaker-notes toggle, and a slide counter.
 */
export function injectDeckRuntime(dcHtml: string): string {
  const runtime = `
<style id="vd-deck-style">
  /* Print: every slide, one per page, at stage size — File > Print >
     Save as PDF is the no-Chromium PDF path. */
  @page { size: 1920px 1080px; margin: 0; }
  @media print {
    html, body { background: #fff; }
    .vd-deck-stage { position: static; display: block; }
    .vd-deck-stage > section {
      display: block !important;
      transform: none !important;
      page-break-after: always;
      break-after: page;
    }
    .vd-deck-counter, .vd-deck-notes { display: none !important; }
  }
  html, body { margin: 0; height: 100%; background: #111; }
  .vd-deck-stage { position: fixed; inset: 0; display: grid; place-items: center; }
  .vd-deck-stage > section { width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; flex-shrink: 0; }
  .vd-deck-counter { position: fixed; right: 16px; bottom: 12px; color: #888; font: 13px/1 system-ui, sans-serif; z-index: 10; }
  .vd-deck-notes { position: fixed; left: 16px; right: 16px; bottom: 40px; max-height: 30vh; overflow: auto; background: rgba(0,0,0,0.85); color: #eee; font: 14px/1.5 system-ui, sans-serif; padding: 12px 16px; border-radius: 8px; display: none; z-index: 10; white-space: pre-wrap; }
</style>
<script id="vd-deck-runtime">
(function () {
  var all = Array.prototype.slice.call(document.querySelectorAll("section"));
  var slides = all.filter(function (s) { return !(s.parentElement && s.parentElement.closest("section")); });
  if (slides.length === 0) return;
  var stage = document.createElement("div");
  stage.className = "vd-deck-stage";
  document.body.appendChild(stage);
  slides.forEach(function (s) { stage.appendChild(s); });
  var counter = document.createElement("div");
  counter.className = "vd-deck-counter";
  var notes = document.createElement("div");
  notes.className = "vd-deck-notes";
  document.body.appendChild(counter);
  document.body.appendChild(notes);
  var i = 0, showNotes = false;
  function fit() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    slides.forEach(function (s) { s.style.transform = "scale(" + scale + ")"; });
  }
  function render() {
    slides.forEach(function (s, k) {
      s.style.display = k === i ? "block" : "none";
      s.style.opacity = "1";
      s.style.visibility = "visible";
      s.style.position = "relative";
    });
    counter.textContent = (i + 1) + " / " + slides.length + "  (arrows to navigate, s = notes)";
    var s = slides[i];
    var aside = s.querySelector("aside");
    var text = s.getAttribute("data-speaker-notes") || (aside ? aside.textContent : "") || "No notes.";
    notes.textContent = text;
    notes.style.display = showNotes ? "block" : "none";
  }
  window.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { i = Math.min(slides.length - 1, i + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { i = Math.max(0, i - 1); render(); e.preventDefault(); }
    else if (e.key === "s" || e.key === "S") { showNotes = !showNotes; render(); }
  });
  window.addEventListener("resize", fit);
  fit();
  render();
  // Print view (?vd-print=1, served inline by the download route): open
  // the browser's print dialog once the deck is laid out — Save as PDF
  // is the instant, full-fidelity PDF path.
  if (/[?&]vd-print=1/.test(window.location.search)) {
    window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 400); });
  }
})();
</script>`;
  const close = dcHtml.lastIndexOf("</body>");
  return close >= 0
    ? `${dcHtml.slice(0, close)}${runtime}\n${dcHtml.slice(close)}`
    : `${dcHtml}\n${runtime}`;
}
