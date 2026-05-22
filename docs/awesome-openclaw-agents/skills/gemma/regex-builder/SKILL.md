---
name: regex-builder
description: Describe a text pattern in plain English and get a working regular expression with an explanation.
---

# Regex Builder

Turn plain English into a working regex. No regex knowledge required.

## Examples

* "Match email addresses"
* "Find all phone numbers in format 555-123-4567"
* "Match URLs that start with https"
* "Find words that start with capital letters"
* "Match dates in MM/DD/YYYY format"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - description: String - the plain English description of the pattern
  - regex: String - the regular expression pattern (without surrounding slashes)
  - flags: String - regex flags like g, i, m (or empty string)
  - explanation: String - plain English explanation of how the regex works
  - example_match: String - one example string that this regex would match
  - example_no_match: String - one example string that this regex would NOT match
