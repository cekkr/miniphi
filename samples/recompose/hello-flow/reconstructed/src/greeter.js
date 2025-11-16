// src/greeter.js

function normalizeName(name) {
  // If no name is provided, or it's null/undefined, default to "friend"
  if (name == null) return "friend";
  
  // Convert any non-string input into a string (if needed)
  name = String(name);
  
  // Remove leading/trailing whitespace
  const trimmed = name.trim();
  
  // If the result is empty after trimming, use the fallback name
  return trimmed === "" ? "friend" : trimmed;
}

function greet(name) {
  const cleanedName = normalizeName(name);
  return `Hello, ${cleanedName}!`;
}

function farewell(name) {
  const cleanedName = normalizeName(name);
  return `Goodbye, ${cleanedName}. Keep building!`;
}

module.exports = { greet, farewell };
