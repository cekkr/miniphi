---
source: examples/strNumExamples.bsh
language: text
generatedAt: 2026-02-03T17:03:36.558Z
sha256: 22199aee455553c6d811aa690720ecef745b40636d50436bc730ccbc26f8ed54
---

# Overview
This script demonstrates the number.bsh and string.bsh libraries by performing arithmetic operations, comparisons, and string manipulations.

## Numeric Operations
The script initializes numeric variables and performs basic arithmetic (addition, subtraction, multiplication, division, modulus). It also handles floating-point numbers and checks for integer/float types. Comparisons use operators like greater than (math_gt), equal to (math_eq), and less than or equal to (math_le).

## Conditional Logic
Conditionals are tested using if statements with negation via the logical NOT operator (!). The script verifies boolean outcomes (1 for true, 0 for false) and demonstrates type checking for integers and floats.

## String Manipulations
String operations include length calculation (string_len), equality checks (string_eq, string_ne), concatenation (string_concat), and character access by index (string_char_at_index). The script also shows direct character access syntax ($string[index]) with variable indices.

## Edge Cases
Out-of-bounds character access returns an empty string. String splitting (commented out) would parse delimited data, though the delimiter variable is defined but not used in the provided snippet.
