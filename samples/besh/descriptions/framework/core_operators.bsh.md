---
source: framework/core_operators.bsh
language: text
generatedAt: 2026-02-03T17:06:33.137Z
sha256: daeec75805cd8ac628d2966fe1b276e5370ce6c3d3598536b50118b96b15c375
---

# Core Operators Framework

This file defines the standard operator symbols and their corresponding BSH handlers. It serves as the central registry for how operators behave in expressions, including precedence, associativity, and handler functions.

## Operator Registration

The framework begins by registering core arithmetic, comparison, and logical operators using the defoperator directive. Each operator is classified by type (unary prefix/postfix, binary infix, ternary primary) and assigned a precedence level to dictate evaluation order. For example:

- Arithmetic operators (*, /, %) are given multiplicative precedence (50), while additive operators (+, -) use precedence 40.
- Unary increment/decrement (++, --) operate at high precedence (60) and are non-associative.
- The ternary operator (?) is right-associative with the lowest precedence (5) to support nested conditions.

## Handler Functions

Each registered operator maps to a handler function that performs the actual operation. Handlers receive operands, execute logic (e.g., bsh_op_add_or_concat checks types before calling string_concat or math_add), and store results in a variable. Key behaviors include:

- **Smart Concatenation**: The + operator dynamically switches between numeric addition and string concatenation based on operand types.
- **Unary Operations**: Increment/decrement handlers modify variables by name, with prefix/postfix variants differing only in timing (pre-increment returns the new value; post-increment returns the old).

## Edge Cases & Assumptions

The file notes potential but unimplemented operators (e.g., unary -, !) and delegates decimal/dot handling to a separate handler (bsh_op_dot_handler). The ternary operator's colon (:) is implicitly managed by the C parser, avoiding redundant registration.

## Integration Points

Handlers rely on external frameworks:
- Type checking via get_type (from type.bsh)
- Numeric operations from number.bsh
- String utilities from string.bsh

This modular design allows operators to be extended or overridden without modifying the core C parser.
