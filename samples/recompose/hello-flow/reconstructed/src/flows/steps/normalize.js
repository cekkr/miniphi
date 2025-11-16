"use strict";

/**
 * Normalizes an input array of numbers into the [0, 1] range.
 *
 * The function performs the following steps:
 *   1. Validates that the input is an array containing at least one finite number.
 *      If validation fails (e.g., empty or non-array input), returns a default
 *      output with an empty normalized list and statistics all set to zero.
 *   2. Computes key statistical values from the original data:
 *        - Minimum value (originalMin)
 *        - Maximum value (originalMax)
 *        - Spread calculated as (originalMax - originalMin). If spread is zero,
 *          a fallback divisor of one is used to prevent division errors.
 *   3. Normalizes each number by subtracting the minimum and dividing by the spread,
 *      rounding the result to four decimal places.
 *   4. Calculates the "center" or average value from the normalized numbers.
 *   5. Logs a success message along with all key computed statistics using the provided
 *      logging tool, if available. If the logger does not support the expected interface,
 *      logs a warning to console.warn.
 *
 * @param {Array<number>} numbers - The input array of numbers to be normalized.
 * @param {Object} logger - A logging utility with an info() method (and optionally warn()).
 * @returns {{
 *   normalized: Array<number>,
 *   stats: {
 *     min: number,
 *     max: number,
 *     spread: number,
 *     center: number
 *   }
 * }}
 */
function normalize(numbers, logger) {
  // Input Validation
  if (!Array.isArray(numbers) || numbers.length === 0) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn("Normalization aborted: Invalid or empty input provided. Returning safe defaults.");
    }
    return { normalized: [], stats: { min: 0, max: 0, spread: 0, center: 0 } };
  }

  // Ensure every element is a finite number
  for (let i = 0; i < numbers.length; i++) {
    let value = numbers[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn("Normalization aborted: Non-numeric value detected. Returning safe defaults.");
      }
      return { normalized: [], stats: { min: 0, max: 0, spread: 0, center: 0 } };
    }
  }

  // Statistical Computations
  const originalMin = Math.min(...numbers);
  const originalMax = Math.max(...numbers);
  let spread = originalMax - originalMin;
  
  // Division by Zero safeguard: if the spread is zero, use a fallback divisor of one.
  if (spread === 0) {
    spread = 1;
  }

  // Normalization Process: scale each number into the [0, 1] range with four decimal precision
  const normalizedList = numbers.map(num => {
    const normalizedValue = (num - originalMin) / spread;
    return parseFloat(normalizedValue.toFixed(4));
  });

  // Central Tendency Calculation: compute the average of the normalized values
  const sum = normalizedList.reduce((acc, value) => acc + value, 0);
  let center = sum / normalizedList.length;
  center = parseFloat(center.toFixed(4));

  // Logging the process and statistics using the provided logger
  if (logger && typeof logger.info === 'function') {
    logger.info("Normalization completed successfully.");
    logger.info(`Statistics: min=${originalMin}, max=${originalMax}, spread=${spread}, center=${center}`);
  } else if (logger) {
    console.warn("Logger provided does not support the expected interface. Logging skipped.");
  }

  // Return both the normalized list and the statistics summary
  return { normalized: normalizedList, stats: { min: originalMin, max: originalMax, spread, center } };
}

module.exports = { normalize };
