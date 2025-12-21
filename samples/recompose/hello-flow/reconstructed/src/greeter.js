import { write as loggerWrite } from './logger.js';
function sanitizeName(name) {
  if (name == null) return 'Guest';
  return String(name).trim();
}
export function greet(name, context = {}) {
  const sanitized = sanitizeName(name);
  const message = `Hello, ${sanitized}!`;
  loggerWrite({ type: 'greet', name: sanitized, ...context });
  return message;
}
export function farewell(name, context = {}) {
  const sanitized = sanitizeName(name);
  const message = `Goodbye, ${sanitized}!`;
  loggerWrite({ type: 'farewell', name: sanitized, ...context });
  return message;
}
