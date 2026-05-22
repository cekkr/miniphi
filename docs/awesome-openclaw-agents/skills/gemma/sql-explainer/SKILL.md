---
name: sql-explainer
description: Paste a SQL query and get a plain English explanation of what it does.
---

# SQL Explainer

Turn any SQL query into a clear, plain English breakdown. No database knowledge required.

## Examples

* "SELECT * FROM users WHERE created_at > NOW() - INTERVAL 7 DAY"
* "Explain: SELECT p.name, COUNT(o.id) FROM products p LEFT JOIN orders o ON p.id = o.product_id GROUP BY p.id"
* "What does this do: DELETE FROM sessions WHERE expires_at < NOW()"
* "EXPLAIN SELECT u.email, SUM(o.total) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.id HAVING SUM(o.total) > 1000"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - query: String - the SQL query (truncate to first 120 characters if longer)
  - summary: String - one sentence plain English summary of what the query does
  - step1: String - first thing the query does (short phrase)
  - step2: String - second thing the query does (short phrase)
  - step3: String - third thing the query does, or empty string if not applicable
  - tip: String - one useful tip or potential issue to watch out for with this query
