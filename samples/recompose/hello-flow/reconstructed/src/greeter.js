export function greet(name) {
  const target = (name ?? "friend").trim() || "friend";
  return `Hello, ${target}!`;
}

export function farewell(name) {
  const target = (name ?? "friend").trim() || "friend";
  return `Goodbye, ${target}. Keep building!`;
}
