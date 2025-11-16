(function(exports) {
  "use strict";

  // Helper: Convert an item to a finite number.
  // Returns an object { success: true, value } if conversion succeeds,
  // or { success: false, reason } with a descriptive error message.
  function tryConvert(item, index) {
    var num = Number(item);
    if (Number.isFinite(num)) {
      return { success: true, value: num };
    } else {
      return { 
        success: false,
        reason: "Value '" + item + "' at index " + index + " is not a finite number."
      };
    }
  }

  // The main validation routine.
  function validate(dataList, logger) {

    var errors = [];

    // Local helper to log messages if logger is provided and valid.
    function log(msg) {
      if (typeof logger === 'function') {
        try {
          logger(msg);
        } catch(e) {}
      }
    }

    // Step 1: Input Type Check
    if (!Array.isArray(dataList)) {
      var error = "Input data is not an array.";
      log("ERROR: " + error);
      errors.push(error);
      return { normalized: [], errors: errors };
    }

    var validNumbers = [];

    // Step 2: Element-by-Element Processing
    for (var i = 0; i < dataList.length; i++) {
      var result = tryConvert(dataList[i], i);
      if (!result.success) {
        log("ERROR: " + result.reason);
        errors.push(result.reason);
      } else {
        validNumbers.push(result.value);
      }
    }

    // Step 3: Counting Valid Samples
    if (validNumbers.length < 3) {
      var insufficientError = "Insufficient valid numeric samples. Expected at least 3.";
      log("ERROR: " + insufficientError);
      errors.push(insufficientError);
      return { normalized: [], errors: errors };
    }

    // Step 4: Sorting and Variability Check
    validNumbers.sort(function(a, b) {
      return a - b;
    });
    if (validNumbers[0] === validNumbers[validNumbers.length - 1]) {
      var variabilityError = "Lack of variability; all samples are identical.";
      log("ERROR: " + variabilityError);
      errors.push(variabilityError);
      return { normalized: [], errors: errors };
    }

    // Step 5: Statistical Analysis and Formatting
    var minVal = validNumbers[0];
    var maxVal = validNumbers[validNumbers.length - 1];

    function formatNumber(num) {
      return parseFloat(num.toFixed(4));
    }
    var normalized = validNumbers.map(formatNumber);

    // Step 6: Logging Success and Returning Object
    log("SUCCESS: Validation succeeded with " + validNumbers.length + " samples, min: " + minVal + ", max: " + maxVal);
    return {
      normalized: normalized,
      statistics: {
        min: minVal,
        max: maxVal
      }
    };
  }

  // Export the validate function according to environment.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = validate;
  } else {
    exports.validate = validate;
  }

})(this);
