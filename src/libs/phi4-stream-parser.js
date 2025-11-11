import { Transform } from "stream";

const THINK_START = "<think>";
const THINK_END = "</think>";

/**
 * Transform stream that separates Phi-4 reasoning (<think>...</think>) from the solution tokens.
 * The transform expects incoming chunks that include a `content` string, matching the LM Studio SDK.
 */
export default class Phi4StreamParser extends Transform {
  /**
   * @param {(thought: string) => void} [onThink] optional callback invoked once the think block is available
   */
  constructor(onThink) {
    super({ readableObjectMode: true, writableObjectMode: true });
    this.state = "INITIAL"; // INITIAL -> THINKING -> SOLUTION
    this.buffer = "";
    this.thoughtBuffer = "";
    this.onThink = typeof onThink === "function" ? onThink : null;
  }

  _transform(chunk, encoding, callback) {
    const token = chunk?.content ?? "";

    if (this.state === "SOLUTION") {
      this.push({ content: token });
      return callback();
    }

    this.buffer += token;

    if (this.state === "INITIAL") {
      const startIdx = this.buffer.indexOf(THINK_START);
      if (startIdx !== -1) {
        const leading = this.buffer.slice(0, startIdx);
        if (leading.length > 0) {
          this.push({ content: leading });
        }
        this.state = "THINKING";
        this.thoughtBuffer = this.buffer.slice(startIdx);
        this.buffer = "";
      } else if (this.buffer.length > THINK_START.length) {
        // Flush safe portion to avoid unbounded buffer if no think block appears.
        const flushCount = this.buffer.length - THINK_START.length;
        const safePortion = this.buffer.slice(0, flushCount);
        if (safePortion.length > 0) {
          this.push({ content: safePortion });
        }
        this.buffer = this.buffer.slice(flushCount);
      }
    }

    if (this.state === "THINKING") {
      const endIdx = this.thoughtBuffer.indexOf(THINK_END);
      if (endIdx !== -1) {
        this.state = "SOLUTION";
        const closingIdx = endIdx + THINK_END.length;
        const fullThought = this.thoughtBuffer.slice(0, closingIdx);
        this.#emitThought(fullThought);
        const remainder = this.thoughtBuffer.slice(closingIdx);
        if (remainder.length > 0) {
          this.push({ content: remainder });
        }
        this.thoughtBuffer = "";
      }
    }

    callback();
  }

  _flush(callback) {
    if (this.state === "INITIAL" && this.buffer.length > 0) {
      this.push({ content: this.buffer });
    } else if (this.state === "THINKING" && this.thoughtBuffer.length > 0) {
      // Emit truncated thought if stream aborted mid-think.
      this.#emitThought(`${this.thoughtBuffer}[TRUNCATED_THOUGHT]`);
    }
    callback();
  }

  #emitThought(thought) {
    if (!this.onThink) {
      return;
    }
    try {
      this.onThink(thought);
    } catch (err) {
      // Avoid crashing the stream if the callback throws.
      process.emitWarning(
        err instanceof Error ? err.message : String(err),
        "Phi4StreamParser"
      );
    }
  }
}
