---
source: framework/string.bsh
language: text
generatedAt: 2026-02-03T17:10:41.493Z
sha256: 3c1fd6ebd2b709dee6fc6d4dccc0caeced4e1288302688dcdece125ed7a2d3ac
---

# String Framework Overview
The string framework (string.bsh) extends the B[e]SH shell with string manipulation utilities. It relies on a C library (BSH_STRING_LIB_ALIAS) for core operations but includes fallback logic when the library is unavailable.

## Core Functionality
The framework provides functions for string comparison, concatenation, character extraction, splitting, and length calculation. Each function checks if the C library is loaded before proceeding, ensuring graceful degradation.

### String Comparison
- string_eq and string_ne compare strings using the C library's bsh_string_is_equal and bsh_string_is_not_equal functions. If the library fails, they return a default value (0).

### Concatenation
- The string_concat function attempts to use the C library for concatenation but falls back to pure BSH string interpolation if the library is unavailable.

### Character and Substring Operations
- string_char_at_index retrieves a character at a specified index using the C library. If the library fails, it returns an empty string.

### String Splitting
- The framework supports splitting strings into arrays using delimiters. It calculates the number of parts (_string_split_count) and retrieves each part (_string_split_get_part). If the library is unavailable, it sets the array count to 0.

### Length Calculation
- string_len returns the length of a string via the C library. On failure, it returns -1.

## Error Handling
The framework checks for the presence of the C library (is_string_lib_loaded) before executing operations. If the library is unavailable or fails, functions return default values (e.g., 0, empty string, -1). Errors are logged but do not halt execution.

## Integration
The framework integrates with B[e]SH's operator system. For example, the + operator uses string_concat for concatenation when operands are strings. Other operators (e.g., ==) rely on type checking in core_operators.bsh.
