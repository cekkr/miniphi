---
source: examples/enhancedNumbers.bsh
language: text
generatedAt: 2026-02-03T17:02:11.227Z
sha256: b0ac380b4947c0ced672f2fe4befdb800f86abc40298750c3517dc24b75a53c1
---

# Overview
The script demonstrates enhanced numeric handling in B[e]SH, showcasing improved tokenizer support for unquoted numbers (integers and floats), including negative values.

## Numeric Operations
Arithmetic operations (addition, subtraction, multiplication, division, modulus) are performed using variables initialized with raw numbers. The tokenizer now correctly interprets -5 or 10.5 as single numeric tokens without quotes.

## Comparisons and Conditionals
Comparison operators (math_gt, math_lt) evaluate conditions dynamically. Negative values (e.g., -10) are handled natively, enabling direct comparisons like $neg_val < 0.

## String Context
String operations remain largely unchanged but include numeric literals in examples (e.g., -5 and 10.5 in a sentence). Direct character access and splitting demonstrate mixed-type data handling.

## Edge Cases
Direct function calls with unquoted numbers (e.g., math_add -15 2.5) validate tokenizer robustness. Quotes are still required for strings with spaces or special characters.
