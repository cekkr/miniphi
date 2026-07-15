import { useInput } from "ink";
import { html, Text } from "../ink-elements.js";

/**
 * Minimal controlled text input built directly on Ink's `useInput` so we don't
 * depend on an external component that lags Ink's major versions. Only active
 * when `focus` is true; ignores arrow keys so a parent list can own navigation.
 */
export default function TextInput({ value = "", onChange, onSubmit, placeholder = "", focus = true }) {
  useInput(
    (input, key) => {
      if (key.return) {
        if (onSubmit) onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        if (onChange) onChange(value.slice(0, -1));
        return;
      }
      // Ignore control/navigation keys; the parent may handle them.
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || key.escape) {
        return;
      }
      if (key.ctrl || key.meta) {
        return;
      }
      if (input) {
        if (onChange) onChange(value + input);
      }
    },
    { isActive: focus },
  );

  const display = value.length ? value : placeholder;
  const dim = value.length === 0;
  return html`<${Text} dimColor=${dim}>${display}${focus ? "▏" : ""}<//>`;
}
