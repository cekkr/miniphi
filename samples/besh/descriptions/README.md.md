---
source: README.md
language: markdown
generatedAt: 2026-02-03T17:16:52.095Z
sha256: f44c427065bc222128346b218b98fd9edf6a5646da2a20e1dde535f0b87136c1
---

# Basic [extensible] Shell (B[e]SH)

![BeSH guy](https://github.com/cekkr/besh/blob/main/assets/eGuy.png?raw=true)

# Research Exploration

## Overview

Welcome to the repository for the Basic [extensible] Shell, or B[e]SH. This project represents an ongoing research endeavor into the design and implementation of a minimalist Unix-like shell with a strong emphasis on runtime extensibility. As a computer engineer and researcher, my primary goal with B[e]SH is not to replace existing mature shells, but rather to create a lightweight, understandable, and highly adaptable environment for exploring core shell concepts, scripting paradigms, and the practicalities of dynamic syntax extension.

B[e]SH is built upon a foundation of simplicity: variables are treated uniformly as strings, control flow mechanisms are intentionally kept straightforward, and the core set of built-in commands is minimal. The true power and research interest lie in its extensibility features, primarily through its defunc mechanism for user-defined functions (macros) and a conceptual framework for integrating external C libraries.

## Core Philosophy and Design

The design of B[e]SH is guided by several key principles:

- **Minimalist Core:** The shell's internal C codebase provides essential functionalities: command execution via PATH resolution, variable assignment (including capturing command output), if/else conditional statements, while loops, and rudimentary array support (via name mangling).
- **Runtime Extensibility via defunc:** The cornerstone of B[e]SH's extensibility is the defunc command. This allows users to define new commands and syntactic sugar directly within the shell at runtime. These "functions" are essentially macros that can encapsulate sequences of commands, effectively allowing the user to mold the shell's language to their specific needs or to prototype new control structures.
- **String-Centric Data Model:** All variables and command outputs are handled as strings. While this simplifies the core, it places the onus of numerical or type-specific operations on external utilities or user-defined functions that can parse and process these strings accordingly. Built-in inc and dec commands offer basic integer arithmetic on string-represented numbers.
- **Conceptual Dynamic Library Integration:** B[e]SH includes experimental support for loading and calling functions from external shared libraries (.so files) using loadlib and calllib. This feature, while rudimentary in its current form concerning ABI complexities, opens avenues for extending the shell with high-performance C functions without modifying the core shell binary.

## Delving Deeper: Extensibility and Operational Model

To fully appreciate B[e]SH's design, let's explore its key operational aspects in more detail:

### 1. Crafting Syntax: The Power of defunc

The defunc command is B[e]SH's primary mechanism for runtime syntax extension. It operates as a sophisticated macro system, allowing users to define new command-like constructs. When a user-defined function is called:

1. Arguments passed to the function are made available as local variables within the function's scope (shadowing any global variables with the same name).
2. The sequence of commands stored in the function's body is then executed by the shell's main processing loop.

This mechanism enables users to:

- **Abstract Complexity:** Encapsulate frequently used command sequences into a single, new command.
- **Prototype New Control Structures:** As demonstrated in example.bsh with for_to_step, users can build more complex control flow logic (like custom loops) on top of the shell's primitives (while, if). For instance, one could define a repeat <N> <command_string> function that executes <command_string> N times.
- **Introduce Domain-Specific Keywords:** If working in a particular problem domain, users can define functions that act as keywords relevant to that domain, making scripts more readable and expressive.

Consider a hypothetical assert_equals <val1> <val2> "message" function:

> [omitted 5 lines of code]


This assert_equals then becomes a new "command" available in the shell session, extending its vocabulary.

### 2. Variable Management: A String-Centric World

B[e]SH's variable system is intentionally simple and revolves entirely around strings:

- **Storage:** All variables, regardless of their conceptual "type" (number, path, boolean-like string), are stored internally as null-terminated character arrays.
- **Assignment:**
  - $var = "some string": Assigns a literal string.
  - $var = external_command --arg: Executes external_command, captures its standard output (stdout), and assigns this output (as a string, typically with newlines trimmed) to $var.
- **Expansion:** The $ prefix is used for variable expansion (e.g., echo $var). The shell also supports ${var} for clarity in ambiguous contexts. Array elements are accessed using a mangled name internally (e.g., $myArray[idx] becomes a lookup for a variable like myArray_ARRAYIDX_some_idx_value).

### Manipulation:
- Built-in commands like inc <varname> and dec <varname> attempt to interpret the variable's string value as an integer, perform the arithmetic, and store the result back as a string.
- More complex string manipulations (substrings, concatenation beyond simple echo $var1$var2, pattern matching) would typically be delegated to external utilities (like awk, sed, or a custom tool) whose output can then be captured.

### 3. Type Agnosticism: User-Driven Interpretation

A direct consequence of the string-centric model is that B[e]SH is fundamentally type-agnostic at its core. It does not perform implicit type conversions or maintain type information for variables.

**No Built-in Types:** There are no distinct integer, float, or boolean types within the shell itself. A variable $num holding "123" is simply a string; $flag holding
