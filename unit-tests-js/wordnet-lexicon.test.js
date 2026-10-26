import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WordNetLexicon } from "../src/libs/wordnet-lexicon.js";
import { WORDNET_PACKAGES, installWordNet } from "../src/libs/wordnet-installer.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wordnet-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "wordnet"));
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ packages: WORDNET_PACKAGES }));
  const data = {
    noun: [
      "00000001 14 n 02 family 0 household 0 000 | people living together",
      "00000002 14 n 01 family 0 000 | biological taxonomic group containing genera",
      "00000003 05 n 01 rosaceae 0 001 @ 00000002 n 0000 | rose plants",
      "00000004 18 n 01 builder 0 000 | someone who constructs",
    ],
    verb: ["00000005 36 v 02 build 0 construct 0 001 + 00000004 n 0101 00 | make by combining materials"],
    adj: [], adv: [],
  };
  const index = { noun: ["family n 2 0 2 1 00000001 00000002", "household n 1 0 1 1 00000001", "rosaceae n 1 0 1 1 00000003", "builder n 1 0 1 1 00000004"],
    verb: ["build v 1 1 + 1 1 00000005", "construct v 1 0 1 1 00000005"], adj: [], adv: [] };
  for (const pos of Object.keys(data)) {
    await fs.writeFile(path.join(directory, "wordnet", `data.${pos}`), data[pos].join("\n"));
    await fs.writeFile(path.join(directory, "wordnet", `index.${pos}`), index[pos].join("\n"));
    await fs.writeFile(path.join(directory, "wordnet", `${pos}.exc`), pos === "verb" ? "built build\n" : "");
  }
  for (const [language, tab] of [["ita", "00000002-n\tita:lemma\tfamiglia\n"], ["spa", "00000002-n\tlemma\tfamilia\n"]]) {
    const dir = path.join(directory, "omw-1.4", language); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `wn-data-${language}.tab`), tab);
  }
  return new WordNetLexicon({ directory, languages: ["eng", "ita", "spa"] });
}

test("WordNet resolves irregular morphology and keeps derivations distinct from synonyms", async t => {
  const lexicon = await fixture(t);
  const result = await lexicon.expand("built");
  assert(result.terms.some(t => t.term === "construct" && t.kind === "synonym" && t.synset === "00000005-v"));
  assert(result.terms.some(t => t.term === "builder" && t.kind === "derivation" && t.targetSynset === "00000004-n"));
  const construct = await lexicon.expand("construct");
  assert(!construct.terms.some(t => t.kind === "derivation"), "a lexical pointer belonging to build must not be borrowed by another source word");
  assert.equal((await lexicon.expand("unlisted-word")).terms.length, 0);
});

test("context selects biological senses and multilingual lookups share the PWN synset", async t => {
  const lexicon = await fixture(t);
  const generic = await lexicon.expand("family");
  assert.equal(generic.senses[0].id, "00000001-n", "retain the official index sense ordering when context is absent");
  const biology = await lexicon.expand("family", { context: "Rosaceae family" });
  assert.equal(biology.senses[0].id, "00000002-n");
  assert.deepEqual(biology.terms.map(t => [t.language, t.term]), [["eng", "family"], ["ita", "famiglia"], ["spa", "familia"]]);
  const translated = await lexicon.expand("familia", { context: "Rosaceae" });
  assert(translated.terms.some(t => t.term === "family" && t.language === "eng"));
  assert.equal(translated.provenance.packages.length, 2);
  assert.equal(translated.fingerprint.length, 64);
});

test("missing or mismatched corpus cannot silently fall back to generated vocabulary", async t => {
  const lexicon = await fixture(t);
  await fs.writeFile(path.join(lexicon.directory, "manifest.json"), "{}");
  await assert.rejects(() => lexicon.expand("family"), /Unrecognized WordNet/);
  assert.throws(() => new WordNetLexicon({ languages: "../eng" }), /three-letter/);
});

test("installer rejects bytes that do not match the pinned corpus before extraction", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-wordnet-install-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => installWordNet({ directory, fetchImpl: async () => new Response("wrong corpus") }), /checksum mismatch/);
  assert.deepEqual(await fs.readdir(directory), []);
});
