/*
 * math.js
 * A utility module for numerical data processing.
 * Provides functions to compute an average from a list of numbers,
 * and describe whether the trend is upward, downward, or flat.
 */

/**
 * Attempts to safely convert a value to a number.
 * If conversion fails (i.e. result is NaN), returns 0.
 *
 * @param {*} value - The input element.
 * @returns {number} The numeric representation of the value, or 0 if conversion fails.
 */
function safeConvert(value) {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Rounds a number to two decimal places and returns it as a floating-point number.
 *
 * @param {number} num - The number to round.
 * @returns {number} The rounded number.
 */
function roundToTwo(num) {
  // toFixed returns a string, so we convert it back to a number.
  return parseFloat(num.toFixed(2));
}

/**
 * Calculates the average of an array of values.
 *
 * Behavior:
 * - If the input is not an array or if the array is empty, returns 0.
 * - Each element is converted using safeConvert. Non-numeric elements are treated as 0.
 * - The computed average is rounded to two decimal places.
 *
 * @param {Array} values - Array of numeric (or convertible) values.
 * @returns {number} The rounded average.
 */
function average(values) {
  // Validate input: must be an array and not empty.
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  let total = 0;

  for (let i = 0; i < values.length; i++) {
    total += safeConvert(values[i]);
  }

  const avg = total / values.length;
  return roundToTwo(avg);
}

/**
 * Describes the trend of a data array.
 *
 * Behavior:
 * - If input is not an array or if the array has fewer than two elements,
 *   returns "Insufficient data for trend analysis."
 * - The first and last elements (after conversion) are compared.
 *   - Returns "flat" if they are equal.
 *   - Returns "upward" if the last value exceeds the first.
 *   - Returns "downward" otherwise.
 *
 * @param {Array} data - Array of numeric (or convertible) values.
 * @returns {string} A description of the trend ("upward", "downward", or "flat").
 */
function describeTrend(data) {
  // Validate input: must be an array with at least two elements.
  if (!Array.isArray(data)) {
    return "Insufficient data for trend analysis.";
  }
  if (data.length < 2) {
    return "Insufficient data for trend analysis.";
  }

  const first = safeConvert(data[0]);
  const last = safeConvert(data[data.length - 1]);

  if (first === last) {
    return "flat";
  } else if (last > first) {
    return "upward";
  } else {
    return "downward";
  }
}

// Export functions for module usage.
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = { average, describeTrend };
} else {
  // Attach to window if running in a browser environment.
  window.mathUtils = { average, describeTrend };
}
