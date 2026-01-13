import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import HistoryNotesManager from "../libs/history-notes.js";

export async function handleHistoryNotes({ options, verbose }) {
  const includeGit = !options["no-git"];
  const label = typeof options.label === "string" ? options.label.trim() : null;
  const historyRoot = options["history-root"]
    ? path.resolve(options["history-root"])
    : process.cwd();
  const memory = new MiniPhiMemory(historyRoot);
  const manager = new HistoryNotesManager(memory);
  const snapshot = await manager.captureSnapshot({ includeGit, label });
  const note = snapshot.note;
  console.log(
    `[MiniPhi][History] Changed: ${note.changedFiles.length}, added: ${note.addedFiles.length}, removed: ${note.removedFiles.length}, stable: ${note.stableCount}`,
  );
  if (snapshot.previousSnapshot?.path && verbose) {
    const prevRel = path.relative(process.cwd(), snapshot.previousSnapshot.path);
    console.log(`[MiniPhi][History] Compared against ${prevRel || snapshot.previousSnapshot.path}`);
  }
  if (snapshot.jsonPath) {
    const relJson = path.relative(process.cwd(), snapshot.jsonPath);
    console.log(`[MiniPhi][History] JSON: ${relJson || snapshot.jsonPath}`);
  }
  if (snapshot.markdownPath) {
    const relMd = path.relative(process.cwd(), snapshot.markdownPath);
    console.log(`[MiniPhi][History] Markdown: ${relMd || snapshot.markdownPath}`);
  }
}
