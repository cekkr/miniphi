---
source: framework/number.bsh
language: text
generatedAt: 2026-02-03T17:09:27.342Z
sha256: be6f8ecc2beec7f1f45fa5d6ec024d0b3962a2ed28c47cc441e9062694ccba51
---

# Number Framework Overview
The number.bsh framework extends B[e]SH with mathematical operations and comparisons. It acts as a bridge between shell scripts and the C-based math library (bshmath).

## Core Functionality
The module provides arithmetic functions (add, subtract, multiply, divide, modulo) and comparison operators (equal, not equal, greater than, less than, etc.). Each function delegates to the C library via calllib.

## Error Handling
If a C library call fails, the framework sets a default error value (e.g., MATH_OP_ERROR for math ops, 0 for comparisons). Errors are logged but do not halt execution.

## Unary Operators
The module implements increment/decrement operators (prefix/postfix) by manipulating variable values and storing original/updated values in result holders. These rely on the binary add/subtract functions internally.

## Integration Points
- Core operators in core_operators.bsh map symbols (+, -, etc.) to these handlers.
- The math library alias (BSH_MATH_LIB_ALIAS) is configurable at the top of the file.
