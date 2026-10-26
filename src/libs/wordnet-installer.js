import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";

// Pinned official NLTK data packages. Preserve the component licenses in OMW.
export const WORDNET_PACKAGES = [
  { id: "wordnet", sha256: "cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59" },
  { id: "omw-1.4", sha256: "3b941e664852f3297b6040236626065796a2aaf7d7f9eec8779a3beaa1096c2d" },
].map(p => ({ ...p, url: `https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/${p.id}.zip` }));
export const defaultWordNetDirectory = () => path.resolve(process.env.MINIPHI_WORDNET_DIR ?? ".miniphi/lexicons/wordnet");

export async function extractLexiconZip(file, destination) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (e, z) => e ? reject(e) : resolve(z)));
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject); zip.on("end", resolve);
      zip.on("entry", entry => {
        (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const target = path.resolve(destination, entry.fileName);
          if (!target.startsWith(`${path.resolve(destination)}${path.sep}`) || mode === 0xa000 || entry.fileName.includes("\\")) throw new Error("Unsafe lexicon ZIP entry");
          total += entry.uncompressedSize;
          if (total > 160 * 1024 * 1024) throw new Error("Lexicon archive exceeds extraction budget");
          if (entry.fileName.endsWith("/")) await fs.mkdir(target, { recursive: true });
          else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
            await pipeline(stream, createWriteStream(target, { flags: "wx" }));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

/** Explicit installation only; inference never downloads or asks an LM for synonyms. */
export async function installWordNet({ directory = defaultWordNetDirectory(), fetchImpl = fetch, timeoutMs = 180000 } = {}) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true });
  const work = await fs.mkdtemp(path.join(root, ".install-"));
  try {
    for (const pkg of WORDNET_PACKAGES) {
      const response = await fetchImpl(pkg.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok || !response.body) throw new Error(`WordNet download failed: ${response.status}`);
      const hash = createHash("sha256"); let size = 0;
      const archive = path.join(work, `${pkg.id}.zip`);
      await pipeline(response.body, new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) return done(new Error("Lexicon download exceeds budget"));
        hash.update(chunk); done(null, chunk);
      } }), createWriteStream(archive, { flags: "wx" }));
      if (hash.digest("hex") !== pkg.sha256) throw new Error(`WordNet checksum mismatch: ${pkg.id}`);
      await extractLexiconZip(archive, work);
      await fs.rm(archive);
    }
    // A completed installation is reusable; never merge partial old corpora.
    for (const pkg of WORDNET_PACKAGES) {
      try { await fs.rename(path.join(work, pkg.id), path.join(root, pkg.id)); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; throw new Error(`Lexicon already exists in ${root}; choose a fresh directory`); }
    }
    const manifest = { version: 1, installedAt: new Date().toISOString(), packages: WORDNET_PACKAGES };
    await fs.writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { directory: root, ...manifest };
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
