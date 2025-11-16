// math.js

/**
 * Converts a value to a number.
 * If conversion fails (i.e., the result is NaN), returns 0.
 *
 * @param {*} value - The input value.
 * @returns {number} - A numeric representation of the value, or 0 if invalid.
 */
function safeNumber(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Calculates the average of an array of numerical values.
 *
 * Behavior:
 * - Validates that the input is a non-empty array; returns 0 for invalid or empty inputs.
 * - Iterates through each element, converting it to a number (defaulting invalid entries to 0).
 * - Sums all converted numbers and computes their average.
 * - Rounds the result to two decimal places before returning.
 *
 * @param {*} data - An array of values intended as numerical data.
 * @returns {number} - The computed average rounded to two decimals, or 0 for invalid input.
 */
function calculateAverage(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return 0;
  }

  let sum = 0;

  // Process each element by converting it to a number (defaulting to 0 on failure)
  for (let i = 0; i < data.length; i++) {
    sum += safeNumber(data[i]);
  }

  const count = data.length;
  const avg = sum / count;

  // Round the average to two decimal places
  return Math.round(avg * 100) / 100;
}

/**
 * Describes the trend based on the first and last elements of an array.
 *
 * Behavior:
 * - Validates that the input is an array with at least two elements; returns "insufficient-data" otherwise.
 * - Extracts the first and last values (after conversion to numbers).
 * - Returns:
 *   • "flat" if the first and last are equal,
 *   • "upward" if the last value is greater than the first,
 *   • "downward" if the last value is less than the first.
 *
 * @param {*} data - An array of numerical values.
 * @returns {string|boolean} - A string indicating the trend ("flat", "upward", or "downward"),
 *                             or "insufficient-data" if input validation fails.
 */
function describeTrend(data) {
  if (!Array.isArray(data) || data.length < 2) {
    return "insufficient-data";
  }

  const first = safeNumber(data[0]);
  const last = safeNumber(data[data.length - 1]);

  if (first === last) {
    return "flat";
  } else if (last > first) {
    return "upward";
  } else {
    return "downward";
  }
}

module.exports = { calculateAverage, describeTrend };
