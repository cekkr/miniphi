// Color + label helpers shared across the MiniPhi UI. Kept tiny and dependency
// free so components stay declarative.

export const BRAND = "miniPhi";

// Maps executor/guard statuses to an Ink color + glyph for the progress log.
export function statusStyle(status) {
  switch (status) {
    case "written":
    case "executed":
    case "completed":
      return { color: "green", glyph: "✔" };
    case "unchanged":
      return { color: "gray", glyph: "=" };
    case "rejected":
      return { color: "yellow", glyph: "✖" };
    case "deferred-command":
      return { color: "yellow", glyph: "⏸" };
    case "hash-mismatch":
    case "anchor-not-found":
    case "anchor-ambiguous":
    case "missing-file":
    case "invalid":
    case "failed":
      return { color: "red", glyph: "!" };
    default:
      return { color: "white", glyph: "•" };
  }
}

export function dangerColor(danger) {
  if (danger === "high") return "red";
  if (danger === "low") return "green";
  return "yellow";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinnerFrame(tick) {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

// Splits a summarizeDiff() block into rows the modal can color line-by-line.
export function diffRows(diff) {
  if (!diff || typeof diff !== "string") {
    return [];
  }
  return diff.split(/\r?\n/).map((line) => {
    if (line.startsWith("+")) return { line, color: "green" };
    if (line.startsWith("-")) return { line, color: "red" };
    return { line, color: "gray" };
  });
}
