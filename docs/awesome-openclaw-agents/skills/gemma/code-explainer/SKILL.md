---
name: code-explainer
description: Paste any code snippet and get a plain English explanation of what it does and how it works.
---

# Code Explainer

Understand any code instantly. Works with Python, JavaScript, SQL, Bash, TypeScript, Go, and more.

## Examples

* "Explain this Python: def fib(n): return n if n <= 1 else fib(n-1) + fib(n-2)"
* "What does this do: arr.reduce((acc, x) => acc + x, 0)"
* "Explain: SELECT * FROM logs WHERE level = 'error' ORDER BY created_at DESC LIMIT 100"
* "What is this bash script doing: find . -name '*.log' -mtime +7 -delete"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - language: String - the programming language detected (e.g. Python, JavaScript, SQL, Bash)
  - snippet: String - the code snippet, truncated to first 100 characters if longer
  - summary: String - one sentence plain English explanation of what the code does overall
  - how: String - one sentence explaining how it works (the mechanism)
  - tip: String - one practical tip, gotcha, or improvement suggestion for this code
