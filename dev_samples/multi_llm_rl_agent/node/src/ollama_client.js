import axios from "axios";

/**
 * Minimal Ollama client (NodeJS).
 * Requires Ollama running locally: http://localhost:11434
 */
export async function ollamaGenerate({ model, prompt, baseUrl = "http://localhost:11434", temperature = 0.2 }) {
  const url = `${baseUrl}/api/generate`;
  const payload = {
    model,
    prompt,
    stream: false,
    options: { temperature },
  };
  const res = await axios.post(url, payload, { timeout: 120000 });
  return res.data?.response ?? "";
}

export function extractJson(text) {
  // Prefer ```json ... ```
  const fenced = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) candidates.push(text.slice(i, j + 1));

  let lastErr = null;
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not parse JSON from output. Last error: ${lastErr}\nRaw:\n${text}`);
}
