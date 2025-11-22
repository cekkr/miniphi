import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const IGNORED_DIRS = new Set(["history-notes"]);

export default class HistoryNotesManager {
  constructor(memory) {
    if (!memory) {
      throw new Error("HistoryNotesManager expects an existing MiniPhiMemory instance.");
    }
    this.memory = memory;
    this.gitStatus = { checked: false, available: false };
  }

  async captureSnapshot(options = {}) {
    const includeGit = options.includeGit !== false;
    const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : null;
    const baseDir = await this.memory.prepare();
    const { entries, gitAvailable } = await this._collectEntries(baseDir, includeGit);
    const previous = await this.memory.loadLatestHistoryNote();
    const diff = this._diffEntries(entries, previous?.data?.entries ?? []);

    const note = {
      id: null,
      label,
      generatedAt: new Date().toISOString(),
      baseDir,
      projectRoot: this.memory.projectRoot,
      includeGit,
      gitAvailable,
      entryCount: entries.length,
      changedFiles: diff.changed,
      addedFiles: diff.added,
      removedFiles: diff.removed,
      stableCount: diff.stableCount,
      entries,
      previousSnapshot: previous
        ? {
            path: previous.path,
            generatedAt: previous.data?.generatedAt ?? null,
          }
        : null,
    };

    const markdown = this._buildMarkdown(note);
    const persisted = await this.memory.saveHistoryNote(note, markdown);
    if (persisted?.id) {
      note.id = persisted.id;
    }
    return {
      note,
      markdownPath: persisted?.markdownPath ?? null,
      jsonPath: persisted?.jsonPath ?? null,
      previousSnapshot: note.previousSnapshot,
    };
  }

  async _collectEntries(baseDir, includeGit) {
    const entries = [];
    const gitAvailable = includeGit && this._ensureGitReady();
    const stack = [""];

    while (stack.length) {
      const relativeDir = stack.pop();
      const absoluteDir = path.join(baseDir, relativeDir);
      let dirents;
      try {
        dirents = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        const relPath = path.join(relativeDir, dirent.name);
        if (IGNORED_DIRS.has(dirent.name)) {
          continue;
        }
        const absolutePath = path.join(baseDir, relPath);
        if (dirent.isDirectory()) {
          stack.push(relPath);
          continue;
        }
        if (!dirent.isFile()) {
          continue;
        }
        let stats;
        try {
          stats = await fs.promises.stat(absolutePath);
        } catch {
          continue;
        }
        const entry = {
          path: relPath.replace(/\\/g, "/"),
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
          lastModifiedMs: stats.mtimeMs,
        };
        if (gitAvailable) {
          entry.git = this._readGitInfo(absolutePath);
        }
        entries.push(entry);
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, gitAvailable };
  }

  _diffEntries(currentEntries, previousEntries) {
    const previousMap = new Map((previousEntries ?? []).map((entry) => [entry.path, entry]));
    const changed = [];
    const added = [];
    const removed = [];

    for (const entry of currentEntries) {
      const previous = previousMap.get(entry.path);
      if (!previous) {
        added.push({
          path: entry.path,
          current: entry,
        });
        continue;
      }

      const changedStat =
        previous.lastModifiedMs !== entry.lastModifiedMs ||
        previous.size !== entry.size ||
        (previous.git?.hash && entry.git?.hash && previous.git.hash !== entry.git.hash);

      if (changedStat) {
        changed.push({
          path: entry.path,
          previous: previous,
          current: entry,
        });
      }
      previousMap.delete(entry.path);
    }

    for (const remaining of previousMap.values()) {
      removed.push({
        path: remaining.path,
        previous: remaining,
      });
    }

    const stableCount = currentEntries.length - changed.length - added.length;
    return { changed, added, removed, stableCount };
  }

  _ensureGitReady() {
    if (this.gitStatus.checked) {
      return this.gitStatus.available;
    }
    try {
      const result = spawnSync(
        "git",
        ["-C", this.memory.projectRoot, "rev-parse", "--is-inside-work-tree"],
        { encoding: "utf8" },
      );
      this.gitStatus = { checked: true, available: result.status === 0 };
    } catch {
      this.gitStatus = { checked: true, available: false };
    }
    return this.gitStatus.available;
  }

  _readGitInfo(absolutePath) {
    if (!this.gitStatus.available) {
      return null;
    }
    try {
      const result = spawnSync(
        "git",
        ["-C", this.memory.projectRoot, "log", "-1", "--pretty=format:%H|%cI|%cn", "--", absolutePath],
        { encoding: "utf8" },
      );
      if (result.status !== 0) {
        return null;
      }
      const [hash, committedAt, author] = result.stdout.trim().split("|");
      return {
        hash: hash || null,
        committedAt: committedAt || null,
        author: author || null,
      };
    } catch {
      return null;
    }
  }

  _buildMarkdown(note) {
    const lines = [];
    const baseRelative = path.relative(note.projectRoot, note.baseDir) || note.baseDir;
    lines.push(`# .miniphi History Snapshot`);
    lines.push("");
    lines.push(`- Generated: ${note.generatedAt}`);
    lines.push(`- Base directory: \`${baseRelative}\``);
    lines.push(`- Entries scanned: ${note.entryCount}`);
    lines.push(`- Changed: ${note.changedFiles.length}`);
    lines.push(`- Added: ${note.addedFiles.length}`);
    lines.push(`- Removed: ${note.removedFiles.length}`);
    lines.push(`- Stable: ${note.stableCount}`);
    lines.push(`- Git metadata: ${note.gitAvailable ? "available" : "unavailable"}`);
    if (note.previousSnapshot?.path) {
      lines.push(
        `- Compared against: \`${path.relative(this.memory.baseDir, note.previousSnapshot.path)}\``,
      );
    }
    if (note.label) {
      lines.push(`- Label: ${note.label}`);
    }
    lines.push("");

    const renderSection = (title, rows, fieldExtractor) => {
      lines.push(`## ${title}`);
      if (!rows.length) {
        lines.push("_None_");
        lines.push("");
        return;
      }
      lines.push(`| Path | Last Modified | Size (bytes) | Last Commit |`);
      lines.push(`| --- | --- | ---: | --- |`);
      rows.forEach((row) => {
        const target = fieldExtractor(row);
        const commit = target.git
          ? `${target.git.hash ? target.git.hash.slice(0, 8) : "—"} by ${
              target.git.author ?? "unknown"
            } on ${target.git.committedAt ?? "unknown"}`
          : "—";
        lines.push(
          `| \`${row.path}\` | ${target.lastModified ?? "unknown"} | ${target.size ?? "?"} | ${commit} |`,
        );
      });
      lines.push("");
    };

    renderSection("Changed Files", note.changedFiles, (row) => row.current ?? row.previous ?? {});
    renderSection("Added Files", note.addedFiles, (row) => row.current ?? {});
    renderSection("Removed Files", note.removedFiles, (row) => row.previous ?? {});

    return lines.join("\n");
  }
}
