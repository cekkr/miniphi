import { randomUUID } from "crypto";

const DEFAULT_PROVIDER = "duckduckgo";
const DEFAULT_MAX_RESULTS = 6;

export default class WebResearcher {
  constructor(options = {}) {
    this.userAgent = options.userAgent ?? "MiniPhi-WebResearcher/1.0";
  }

  async search(query, options = {}) {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      throw new Error("Web research expects a non-empty query.");
    }

    const provider = (options.provider ?? DEFAULT_PROVIDER).toLowerCase();
    const maxResults = Math.max(
      1,
      Math.min(
        25,
        Number.isFinite(Number(options.maxResults)) ? Number(options.maxResults) : DEFAULT_MAX_RESULTS,
      ),
    );

    const startedAt = Date.now();
    const raw = await this._dispatchProvider(provider, trimmed);
    let normalizedResults = this._normalizeResults(provider, raw).slice(0, maxResults);
    let fallbackRaw = null;
    if (provider === "duckduckgo" && normalizedResults.length === 0) {
      try {
        fallbackRaw = await this._fetchDuckDuckGoHtml(trimmed);
        normalizedResults = this._extractDuckDuckGoHtml(fallbackRaw).slice(0, maxResults);
      } catch {
        fallbackRaw = null;
      }
    }

    return {
      id: randomUUID(),
      query: trimmed,
      provider,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      maxResults,
      results: normalizedResults,
      note: typeof options.note === "string" && options.note.trim() ? options.note.trim() : null,
      raw: options.includeRaw
        ? {
            provider_payload: raw,
            fallback_payload: fallbackRaw,
          }
        : undefined,
    };
  }

  async _dispatchProvider(provider, query) {
    switch (provider) {
      case "duckduckgo":
        return this._fetchDuckDuckGo(query);
      default:
        throw new Error(`Unsupported web research provider "${provider}".`);
    }
  }

  async _fetchDuckDuckGo(query) {
    if (typeof fetch !== "function") {
      throw new Error("Global fetch is not available in this Node runtime.");
    }
    const endpoint = new URL("https://api.duckduckgo.com/");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("no_redirect", "1");
    endpoint.searchParams.set("no_html", "1");
    endpoint.searchParams.set("t", "MiniPhi");

    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": this.userAgent,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DuckDuckGo request failed (${response.status}): ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  async _fetchDuckDuckGoHtml(query) {
    if (typeof fetch !== "function") {
      throw new Error("Global fetch is not available in this Node runtime.");
    }
    const endpoint = new URL("https://duckduckgo.com/html/");
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("kl", "us-en");

    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DuckDuckGo HTML request failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const html = await response.text();
    return {
      endpoint: endpoint.toString(),
      status: response.status,
      html,
    };
  }

  _normalizeResults(provider, rawPayload) {
    if (provider === "duckduckgo") {
      return this._extractDuckDuckGo(rawPayload);
    }
    return [];
  }

  _extractDuckDuckGo(payload) {
    const unique = new Map();
    const pushResult = (result) => {
      if (!result?.url) {
        return;
      }
      const key = result.url.toLowerCase();
      if (unique.has(key)) {
        return;
      }
      unique.set(key, result);
    };

    if (payload?.AbstractURL) {
      pushResult({
        title: payload.Heading || payload.AbstractSource || payload.AbstractURL,
        url: payload.AbstractURL,
        snippet: this._sanitizeSnippet(payload.AbstractText || payload.Abstract),
        source: payload.AbstractSource || "duckduckgo",
        rank: 0,
      });
    }

    if (Array.isArray(payload?.Results)) {
      payload.Results.forEach((item, index) => {
        pushResult({
          title: item.Text ?? item.Result ?? item.FirstURL ?? `Result #${index + 1}`,
          url: item.FirstURL ?? item.Result,
          snippet: this._sanitizeSnippet(item.Text ?? item.Result),
          source: this._sourceFromUrl(item.FirstURL),
          rank: index + 1,
        });
      });
    }

    const flattenTopics = (topics, depth = 0) => {
      if (!Array.isArray(topics) || depth > 2) {
        return;
      }
      topics.forEach((topic) => {
        if (Array.isArray(topic.Topics)) {
          flattenTopics(topic.Topics, depth + 1);
          return;
        }
        if (topic.FirstURL) {
          pushResult({
            title: topic.Text ?? topic.FirstURL,
            url: topic.FirstURL,
            snippet: this._sanitizeSnippet(topic.Text),
            source: this._sourceFromUrl(topic.FirstURL),
            rank: unique.size + 1,
          });
        }
      });
    };
    flattenTopics(payload?.RelatedTopics);

    return Array.from(unique.values());
  }

  _extractDuckDuckGoHtml(payload) {
    const html = payload?.html;
    if (!html || typeof html !== "string") {
      return [];
    }
    const unique = new Map();
    const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    let rank = 0;
    while ((match = anchorPattern.exec(html)) !== null) {
      const rawHref = this._decodeHtmlEntities(match[1] ?? "");
      const title = this._sanitizeSnippet(this._stripHtml(match[2] ?? ""));
      const url = this._decodeDuckDuckGoRedirect(rawHref);
      if (!url) {
        continue;
      }
      const key = url.toLowerCase();
      if (unique.has(key)) {
        continue;
      }
      const windowText = html.slice(match.index, match.index + 1600);
      const snippetMatch =
        windowText.match(
          /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
        ) ??
        windowText.match(
          /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        );
      const snippet = this._sanitizeSnippet(
        this._stripHtml(this._decodeHtmlEntities(snippetMatch?.[1] ?? "")),
      );
      rank += 1;
      unique.set(key, {
        title: title || url,
        url,
        snippet,
        source: this._sourceFromUrl(url),
        rank,
      });
    }
    return Array.from(unique.values());
  }

  _sanitizeSnippet(snippet) {
    if (!snippet) {
      return "";
    }
    return snippet.replace(/\s+/g, " ").trim();
  }

  _stripHtml(value) {
    if (!value) {
      return "";
    }
    return value.replace(/<[^>]+>/g, " ");
  }

  _decodeHtmlEntities(value) {
    if (!value) {
      return "";
    }
    return value
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x2F;/gi, "/")
      .replace(/&#x3D;/gi, "=")
      .replace(/&#x26;/gi, "&");
  }

  _decodeDuckDuckGoRedirect(rawHref) {
    if (!rawHref) {
      return null;
    }
    const normalizedHref = rawHref.startsWith("//")
      ? `https:${rawHref}`
      : rawHref.startsWith("/")
        ? `https://duckduckgo.com${rawHref}`
        : rawHref;
    try {
      const parsed = new URL(normalizedHref);
      const encodedTarget = parsed.searchParams.get("uddg");
      if (encodedTarget) {
        return decodeURIComponent(encodedTarget);
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  _sourceFromUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./i, "");
    } catch {
      return "unknown";
    }
  }
}

