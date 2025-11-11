import { createReadStream } from "fs";
import readline from "readline";

/**
 * Utility for processing large text files line-by-line without loading them entirely into memory.
 */
export default class StreamAnalyzer {
  constructor(maxLinesPerChunk = 100) {
    this.maxLinesPerChunk = maxLinesPerChunk;
  }

  /**
   * Analyze a file with a user-provided processor handling chunks of lines.
   * @param {string} filePath
   * @param {(lines: Array<{ line: number, content: string, timestamp: string | null, severity: string }>) => Promise<unknown>} processor
   */
  async analyzeFile(filePath, processor) {
    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(filePath, { encoding: "utf-8" });

      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let lineNumber = 0;
      let chunk = [];
      const results = [];

      rl.on("line", (line) => {
        lineNumber += 1;
        chunk.push({
          line: lineNumber,
          content: line,
          timestamp: this.extractTimestamp(line),
          severity: this.extractSeverity(line),
        });

        if (chunk.length >= this.maxLinesPerChunk) {
          rl.pause();
          processor(chunk)
            .then((result) => {
              results.push(result);
              chunk = [];
              rl.resume();
            })
            .catch((error) => {
              rl.close();
              reject(error);
            });
        }
      });

      rl.on("close", () => {
        if (chunk.length > 0) {
          Promise.resolve(processor(chunk))
            .then((result) => {
              results.push(result);
              resolve(results);
            })
            .catch(reject);
        } else {
          resolve(results);
        }
      });

      rl.on("error", reject);
      fileStream.on("error", reject);
    });
  }

  extractTimestamp(line) {
    const patterns = [
      /^\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})]/,
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
      /(\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2})/,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  }

  extractSeverity(line) {
    const severityMap = {
      ERROR: /ERROR|FATAL|EXCEPTION|FAIL/i,
      WARNING: /WARN|DEPRECATED/i,
      SUCCESS: /SUCCESS|COMPLETE|OK/i,
      INFO: /INFO|START|BEGIN/i,
      DEBUG: /DEBUG|TRACE/i,
    };

    for (const [level, regex] of Object.entries(severityMap)) {
      if (regex.test(line)) {
        return level;
      }
    }
    return "INFO";
  }
}
