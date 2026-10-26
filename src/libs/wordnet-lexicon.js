import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultWordNetDirectory, WORDNET_PACKAGES } from "./wordnet-installer.js";

export const normalizeLexeme = value => String(value).normalize("NFC").toLocaleLowerCase("en").replace(/_/gu, " ").replace(/\s+/gu, " ").trim();
const posKey = pos => pos === "s" ? "a" : pos;
const synsetKey = (offset, pos) => `${offset}-${posKey(pos)}`;
const words = value => normalizeLexeme(value).match(/[\p{L}][\p{L}'-]*/gu) ?? [];
const stop = new Set("the a an of in to by and is was has are be for with from it that this which what who how name identify part".split(" "));
const contextWords = value => words(value).filter(w => !stop.has(w));
const forms = {
  n: [["s", ""], ["ses", "s"], ["xes", "x"], ["zes", "z"], ["ches", "ch"], ["shes", "sh"], ["men", "man"], ["ies", "y"]],
  v: [["s", ""], ["ies", "y"], ["es", "e"], ["es", ""], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""]],
  a: [["er", ""], ["est", ""], ["er", "e"], ["est", "e"]], r: [],
};
async function lines(file, visit) {
  const input = createReadStream(file, { encoding: "utf8" });
  try { for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) visit(line); }
  finally { input.destroy(); }
}

