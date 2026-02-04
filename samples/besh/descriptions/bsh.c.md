---
source: bsh.c
language: c
generatedAt: 2026-02-03T16:58:37.578Z
sha256: 91982899eed621f5a1850d5b09e68b0ee45a34ca5153370e2d448d10c98b0a8a
---

## Overview
# Core Responsibilities
The C core provides a foundational parsing engine, execution environment, and built-in commands. It tokenizes input based on fundamental token types and dynamically populated operator symbols. The parser uses an operator-precedence algorithm guided by BSH-defined properties to evaluate expressions.

## Flow
# Extensibility Mechanisms
BSH scripts define most operator symbols using the defoperator command. Each operator specifies its type, precedence, associativity, and handler function. The C core's tokenizer learns these symbols, and the parser uses them to interpret expressions correctly.

## Signals
# Expression Evaluation
The C function evaluate_expression_from_tokens implements a robust operator-precedence parsing algorithm. It consumes tokens and constructs an implicit evaluation tree, calling BSH handlers as needed for complex, nested expressions with user-defined operators and precedences.
