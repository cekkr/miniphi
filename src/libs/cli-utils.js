export function parseNumericSetting(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${label} expects a finite number.`);
  }
  return numeric;
}

export function resolveDurationMs({
  secondsValue,
  secondsLabel = "duration (seconds)",
  millisValue,
  millisLabel = "duration (milliseconds)",
} = {}) {
  if (secondsValue !== undefined && secondsValue !== null && secondsValue !== "") {
    const seconds = parseNumericSetting(secondsValue, secondsLabel);
    if (seconds !== undefined) {
      if (seconds <= 0) {
        throw new Error(`${secondsLabel} expects a positive number of seconds.`);
      }
      return seconds * 1000;
    }
  }
  if (millisValue !== undefined && millisValue !== null && millisValue !== "") {
    const millis = parseNumericSetting(millisValue, millisLabel);
    if (millis !== undefined) {
      if (millis <= 0) {
        throw new Error(`${millisLabel} expects a positive number of milliseconds.`);
      }
      return millis;
    }
  }
  return undefined;
}