/** PWN 3.0 + OMW 1.4 reader. No model, Python runtime, or network at inference. */
export class WordNetLexicon {
  constructor({ directory = defaultWordNetDirectory(), languages = ["eng", "ita", "fra", "spa"] } = {}) {
    this.directory = path.resolve(directory);
    this.languages = [...new Set(["eng", ...(typeof languages === "string" ? languages.split(",") : languages)])];
    if (this.languages.some(l => !/^[a-z]{3}$/u.test(l))) throw new Error("WordNet languages must be three-letter OMW codes");
    this.synsets = new Map(); this.index = new Map(); this.exceptions = new Map(); this.translations = new Map(); this.foreign = new Map();
  }
  async load() {
    if (this.loading) return this.loading;
    this.loading = this._load();
    return this.loading;
  }
  async _load() {
    const manifest = JSON.parse(await fs.readFile(path.join(this.directory, "manifest.json"), "utf8"));
    if (WORDNET_PACKAGES.some(p => !manifest.packages?.some(m => m.id === p.id && m.sha256 === p.sha256))) throw new Error("Unrecognized WordNet corpus manifest");
    for (const [filePos, pos] of [["noun", "n"], ["verb", "v"], ["adj", "a"], ["adv", "r"]]) {
      await lines(path.join(this.directory, "wordnet", `data.${filePos}`), line => {
        if (!/^\d{8} /u.test(line)) return;
        const [data, ...gloss] = line.split("|"); const fields = data.trim().split(/\s+/u);
        const count = parseInt(fields[3], 16), lemmas = []; let at = 4;
        for (let i = 0; i < count; i++, at += 2) lemmas.push(normalizeLexeme(fields[at].replace(/\((?:a|p|ip)\)$/u, "")));
        const pointerCount = Number(fields[at++]), pointers = [];
        for (let i = 0; i < pointerCount; i++, at += 4) pointers.push({ symbol: fields[at], id: synsetKey(fields[at + 1], fields[at + 2]), source: parseInt(fields[at + 3].slice(0, 2), 16), target: parseInt(fields[at + 3].slice(2), 16) });
        const id = synsetKey(fields[0], fields[2]);
        this.synsets.set(id, { id, pos: posKey(fields[2]), lemmas, pointers, gloss: gloss.join("|").trim() });
      });
      await lines(path.join(this.directory, "wordnet", `index.${filePos}`), line => {
        if (!line || /^\s/u.test(line)) return;
        const f = line.split(/\s+/u), start = 6 + Number(f[3]);
        this.index.set(`${pos}:${normalizeLexeme(f[0])}`, f.slice(start, start + Number(f[2])).map(offset => synsetKey(offset, pos)));
      });
      await lines(path.join(this.directory, "wordnet", `${filePos}.exc`), line => {
        const [inflected, ...base] = line.trim().split(/\s+/u);
        this.exceptions.set(`${pos}:${normalizeLexeme(inflected)}`, base.map(normalizeLexeme));
      });
    }
    const files = [];
    const walk = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f); else if (/^wn-data-[a-z]{3}\.tab$/u.test(e.name)) files.push(f);
    } };
    await walk(path.join(this.directory, "omw-1.4"));
    this.availableLanguages = ["eng", ...new Set(files.map(f => path.basename(f).slice(8, 11)))].sort();
    for (const language of this.languages.filter(l => l !== "eng")) {
      const file = files.find(f => path.basename(f) === `wn-data-${language}.tab`);
      if (!file) throw new Error(`OMW language unavailable: ${language}; available: ${this.availableLanguages.join(",")}`);
      await lines(file, line => {
        if (line.startsWith("#")) return;
        const [id, type, raw] = line.split("\t");
        if (!(type === "lemma" || type?.endsWith(":lemma")) || !raw) return;
        const key = id.replace(/-s$/u, "-a"), term = normalizeLexeme(raw);
        if (!this.synsets.has(key)) return;
        const ts = this.translations.get(key) ?? []; ts.push({ term, language }); this.translations.set(key, ts);
        const fk = `${language}:${term}`, ids = this.foreign.get(fk) ?? []; ids.push(key); this.foreign.set(fk, ids);
      });
    }
    this.provenance = { provider: "wordnet", version: "PWN-3.0+OMW-1.4", languages: this.languages,
      packages: manifest.packages.map(({ id, sha256 }) => ({ id, sha256 })) };
    this.fingerprint = createHash("sha256").update(JSON.stringify(this.provenance)).digest("hex");
    return this;
  }
  senses(term, language = "eng") {
    term = normalizeLexeme(term);
    if (language !== "eng") return [...new Set(this.foreign.get(`${language}:${term}`) ?? [])];
    const ids = [];
    for (const pos of ["n", "v", "a", "r"]) {
      const candidates = [term, ...(this.exceptions.get(`${pos}:${term}`) ?? []), ...forms[pos].filter(([suffix]) => term.endsWith(suffix)).map(([suffix, to]) => term.slice(0, -suffix.length) + to)];
      for (const candidate of new Set(candidates)) ids.push(...(this.index.get(`${pos}:${candidate}`) ?? []));
    }
    return [...new Set(ids)];
  }
  ancestors(id, depth = 3, found = new Set()) {
    if (!depth || found.size > 64) return found;
    for (const p of this.synsets.get(id)?.pointers ?? []) if (["@", "@i"].includes(p.symbol) && !found.has(p.id)) {
      found.add(p.id); this.ancestors(p.id, depth - 1, found);
    }
    return found;
  }
  /** Context selects senses; translations/derivations never assert entity identity. */
  async expand(term, { context = "", limit = 16 } = {}) {
    await this.load();
    const candidates = this.languages.flatMap(language => this.senses(term, language).map(id => ({ id, language })));
    const tokens = new Set(contextWords(context).filter(w => !words(term).includes(w)));
    const contextSynsets = new Set();
    const candidateIds = new Set(candidates.map(c => c.id));
    for (const token of tokens) {
      const senses = this.senses(token);
      if (senses.some(id => candidateIds.has(id))) continue;
      for (const id of senses.slice(0, 3)) { contextSynsets.add(id); for (const parent of this.ancestors(id)) contextSynsets.add(parent); }
    }
    const ranked = [...new Map(candidates.map(c => [c.id, c])).values()].map((c, order) => {
      const s = this.synsets.get(c.id);
      const overlap = contextWords(`${s.gloss} ${s.lemmas.join(" ")}`).filter(t => tokens.has(t)).length;
      return { ...c, score: overlap + (contextSynsets.has(c.id) ? 12 : 0), order };
    }).sort((a, b) => b.score - a.score || a.order - b.order);
    const selected = ranked.filter(s => s.score >= (ranked[0]?.score ?? 0)).slice(0, ranked[0]?.score > 0 ? 2 : 1);
    const all = [];
    for (const choice of selected) {
      const s = this.synsets.get(choice.id);
      const add = (t, kind, extra = {}) => all.push({ ...t, kind, synset: s.id, pos: s.pos, senseScore: choice.score, ...extra });
      for (const t of s.lemmas) add({ term: t, language: "eng" }, "synonym");
      for (const t of this.translations.get(s.id) ?? []) add(t, "translation");
      for (const p of s.pointers.filter(p => p.symbol === "+")) {
        const source = p.source ? s.lemmas[p.source - 1] : null;
        if (source && !this.senses(term, choice.language).includes(s.id)) continue;
        // Lexical pointers apply to a particular source lemma. Inflections
        // are resolved above, but a pointer belonging to another word is not.
        if (source && source !== normalizeLexeme(term) && !this.exceptions.get(`${s.pos}:${normalizeLexeme(term)}`)?.includes(source) && !forms[s.pos]?.some(([suffix, to]) => normalizeLexeme(term).endsWith(suffix) && normalizeLexeme(term).slice(0, -suffix.length) + to === source)) continue;
        const target = this.synsets.get(p.id); if (!target) continue;
        const values = p.target ? [target.lemmas[p.target - 1]] : target.lemmas;
        for (const t of values.filter(Boolean)) add({ term: t, language: "eng" }, "derivation", { targetSynset: target.id });
        for (const t of this.translations.get(p.id) ?? []) add(t, "derivation_translation", { targetSynset: target.id });
      }
    }
    const unique = [...new Map(all.map(t => [`${t.language}:${t.term}:${t.kind}`, t])).values()];
    // Round-robin languages so a verbose English synset cannot starve OMW.
    const result = [];
    for (let i = 0; result.length < limit; i++) {
      let added = false;
      for (const language of this.languages) { const t = unique.filter(t => t.language === language)[i]; if (t && result.length < limit) { result.push(t); added = true; } }
      if (!added) break;
    }
    return { term: normalizeLexeme(term), senses: selected.map(c => ({ id: c.id, score: c.score, gloss: this.synsets.get(c.id).gloss })), terms: result, provenance: this.provenance, fingerprint: this.fingerprint };
  }
}

const instances = new Map();
export function getWordNetLexicon(options = {}) {
  const key = JSON.stringify([options.directory ?? defaultWordNetDirectory(), options.languages ?? ["eng", "ita", "fra", "spa"]]);
  if (!instances.has(key)) instances.set(key, new WordNetLexicon(options));
  return instances.get(key);
}
