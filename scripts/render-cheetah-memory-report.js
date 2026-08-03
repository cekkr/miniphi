#!/usr/bin/env node
/**
 * Render the per-sample benchmark traces produced by
 * `scripts/run-cheetah-memory-benchmark.js` into the companion Markdown record.
 *
 * The requirement this serves is "every passage needed to arrive at the final
 * answer": for each sample the output shows the source that was learned, the
 * exact teach turn, what got stored in which layer, every MiniPhi -> Cheetah
 * command with its decoded response, the evidence block that went back into the
 * model, the recall turn, the closed-book answer, and the final answer.
 *
 * Usage:
 *   node scripts/render-cheetah-memory-report.js \
 *     --session-dir .miniphi/cheetah/memory-benchmark/<id> \
 *     --out docs/cheetah_memory_benchmark_samples.md
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[token.slice(2)] = true;
    } else {
      options[token.slice(2)] = next;
      index += 1;
    }
  }
  return options;
}

function fence(body, language = "text") {
  const text = String(body ?? "").trim();
  // Prompts embed their own ```json schema block, so the wrapper has to be
  // longer than the longest backtick run inside it or the page stops rendering
  // at the first inner fence.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marker = "`".repeat(Math.max(3, longest + 1));
  return [marker + language, text, marker].join("\n");
}

function clip(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function verdict(score) {
  if (!score) {
    return "error";
  }
  if (score.correct) {
    return "**correct**";
  }
  return score.abstained ? "abstained" : "wrong";
}

function renderSample(sample) {
  const lines = [];
  lines.push(`### Sample ${sample.index} — ${sample.kind} — ${sample.subject}`);
  lines.push("");
  lines.push(`> ${sample.question}`);
  lines.push("");
  lines.push(
    `| field | value |\n| --- | --- |\n` +
      `| expectation | ${sample.expect} |\n` +
      `| gold answer | ${sample.goldAnswer ? `\`${sample.goldAnswer}\`` : "_(none — control)_"} |\n` +
      `| closed book | ${verdict(sample.closedBook?.score)} |\n` +
      `| with memory | ${verdict(sample.withMemory?.score)} |\n` +
      `| answer source | \`${sample.withMemory?.answerSource ?? "error"}\` |\n` +
      `| anchor resolved | ${sample.withMemory?.anchorResolved ? "yes" : "no"} |`,
  );
  lines.push("");

  if (sample.learning) {
    lines.push("**1. What was learned (source passage given to the teach turn)**");
    lines.push("");
    lines.push(
      `Provenance: \`${sample.learning.source?.fileName ?? "?"}#${sample.learning.source?.articleId ?? "?"}\``,
    );
    lines.push("");
    lines.push(fence(clip(sample.learning.sourceText, 2600)));
    lines.push("");
    lines.push("**2. Teach turn — model response**");
    lines.push("");
    lines.push(fence(JSON.stringify(sample.learning.teachParsed ?? {}, null, 1), "json"));
    lines.push("");
    lines.push("**3. What MiniPhi stored, by layer**");
    lines.push("");
    for (const passage of sample.learning.storedPassages ?? []) {
      lines.push(`- \`${passage.layer}\` (section "${passage.section}"): "${clip(passage.text, 400)}"`);
    }
    if (sample.learning.contextTags?.length) {
      lines.push(`- \`context\` nodes: ${sample.learning.contextTags.map((tag) => `\`${tag}\``).join(", ")}`);
    }
    if (sample.learning.mentions?.length) {
      lines.push(`- \`mention\` nodes: ${sample.learning.mentions.map((name) => `\`${name}\``).join(", ")}`);
    }
    lines.push(
      `- accepted semantic facts: ${sample.learning.acceptedFacts ?? 0}; rejected: ${
        (sample.learning.rejectedFacts ?? []).map((entry) => `${entry.relation ?? "?"} (${entry.reason})`).join(", ") ||
        "none"
      }`,
    );
    const write = sample.learning.graphWrite ?? {};
    lines.push(
      `- graph write: ${write.nodeCount ?? 0} nodes, ${write.edgeCount ?? 0} edges ` +
        `(${write.passageNodes ?? 0} passage, ${write.contextNodes ?? 0} context, ${write.mentionNodes ?? 0} mention)`,
    );
    lines.push("");
  } else {
    lines.push("**1-3. Never taught.** This is a control subject: nothing about it was written to the memory.");
    lines.push("");
  }

  lines.push("**4. Closed book — same question, no memory**");
  lines.push("");
  lines.push(
    fence(
      sample.closedBook?.answer
        ? sample.closedBook.answer
        : sample.closedBook?.error
          ? `(error: ${sample.closedBook.error})`
          : "(empty answer)",
    ),
  );
  lines.push("");

  lines.push("**5. MiniPhi → Cheetah retrieval**");
  lines.push("");
  const trace = sample.withMemory?.cheetahTrace ?? [];
  if (!trace.length) {
    lines.push("_No retrieval was performed (the turn errored)._");
  } else {
    const rendered = [];
    for (const entry of trace) {
      rendered.push(`> [${entry.stage}] ${entry.command}`);
      rendered.push(`< ${entry.response}`);
      if (entry.decoded !== null && entry.decoded !== undefined) {
        rendered.push(`  decoded: ${clip(JSON.stringify(entry.decoded), 900)}`);
      }
    }
    lines.push(fence(rendered.join("\n")));
  }
  lines.push("");

  lines.push("**6. Memory items placed in the model's context**");
  lines.push("");
  const passages = sample.withMemory?.retrievedPassages ?? [];
  if (!passages.length) {
    lines.push("_Nothing was retrieved._");
  } else {
    for (const passage of passages) {
      lines.push(
        `- \`${passage.id}\` [${passage.origin}/${passage.layer} — ${passage.subject}] "${clip(passage.text, 420)}"`,
      );
    }
  }
  for (const relation of sample.withMemory?.relations ?? []) {
    lines.push(`- stored relation: ${relation.text}`);
  }
  lines.push("");

  lines.push("**7. Recall turn(s)**");
  lines.push("");
  const rounds = sample.withMemory?.recallRounds ?? [];
  if (!rounds.length) {
    lines.push("_No recall turn ran._");
  }
  for (const round of rounds) {
    lines.push(`Round ${round.round} — model response:`);
    lines.push("");
    lines.push(fence(JSON.stringify(round.parsed ?? {}, null, 1), "json"));
    lines.push("");
  }
  if (sample.withMemory?.followUpLookups?.length) {
    lines.push(
      `The model asked for more memory: ${sample.withMemory.followUpLookups
        .map((lookup) => `\`${lookup.kind}:${lookup.value}\``)
        .join(", ")}`,
    );
    lines.push("");
  }

  lines.push("**8. Answer MiniPhi returned**");
  lines.push("");
  lines.push(`> ${clip(sample.withMemory?.answer ?? "(error)", 1200)}`);
  lines.push("");
  lines.push(
    `Adjudication: \`answerSource=${sample.withMemory?.answerSource ?? "error"}\`, ` +
      `model-composed=${sample.withMemory?.modelGrounded ? "yes" : "no"}, ` +
      `answer support=${(sample.withMemory?.answerSupport ?? 0).toFixed(2)}, ` +
      `cited=${(sample.withMemory?.citedEvidenceIds ?? []).join(", ") || "none"}, ` +
      `gold recall=${(sample.withMemory?.score?.goldRecall ?? 0).toFixed(2)} ` +
      `(closed book ${(sample.closedBook?.score?.goldRecall ?? 0).toFixed(2)}).`,
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(String(options["session-dir"] ?? ""));
  if (!options["session-dir"]) {
    throw new Error("render-cheetah-memory-report requires --session-dir");
  }
  const outFile = path.resolve(
    String(options.out ?? path.join("docs", "cheetah_memory_benchmark_samples.md")),
  );
  const report = JSON.parse(await fs.readFile(path.join(sessionDir, "report.json"), "utf8"));
  const samples = (await fs.readFile(path.join(sessionDir, "samples.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .sort((left, right) => left.index - right.index);

  const teachPrompt =
    samples.find((sample) => sample.learning?.teachPrompt)?.learning?.teachPrompt ?? "";
  const closedBookPrompt = samples.find((sample) => sample.closedBook?.prompt)?.closedBook?.prompt ?? "";
  const recallPrompt = samples.find((sample) => sample.withMemory?.recallRounds?.length)
    ?.withMemory?.recallRounds?.[0]?.prompt ?? "";

  const lines = [];
  lines.push("# Cheetah layered-memory benchmark — complete per-sample traces");
  lines.push("");
  lines.push(
    "Companion record for [`cheetah_memory_benchmarks.md`](cheetah_memory_benchmarks.md). Every sample below is a real run: " +
      "the passage that was learned, the exact teach turn, what was written into each memory layer, every MiniPhi → Cheetah " +
      "command and its decoded response, the memory items placed back into the model's context, the recall turn(s), the " +
      "closed-book answer to the same question, and the answer MiniPhi finally returned.",
  );
  lines.push("");
  lines.push(
    `Session \`${report.sessionId}\` · model \`${report.config.modelKey}\` · database \`${report.config.database}\` · ` +
      `${report.totals.samples} samples (${report.totals.answerable} answerable, ${report.totals.controls} never-taught controls).`,
  );
  lines.push("");
  lines.push(
    "Byte-exact prompts, responses and usage are retained in " +
      `\`${path.relative(process.cwd(), sessionDir).replace(/\\/g, "/")}/samples.jsonl\` and in \`.miniphi/prompt-exchanges/\`.`,
  );
  lines.push("");

  lines.push("## Invariant prompt templates");
  lines.push("");
  lines.push(
    "The three prompt shapes below are identical across every sample apart from the substituted passage, question and " +
      "retrieved evidence, so they are printed once here instead of 50+ times. Each is also sent as " +
      "`response_format=json_schema` with the same schema embedded in the text.",
  );
  lines.push("");
  lines.push("### Teach turn");
  lines.push("");
  lines.push(fence(clip(teachPrompt, 6000)));
  lines.push("");
  lines.push("### Closed-book turn (no memory)");
  lines.push("");
  lines.push(fence(clip(closedBookPrompt, 3000)));
  lines.push("");
  lines.push("### Recall turn (memory items substituted per question)");
  lines.push("");
  lines.push(fence(clip(recallPrompt, 6000)));
  lines.push("");

  lines.push("## Samples");
  lines.push("");
  for (const sample of samples) {
    lines.push(renderSample(sample));
    lines.push("---");
    lines.push("");
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, lines.join("\n"), "utf8");
  console.log(`wrote ${outFile} (${samples.length} samples)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
