import LMStudioManager from './lmstudio-api.js';
import { Chat } from '@lmstudio/sdk';
import { Transform } from 'stream';

const PHI4_SYSTEM_PROMPT = 
  "You are Phi, a language model trained by Microsoft to help users. Your role as an assistant involves thoroughly exploring questions through a systematic thinking process before providing the final precise and accurate solutions. This requires engaging in a comprehensive cycle of analysis, summarizing, exploration, reassessment, reflection, backtracing, and iteration to develop well-considered thinking process. Please structure your response into two main sections Thought and Solution using the specified format think Thought section think Solution section.";

const MODEL_KEY = "microsoft/Phi-4-reasoning-plus";

class Phi4StreamParser extends Transform {
  constructor(onThink) {
    super({ readableObjectMode: true, writableObjectMode: true });
    this.state = 'INITIAL'; // 'INITIAL', 'THINKING', 'SOLUTION'
    this.buffer = '';
    this.thoughtBuffer = '';
    this.onThink = onThink;
  }

  _transform(chunk, encoding, callback) {
    const token = chunk.content || '';
    if (this.state === 'SOLUTION') {
      this.push(chunk);
      return callback();
    }
    this.buffer += token;

    if (this.state === 'INITIAL') {
      const thinkStart = 'think';
      if (this.buffer.includes(thinkStart)) {
        this.state = 'THINKING';
        this.thoughtBuffer = this.buffer.slice(this.buffer.indexOf(thinkStart));
        this.buffer = '';
      }
    }
    if (this.state === 'THINKING') {
      this.thoughtBuffer += token;
      const thinkEnd = 'think';
      if (this.thoughtBuffer.includes(thinkEnd, 1)) { // Find the closing tag after the opening
        this.state = 'SOLUTION';
        const endIdx = this.thoughtBuffer.indexOf(thinkEnd, 1) + thinkEnd.length;
        const fullThought = this.thoughtBuffer.slice(0, endIdx);
        if (this.onThink) this.onThink(fullThought);
        // Push remaining as solution
        const solutionStart = this.thoughtBuffer.slice(endIdx);
        if (solutionStart.length > 0) this.push({ content: solutionStart });
        this.thoughtBuffer = '';
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.state === 'INITIAL' && this.buffer.length) {
      this.push({ content: this.buffer });
    } else if (this.state === 'THINKING') {
      if (this.onThink) this.onThink(this.thoughtBuffer);
    }
    callback();
  }
}

export class Phi4Handler {
  constructor(manager) {
    this.manager = manager;
    this.model = null;
    this.chatHistory = [{ role: 'system', content: PHI4_SYSTEM_PROMPT }];
  }

  async load(config = {}) {
    this.model = await this.manager.getModel(MODEL_KEY, {
      contextLength: 32768,
      ...config,
    });
  }

  async eject() {
    await this.manager.ejectModel(MODEL_KEY);
    this.model = null;
  }

  clearHistory() {
    this.chatHistory = [{ role: 'system', content: PHI4_SYSTEM_PROMPT }];
  }

  async chatStream(prompt, onToken, onThink, onError) {
    if (!this.model) {
      if (onError) onError("Model not loaded. Call load first.");
      return;
    }
    this.chatHistory.push({ role: 'user', content: prompt });
    try {
      this.chatHistory = await this._truncateHistory();
      const chat = Chat.from(this.chatHistory);
      const stream = await this.model.respond(chat);

      const parser = new Phi4StreamParser(onThink);
      let assistantResponse = '';
      const solutionStream = stream.pipeThrough(parser);

      for await (const fragment of solutionStream) {
        const token = fragment.content;
        if (onToken) onToken(token);
        assistantResponse += token;
      }
      if (assistantResponse.length > 0) {
        this.chatHistory.push({ role: 'assistant', content: assistantResponse });
      }
    } catch (err) {
      if (onError) onError(err.message);
      this.chatHistory.pop(); // Remove user message if error
    }
  }

  async _truncateHistory() {
    if (!this.model) throw new Error("Model not set for history truncation");
    const maxTokens = (await this.model.getContextLength()) - 2048;
    const systemPrompt = this.chatHistory[0];
    const mutableHistory = this.chatHistory.slice(1);
    const truncatedHistory = [systemPrompt];

    for (let i = mutableHistory.length - 1; i >= 0; i--) {
      const messagesToTest = [systemPrompt, ...mutableHistory.slice(i)];
      const chat = Chat.from(messagesToTest);
      const formatted = await this.model.applyPromptTemplate(chat);
      const tokenCount = await this.model.countTokens(formatted);
      if (tokenCount > maxTokens) break;
      truncatedHistory.splice(1, 0, mutableHistory[i]);
    }
    return truncatedHistory;
  }
}

export default Phi4Handler;

/* Example usage:

import LMStudioManager from './lmstudio-api.js';
import Phi4Handler from './lms-phi4.js';

const manager = new LMStudioManager();
const phi4 = new Phi4Handler(manager);

await phi4.load(); // Optionally pass config, e.g., {gpu: 'auto', contextLength: 32768}
await phi4.chatStream(
  "Explain the Riemann Hypothesis.",
  token => process.stdout.write(token),
  thought => console.log("THINK BLOCK:", thought),
  err => console.error("Error:", err)
);

*/