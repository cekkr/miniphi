---
source: framework/extension/property_squares.bsh
language: text
generatedAt: 2026-02-03T17:08:39.642Z
sha256: 2b0068843b27f9abc25bf90ce3f7629194f11e37b8b1b9dfecb8918ee1447b13
---

# Overview
The script simulates square bracket property access for objects in the B[e]SH shell. It provides two core functions to get and set properties dynamically using mangled variable names.

## Core Functions
- get_element retrieves a property by combining an object base name with a key, then storing the result in a specified variable.
- set_element sets a property similarly, ensuring the object type is initialized if not already defined.

## Data Flow
Properties are accessed via mangled names (e.g., object_key), allowing dynamic property manipulation without hardcoded variables. Debug echoes are commented out but can be enabled for troubleshooting.

## Edge Cases
- If an object's type variable is unset, it defaults to BSH_OBJECT_ROOT.
- No explicit error handling exists; invalid keys silently return empty values.
