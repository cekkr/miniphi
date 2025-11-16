"use strict";

/**
 * Helper function to sanitize the input name.
 * Converts the input to a string, trims whitespace,
 * and defaults to "friend" if the result is empty or invalid.
 *
 * @param {any} name - The input name which may be undefined, null, or contain extra spaces.
 * @returns {string} A sanitized name or "friend" if none was valid.
 */
function sanitizeName(name) {
  try {
    const cleaned = String(name).trim();
    return cleaned === "" ? "friend" : cleaned;
  } catch (error) {
    console.error("Error sanitizing name:", error);
    return "friend";
  }
}

/**
 * Constructs a greeting message using the sanitized name.
 *
 * @param {string} sanitizedName - The cleaned-up user name.
 * @returns {string} A friendly greeting message.
 */
function formatGreeting(sanitizedName) {
  return `Hello, ${sanitizedName}`;
}

/**
 * Constructs a farewell message using the sanitized name.
 *
 * @param {string} sanitizedName - The cleaned-up user name.
 * @returns {string} A polite parting message with an encouraging note.
 */
function formatFarewell(sanitizedName) {
  return `Goodbye, ${sanitizedName}. Keep building!`;
}

/**
 * Generates a greeting message for the provided name.
 *
 * If no valid name is provided, defaults to "friend".
 *
 * @param {any} name - The user's name or invalid input.
 * @returns {string} A greeting message like "Hello, John" or default if necessary.
 */
function greet(name) {
  try {
    const sanitized = sanitizeName(name);
    return formatGreeting(sanitized);
  } catch (error) {
    console.error("Error generating greeting:", error);
    return "Hello, friend";
  }
}

/**
 * Generates a farewell message for the provided name.
 *
 * If no valid name is provided, defaults to "friend".
 *
 * @param {any} name - The user's name or invalid input.
 * @returns {string} A farewell message like "Goodbye, John. Keep building!" or default if necessary.
 */
function farewell(name) {
  try {
    const sanitized = sanitizeName(name);
    return formatFarewell(sanitized);
  } catch (error) {
    console.error("Error generating farewell:", error);
    return "Goodbye, friend. Keep building!";
  }
}

module.exports = { greet, farewell };
