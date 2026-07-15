import { useInput } from "ink";
import { html, Box, Text, useState, useMemo } from "../ink-elements.js";

const VISIBLE_ROWS = 12;

/**
 * Fuzzy-filterable multi-select file list. All key handling lives in one
 * `useInput` (typing filters, ↑/↓ move, Space toggles, Enter confirms, Esc
 * skips) so there is no ambiguity between typing and navigation. Calls
 * `onSubmit(selected)` with repo-relative paths that seed the agent's context.
 */
export default function FilePicker({ files = [], onSubmit, onSkip }) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(() => new Set());

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((f) => f.toLowerCase().includes(needle));
  }, [files, filter]);

  const safeCursor = Math.min(cursor, Math.max(filtered.length - 1, 0));

  useInput((input, key) => {
    if (key.escape) {
      if (onSkip) onSkip();
      return;
    }
    if (key.return) {
      if (onSubmit) onSubmit([...selected]);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (input === " ") {
      const target = filtered[safeCursor];
      if (target) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(target)) next.delete(target);
          else next.add(target);
          return next;
        });
      }
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(VISIBLE_ROWS / 2), Math.max(filtered.length - VISIBLE_ROWS, 0)),
  );
  const windowRows = filtered.slice(start, start + VISIBLE_ROWS);

  return html`
    <${Box} flexDirection="column">
      <${Box}>
        <${Text} color="cyan">Filter: </${Text}>
        <${Text}>${filter || ""}</${Text}><${Text} dimColor>▏</${Text}>
      </${Box}>
      <${Box} flexDirection="column" marginTop=${1}>
        ${windowRows.map((file, i) => {
          const idx = start + i;
          const isCursor = idx === safeCursor;
          const isSelected = selected.has(file);
          return html`<${Text} key=${file} color=${isCursor ? "cyan" : undefined} inverse=${isCursor}>${
            isSelected ? "◉" : "◯"
          } ${file}</${Text}>`;
        })}
        ${filtered.length === 0 ? html`<${Text} dimColor>no matching files</${Text}>` : null}
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>${selected.size} selected · ↑/↓ move · Space toggle · Enter confirm · Esc skip</${Text}>
      </${Box}>
    </${Box}>
  `;
}
