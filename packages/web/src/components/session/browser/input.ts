import type { BrowserHumanInput } from "@valet/shared";

export function browserPoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return null;
  const scale = Math.min(
    bounds.width / viewport.width,
    bounds.height / viewport.height,
  );
  const x =
    (clientX - bounds.left - (bounds.width - viewport.width * scale) / 2) /
    scale;
  const y =
    (clientY - bounds.top - (bounds.height - viewport.height * scale) / 2) /
    scale;
  return x >= 0 && y >= 0 && x < viewport.width && y < viewport.height
    ? { x, y }
    : null;
}

export function browserWheel(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  height: number,
): BrowserHumanInput {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  return { type: "wheel", deltaX: deltaX * unit, deltaY: deltaY * unit };
}

export function browserKey(event: {
  key: string;
  isComposing: boolean;
}): string | null {
  if (
    event.isComposing ||
    ["Process", "Dead", "Unidentified"].includes(event.key)
  )
    return null;
  return event.key === " " ? "Space" : event.key;
}

export function normalizeBrowserAddress(address: string): string {
  const value = address.trim();
  if (value === "about:blank") return value;
  const url = new URL(
    /^[a-z][a-z\d+.-]*:/i.test(value) && !/^localhost:\d+/i.test(value)
      ? value
      : `https://${value}`,
  );
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Use an HTTP or HTTPS address.");
  return url.href;
}
