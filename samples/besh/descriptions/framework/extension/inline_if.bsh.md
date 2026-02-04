---
source: framework/extension/inline_if.bsh
language: text
generatedAt: 2026-02-03T17:08:05.841Z
sha256: c9392be17ce70ed19ea3bc31bcb5b1c271ff3b18093f199e06b984227ccadc3a
---

## Overview
# Overview
The inline_if.bsh extension introduces a ternary-like conditional assignment mechanism to the B[e]SH shell. It allows scripts to assign values based on a condition without traditional if-else blocks.

## Flow
# Functionality
The iif function takes four arguments: a condition result, two possible values (one for true, one for false), and a variable name to store the outcome. Internally, it checks if the condition evaluates to '1' or 'true', then assigns the corresponding value to the specified variable.

## Signals
# Edge Cases
The function handles string comparisons strictly ('1' or 'true') and does not support complex expressions directly. It relies on the caller to provide a pre-evaluated condition result.
