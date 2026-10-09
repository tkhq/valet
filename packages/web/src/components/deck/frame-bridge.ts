import { cardId } from "~/lib/card-context";

/** Publish only page identity, never chat contents or credentials. */
export function installFrameBridge(onNavigate: (notify: () => void) => () => void): () => void {
  if (!cardId()) return () => {};
  const publish = () => {
    const url = new URL(location.href);
    const pages: Record<string, string> = { events: "Events", workflows: "Automation", memory: "Memory", settings: "Settings", usage: "Usage", skills: "Skills", integrations: "Integrations" };
    const label = pages[url.pathname.split("/")[1] ?? ""];
    const title = label && document.title.split(" · ").length === 2 ? `${label} · ${document.title}` : document.title;
    window.parent.postMessage({ type: "valet:page", url: url.pathname + url.search + url.hash, title }, location.origin);
  };
  const focus = () => window.parent.postMessage({ type: "valet:focus" }, location.origin);
  const title = document.querySelector("title");
  const observer = new MutationObserver(publish);
  if (title) observer.observe(title, { childList: true, subtree: true, characterData: true });
  const unsubscribe = onNavigate(publish);
  document.addEventListener("pointerdown", focus, true);
  document.addEventListener("focusin", focus);
  publish();
  return () => { observer.disconnect(); unsubscribe(); document.removeEventListener("pointerdown", focus, true); document.removeEventListener("focusin", focus); };
}
