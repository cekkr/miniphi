import json
import sys
from collections import Counter, defaultdict


def extract_key_lines(lines, ratio=0.3):
  """Pick the most informative lines based on word frequency."""
  if not lines:
    return []

  all_words = []
  for line in lines:
    all_words.extend(line.split())

  if not all_words:
    return lines[: max(1, int(len(lines) * ratio))]

  word_freq = Counter(all_words)
  important_words = {
    word for word, _ in word_freq.most_common(max(1, int(len(word_freq) * 0.2)))
  }

  scored = []
  for idx, line in enumerate(lines):
    score = sum(1 for word in line.split() if word in important_words)
    scored.append((idx, score))

  keep = max(1, int(len(lines) * ratio))
  top = sorted(scored, key=lambda item: item[1], reverse=True)[:keep]
  top.sort(key=lambda item: item[0])
  return [lines[i] for i, _ in top]


def categorize_log_lines(lines):
  """Group lines by severity so downstream summaries stay organized."""
  categories = defaultdict(list)
  severity_keywords = {
    "ERROR": ["error", "fatal", "exception", "failed"],
    "WARNING": ["warning", "warn", "deprecated"],
    "SUCCESS": ["success", "complete", "ok"],
    "INFO": ["info", "start", "begin"],
  }

  for line in lines:
    lower = line.lower()
    matched = False
    for severity, keywords in severity_keywords.items():
      if any(keyword in lower for keyword in keywords):
        categories[severity].append(line)
        matched = True
        break
    if not matched:
      categories["OTHER"].append(line)

  return categories


def recursive_summarize(lines, levels=3):
  """Perform hierarchical summarization for long logs."""
  summaries = []
  working_lines = list(lines)

  for level in range(levels):
    if len(working_lines) <= 1:
      break

    categories = categorize_log_lines(working_lines)
    level_summary = {"level": level, "categories": {}, "total_lines": len(working_lines)}

    next_lines = []
    for category, cat_lines in categories.items():
      key_lines = extract_key_lines(cat_lines, ratio=0.4)
      level_summary["categories"][category] = {
        "count": len(cat_lines),
        "sample_lines": key_lines[:3],
      }
      next_lines.extend(key_lines)

    summaries.append(level_summary)
    working_lines = next_lines

  return summaries


def main():
  raw = sys.stdin.read()
  try:
    payload = json.loads(raw or "{}")
  except json.JSONDecodeError as exc:
    print(json.dumps({"success": False, "error": f"Invalid JSON payload: {exc}"}))
    sys.exit(1)

  lines = payload.get("lines", [])
  levels = int(payload.get("levels", 3))

  try:
    summary = recursive_summarize(lines, levels=levels)
    denominator = sum(
      len(level.get("categories", {}).get(cat, {}).get("sample_lines", []))
      for level in summary
      for cat in level.get("categories", {})
    ) or 1
    compression_ratio = len(lines) / denominator if denominator else 1.0

    print(
      json.dumps(
        {
          "success": True,
          "input_lines": len(lines),
          "summary": summary,
          "compression_ratio": compression_ratio,
        }
      )
    )
  except Exception as exc:
    print(json.dumps({"success": False, "error": str(exc)}))
    sys.exit(1)


if __name__ == "__main__":
  main()
