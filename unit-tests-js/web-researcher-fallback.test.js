import test from "node:test";
import assert from "node:assert/strict";
import WebResearcher from "../src/libs/web-researcher.js";

test("WebResearcher falls back to DuckDuckGo HTML parsing when API returns zero results", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.duckduckgo.com")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            Heading: "",
            AbstractURL: "",
            AbstractText: "",
            Results: [],
            RelatedTopics: [],
          };
        },
      };
    }
    if (url.includes("duckduckgo.com/html/")) {
      const html = [
        '<div class="result">',
        '  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Frev-war">American Revolutionary War Timeline</a>',
        '  <div class="result__snippet">Concise timeline with major campaigns and treaty outcomes.</div>',
        "</div>",
      ].join("");
      return {
        ok: true,
        status: 200,
        async text() {
          return html;
        },
      };
    }
    throw new Error(`Unexpected URL in test fetch mock: ${url}`);
  };

  try {
    const researcher = new WebResearcher();
    const report = await researcher.search("American Revolutionary War timeline", {
      provider: "duckduckgo",
      maxResults: 3,
      includeRaw: true,
    });
    assert.ok(calls.some((url) => url.includes("api.duckduckgo.com")));
    assert.ok(calls.some((url) => url.includes("duckduckgo.com/html/")));
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].url, "https://example.org/rev-war");
    assert.match(report.results[0].snippet, /major campaigns/i);
    assert.ok(report.raw?.fallback_payload);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
