import { createHash } from "node:crypto";

export function graphName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

export function graphEntityId(name) {
  return `knowledge:${createHash("sha256").update(graphName(name)).digest("hex")}`;
}

export function containsGraphName(text, name) {
  const haystack = graphName(text), needle = graphName(name);
  if (!needle) return false;
  let offset = haystack.indexOf(needle);
  while (offset >= 0) {
    if (!/[\p{L}\p{N}]/u.test(haystack[offset - 1] ?? "") && !/[\p{L}\p{N}]/u.test(haystack[offset + needle.length] ?? "")) return true;
    offset = haystack.indexOf(needle, offset + 1);
  }
  return false;
}
