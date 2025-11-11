

# **A Technical Report on Architecting a Multi-Layer NodeJS Client for LM Studio and "Phi 4 Reasoning Plus"**

## **Part 1: Architectural Foundations: The Core LM Studio Client (Layer 1\)**

The initial user requirement is to create a foundational NodeJS library capable of programmatically managing the LM Studio server. This implies functionality beyond simple inference, extending to resource control such as loading models with specific configurations, managing context sizes, and ejecting models from memory.

### **1.1 API and SDK Selection Framework: Choosing the Correct Interface**

An analysis of LM Studio's developer offerings reveals three distinct methods for programmatic interaction.1 The selection of the correct interface is a critical architectural decision that dictates the capabilities of the foundational library.

1. **OpenAI-Compatible REST API:** Hosted at the /v1/ path (e.g., /v1/chat/completions), this API is designed for drop-in compatibility with existing OpenAI clients and libraries.1 It supports primary inference tasks like chat completions and embeddings.2  
2. **Native LM Studio REST API:** Hosted at the /api/v0/ path, this is a bespoke API offering more granular control and detailed information.4 Its endpoints can provide rich data about models, such as their loaded-versus-unloaded state, maximum context length, and quantization details.4  
3. **Official SDKs (@lmstudio/sdk, lmstudio-python):** These are high-level client libraries (e.g., the @lmstudio/sdk for NodeJS/TypeScript) that provide an ergonomic, programmatic interface over the native API and server functions.1

A direct comparison reveals that the OpenAI-Compatible API is fundamentally insufficient for the stated resource management goals. The OpenAI API specification is designed for *inference*, not *server-level resource management*. While a request to /v1/chat/completions 1 can select a model, it cannot programmatically load a new model into VRAM, eject an existing one, or configure a specific contextLength or GPU offload percentage at load time. Any library built solely on this endpoint would fail the primary requirement.

The LM Studio team has explicitly developed the SDKs to manage the full model lifecycle. The SDK documentation provides a comprehensive suite of functions for this exact purpose, including client.llm.load(), client.llm.load\_new\_instance(), and model.unload().7 This is confirmed by developer communication; in a discussion regarding a REST endpoint for unloading models, an LM Studio developer confirmed that this functionality is already and intentionally provided via the SDKs.8

Therefore, the Native REST API 4 is best understood as the low-level transport, and the @lmstudio/sdk is the officially sanctioned and supported method for building a robust, resource-aware client in NodeJS.

The following table provides a comparative analysis to justify this selection.

**Table 1.1: Comparative Analysis of LM Studio Interfacing Methods**

| Feature | OpenAI-Compat API (/v1/) | Native REST API (/api/v0/) | TypeScript SDK (@lmstudio/sdk) |
| :---- | :---- | :---- | :---- |
| **Start/Stop Server** | No | Yes (via lms server CLI) 9 | Yes (via lms server CLI) 9 |
| **List Downloaded Models** | No | Yes (GET /api/v0/models) 4 | Yes (client.llm.listDownloaded()) 5 |
| **List Loaded Models** | No | Yes (GET /api/v0/models, check state) 4 | Yes (client.llm.listLoaded()) 5 |
| **Programmatic Model Load** | No | Yes (via lms load CLI) 9 | Yes (client.llm.load()) 7 |
| **Programmatic Model Eject** | No | Yes (via lms unload CLI) 9 | Yes (model.unload()) 7 |
| **Set contextLength at Load** | No | Yes (via lms load \--context-length) 12 | Yes (via LLMLoadModelConfig) 13 |
| **Set gpu Offload at Load** | No | Yes (via lms load \--gpu) 9 | Yes (via LLMLoadModelConfig) 13 |
| **Chat Completions** | Yes 1 | Yes 4 | Yes (model.respond()) 1 |
| **Streaming Responses** | Yes (stream: true) 15 | Yes | Yes (Async Iterator) 14 |
| **Ease of Use (NodeJS)** | High (with openai pkg) | Low (manual fetch) | High (native SDK) |

**Recommendation:** The Layer 1 library *must* be built using the @lmstudio/sdk to meet all specified requirements.

### **1.2 Implementing Model Resource Management (Layer 1\)**

The Layer 1 library, built with the @lmstudio/sdk, will serve as a resource-aware model cache manager.

#### **1.2.1 Setup and Client Initialization**

The library is initialized by installing the SDK (npm install @lmstudio/sdk) 1 and instantiating the client, which connects to the default LM Studio server.1

TypeScript

import { LMStudioClient } from "@lmstudio/sdk";  
const client \= new LMStudioClient();

#### **1.2.2 Programmatic Model Loading**

A critical distinction exists in the SDK's loading methods 7:

* client.llm.model("model-key"): This is a "get-or-load" singleton pattern. It returns the handle if the model is already loaded or loads it with *default* settings if not.5 This method does not provide the explicit configuration control required.  
* client.llm.load("model-key", config) or client.llm.load\_new\_instance("model-key", config): This is the correct method. It provides explicit control over the load process and guarantees the model is loaded with the *exact* configuration specified.7

The key to fulfilling the user query lies in the LLMLoadModelConfig object, which is passed as the config parameter.13 This object allows precise control over:

* contextLength: number: Explicitly sets the context window size in tokens.13 This is vital, as community reports indicate that loads for models with large contexts can fail if this is not set appropriately.19  
* gpu: GPUSetting: Controls GPU offload (e.g., 0.5 for 50%, or "max").13  
* ttl: number: Sets an "Idle Time-to-Live" in seconds, after which the model will be automatically ejected from memory if unused.10 This is also available via the CLI.12  
* ropeFrequencyBase: number and ropeFrequencyScale: number: Advanced parameters for extending a model's effective context window beyond its original training length.13  
* flashAttention: boolean: Enables Flash Attention for optimized computation.13  
* keepModelInMemory: boolean: Prevents the model from being swapped out of system memory.13

#### **1.2.3 Programmatic Model Ejection**

The SDK provides a simple model.unload() method on the handle returned by load() or load\_new\_instance().7 This, combined with the lms unload CLI command 9, confirms that programmatic ejection is a core, supported feature.

#### **1.2.4 Architectural Design: JIT, TTL-based Model Cache**

The true value of the Layer 1 library is not as a simple 1:1 wrapper but as a resource-aware model cache manager. Given that a single machine has limited VRAM, an application may need to serve multiple models (e.g., Phi-4, Llama-3) by dynamically swapping them. The SDK provides all the necessary tools for this: load\_new\_instance() 7, unload() 8, and the ttl config.10

A robust LMStudioManager class should be designed to handle this Just-in-Time (JIT) loading. A request for a model handle would:

1. Check an internal map of currently-managed model handles.  
2. If not present, call client.llm.load("model-key", {...config, ttl: 300 }).  
3. This JIT-loads the model with its specific configuration and sets a 5-minute (or configurable) auto-eject timer.10  
4. This architecture allows the application to dynamically swap models in and out of VRAM based on demand, which is a far more robust and professional solution than naive, persistent loading.

#### **1.2.5 Utility and State Functions**

The Layer 1 library must also expose essential utility functions derived from the SDK to inform the higher-level application (Layer 2):

* model.getContextLength(): Gets the *currently* loaded context length.20 This is non-negotiable for the Layer 2 library's history management.  
* model.getModelInfo(): Gets rich data about the model, including its state, quantization, and architecture.4

## **Part 2: The Application Library: "Phi 4 Reasoning Plus" Integration (Layer 2\)**

This second library is built *on top of* the Layer 1 client. Its responsibility is to handle the specific, idiosyncratic inputs and outputs of the "Phi 4 Reasoning Plus" model.

### **2.1 Model Analysis: "Phi 4 Reasoning Plus" Internals**

The "Phi 4 Reasoning Plus" model is a 14B to 15B parameter, dense decoder-only Transformer.22 Its unique properties stem from a multi-stage fine-tuning process:

1. **"Reasoning" (SFT):** The base Phi-4 model was first Supervised Finetuned (SFT) on a large, curated dataset of "chain-of-thought (CoT)" traces. This dataset focused on math, science, and coding problems.24  
2. **"Reasoning Plus" (RL):** This SFT model was *further* trained using Reinforcement Learning (RL) on high-quality math problems.25

The "Plus" distinction is not trivial. The RL phase was designed to "allow the model to learn to utilize more inference-time compute".25 This results in the model "generating more detailed and often longer reasoning chains (approximately 1.5 times more tokens than the base Phi-4-reasoning)".25

This has a direct architectural implication: a developer choosing "Phi-4-Reasoning-Plus" is explicitly paying an inference cost (in time and compute) for this extended, verbose reasoning. The Layer 2 library *must* be architected to capture, parse, and expose this reasoning. Simply discarding the reasoning block to show only the final answer would be tantamount to "downgrading" the model to its non-Plus version while still paying the "Plus" inference cost.

### **2.2 Request Formatting: The Phi-4 Prompt Template**

The "Phi 4 Reasoning Plus" model has two distinct and mandatory formatting requirements for its requests.

#### **2.2.1 The Structural Requirement: ChatML**

The Phi-4 model family is finetuned using the "standard chatml format".28 This format uses special tokens to delineate roles, such as \<|im\_start|\> and \<|im\_end|\> 29 or \<|system|\> and \<|end|\>.30 Failure to use this exact format is a common source of errors.32

The Layer 2 library should *not* attempt to concatenate these strings manually. The correct, robust approach is to use the abstractions provided by the @lmstudio/sdk. The library should build an array of Message objects (e.g., { role: "system", content: "..." }) and pass them to the SDK's Chat helper class.14 The model.applyPromptTemplate() function can then be used to correctly format this chat history into the precise token structure the model expects.20

#### **2.2.2 The Content Requirement: The "Reasoning" System Prompt**

The model's characteristic \<think\>...\</think\> output is not an automatic behavior; it is a *commanded* behavior, trained by a specific system prompt.35 The Phi-4 reasoning technical report provides the *exact* "fixed reasoning-focused system message" used during SFT.36

This prompt begins:  
"You are Phi, a language model trained by Microsoft to help users. Your role as an assistant involves thoroughly exploring questions through a systematic thinking process... Please structure your response into two main sections: Thought and Solution using the specified format: \<think\> Thought section \</think\> Solution section...".36  
Failure to provide this *exact* system prompt as the *first* message in the chat history will likely result in the model failing to generate the \<think\>...\</think\> block. Therefore, this is not an optional user parameter. The Layer 2 Phi4Handler library *must* automatically prepend this system prompt to any new chat session as a non-negotiable component of using this model.

### **2.3 Managing Conversational Context and Token Limits**

LLMs are inherently stateless.37 To maintain a conversation, the entire history must be sent with each new request. This combined history and prompt must not exceed the model's contextLength—which for Phi-4-reasoning-plus is 32k tokens.23

The most effective real-time strategy for managing this limitation is a "sliding window" (a First-In, First-Out queue).39 This window must be based on *token count*, not message count, to be accurate.41

However, a naive token-counting implementation will fail. Simply using a generic tokenizer like js-tiktoken 43 to count the tokens in the content of each message is incorrect. This approach fails to account for the (significant) number of tokens used by the ChatML template itself (e.g., \<|im\_start|\>, system, \<|im\_sep|\>, \<|im\_end|\>).29 The *only* accurate way to count the tokens for a given chat history is to ask the *model's* tokenizer, as it is the only "source of truth".44

The @lmstudio/sdk provides the exact workflow for this.20 The correct, model-aware algorithm for the Layer 2 library to truncate its history is as follows:

1. Initialize a new, temporary Chat object 33 starting with the mandatory system prompt.36  
2. Get the model's max context from the Layer 1 client: maxTokens \= await model.getContextLength().20  
3. Reserve a portion of maxTokens for the model's response (e.g., 2048 tokens).46  
4. Iterate through the existing chat history *backwards* (from newest to oldest), skipping the system prompt (which is already included).  
5. For each message, add it to the *front* of the temporary Chat object.  
6. Format this temporary history using the model's template: formatted \= await model.applyPromptTemplate(chat).34  
7. Get the *exact* token count for this formatted history: tokenCount \= await model.countTokens(formatted).45  
8. If tokenCount exceeds the allotted maxTokens, stop and *do not* include this message (or any older messages).  
9. The resulting temporary Chat object contains the perfectly truncated, token-aware history.

This algorithm ensures the chat history *plus* the prompt template *never* exceeds the context window, and it does so with perfect, model-aware accuracy.

## **Part 3: Implementing and Parsing Real-Time Streaming Responses**

A core requirement is to provide the model's response "word by word in realtime."

### **3.1 Approach 1: The SDK-Native Streaming Method (Recommended)**

The @lmstudio/sdk provides a first-class, ergonomic solution for streaming. The model.respond() method, when called with a chat object, returns an *asynchronous iterable*.14 Consuming this stream in NodeJS is trivial.

The following example demonstrates streaming a response word-by-word to the console 1:

TypeScript

import { LMStudioClient, Chat } from "@lmstudio/sdk";  
const client \= new LMStudioClient();  
// Assume model is loaded  
const model \= await client.llm.model("microsoft/Phi-4-reasoning-plus"); 

const chat \= Chat.from(\[36\]);

process.stdout.write("Bot: ");  
for await (const fragment of model.respond(chat)) {  
  process.stdout.write(fragment.content);  
}

Each fragment.content in the loop is a "delta" or new token(s), fulfilling the real-time streaming requirement.14

### **3.2 Approach 2: The Manual API Streaming Method (Advanced)**

For environments where the SDK cannot be used, streaming is possible by manually interfacing with the OpenAI-compatible REST API. This process is significantly more complex.

1. **Request:** An HTTP POST must be made to http://localhost:1234/v1/chat/completions.2 The request body *must* include "stream": true.15  
2. **Client:** In NodeJS, an axios or fetch request must be configured to handle a streaming response (e.g., responseType: 'stream' for axios).49  
3. **Response Parsing:** The server responds with a Content-Type of text/event-stream.47 This is a Server-Sent Events (SSE) stream.  
4. **The "Incomplete Chunk" Problem:** The primary challenge in NodeJS is that a single data event from the stream buffer is *not* guaranteed to contain a full and complete SSE message.53 An SSE message (which starts with data: and ends with \\n\\n) can be split across multiple chunks.54 This necessitates a custom buffer and parser.

This is a non-trivial problem. It is strongly recommended *not* to implement a custom SSE parser. Instead, a dedicated library like eventsource-parser 56, parse-sse 57, or fetch-event-stream 58 should be used to handle the buffering, parsing, and re-assembly of the SSE data chunks. The stream terminates with a data: message.49

### **3.3 The Core Challenge: Parsing "Phi-4-Reasoning" Streams**

The most significant engineering challenge is synthesizing the requirements from Part 2.2 and Part 3.1. The real-time stream from "Phi-4-Reasoning-Plus" will, when prompted correctly, look like this:

\<think\>...many tokens of step-by-step thinking...\</think\>...the final solution....36

A simple process.stdout.write(fragment.content) (from 3.1) will print *everything*, including the raw \<think\> tags, which is not a user-friendly chat experience. The Layer 2 library must *intercept* this stream, *parse* the \<think\> block into a separate variable or event, and *only* stream the "Solution" part to the main chat output.

A naive solution—buffering the entire response and then using a non-greedy regex like /\<think\>(.\*?)\<\\/think\>/s 27—*completely fails* the "real-time streaming" requirement. The challenge is to parse this structure *from an incomplete, incoming stream of tokens*. As noted in technical literature, regex engines are not typically designed for this, making it a difficult problem.64

This is not a theoretical problem. Community reports confirm that this is extremely flaky. Common failure modes include:

1. **Model Failure:** The model starts reasoning with \<think\> but *never* outputs the \</think\> closing tag.65  
2. **Infrastructure Failure:** The server backend (e.g., vLLM, Ollama) *pre-parses* the \<think\> tags and *strips them* from the stream before they ever reach the client, moving them to a metadata field.66

The only robust solution is to implement a **Finite-State Machine (FSM) Stream Parser**. The Layer 2 library must implement this as a custom NodeJS TransformStream. This FSM will manage the parsing state as each individual token arrives.

**FSM Design:**

* **State: INITIAL**  
  * **Action:** Buffer incoming tokens. Watch for the *start* of the \<think\> tag.  
  * **Transition \-\> THINKING:** If the buffer includes \<think\>, transition state. Emit any preceding text (e.g., whitespace) as a "preamble" or discard it. Begin buffering subsequent tokens into a separate thought\_buffer.  
  * **Transition \-\> SOLUTION:** If the stream ends (\`\`) and \<think\> was never seen (handling Infrastructure Failure 66), transition state and flush the entire buffer as the solution.  
* **State: THINKING**  
  * **Action:** Buffer all incoming tokens into the thought\_buffer. Do *not* pass these tokens to the main output stream. Watch for the *end* of the \</think\> tag.  
  * **Transition \-\> SOLUTION:** If the buffer includes \</think\>, transition state. Emit the *entire* thought\_buffer as a single, discrete event (e.g., onThink(thought\_buffer)). Pass all *subsequent* tokens (those after the \</think\> tag) downstream as the word-by-word solution.  
  * **Transition \-\> ERROR\_TRUNCATED:** If the stream ends (\`\`) *before* \</think\> is seen (handling Model Failure 65), transition state. Emit the thought\_buffer as a *truncated* thought and signal an error.  
* **State: SOLUTION**  
  * **Action:** Pass all incoming tokens *directly* to the output stream. This provides the "word-by-word" solution.

## **Part 4: Synthesis and Final Library Design (Code Architecture)**

The following TypeScript code provides the architectural design for the two-tiered library system.

### **4.1 Library 1: LMStudioManager (Layer 1 \- Resource Management)**

This class provides the robust, JIT-based client for managing LM Studio server resources.

**File: LMStudioManager.ts**

TypeScript

import { LMStudioClient, LLMLoadModelConfig, LLM } from "@lmstudio/sdk";

// Define the type for the model handle returned by the SDK  
type ModelHandle \= LLM;

/\*\*  
 \* Manages the LM Studio server resources, specifically focusing on  
 \* Just-in-Time (JIT) model loading, configuration, and ejection.  
 \*/  
export class LMStudioManager {  
  private client: LMStudioClient;  
  // Internal cache to manage handles of models loaded by this class  
  private loadedModels: Map\<string, ModelHandle\>;

  constructor() {  
    this.client \= new LMStudioClient(); // Connect to default server   
    this.loadedModels \= new Map();  
  }

  /\*\*  
   \* Gets a handle to a model. If not already loaded by this manager,  
   \* it will be JIT-loaded with the specified configuration.  
   \*  
   \* @param modelKey The identifier of the model (e.g., "microsoft/Phi-4-reasoning-plus")  
   \* @param config The explicit load configuration   
   \* @returns A promise that resolves to the model handle  
   \*/  
  async getModel(  
    modelKey: string,  
    config: Partial\<LLMLoadModelConfig\> \= {},  
  ): Promise\<ModelHandle\> {  
    if (this.loadedModels.has(modelKey)) {  
      // TODO: Add a check to see if the existing handle's config matches  
      return this.loadedModels.get(modelKey)\!;  
    }

    console.log(\`JIT Loading model: ${modelKey}\`);  
      
    // Use client.llm.load for explicit config control   
    const model \= await this.client.llm.load(modelKey, {  
      // Provide sane defaults, overridden by user config  
      contextLength: config.contextLength |

| 8192, //   
      gpu: config.gpu |

| "auto", //   
      ttl: config.ttl |

| 300, // 5-minute auto-eject \[10, 12\]  
     ...config,  
    });

    this.loadedModels.set(modelKey, model);  
    return model;  
  }

  /\*\*  
   \* Explicitly ejects a model from VRAM.  
   \*  
   \* @param modelKey The identifier of the model to eject  
   \*/  
  async ejectModel(modelKey: string): Promise\<void\> {  
    if (this.loadedModels.has(modelKey)) {  
      console.log(\`Ejecting model: ${modelKey}\`);  
      const model \= this.loadedModels.get(modelKey)\!;  
        
      await model.unload(); //   
        
      this.loadedModels.delete(modelKey);  
    } else {  
      console.warn(\`Model ${modelKey} not found in manager cache. It may still be loaded in LM Studio.\`);  
    }  
  }

  /\*\*  
   \* Ejects all models currently managed by this class.  
   \*/  
  async ejectAll(): Promise\<void\> {  
    const allKeys \= Array.from(this.loadedModels.keys());  
    for (const key of allKeys) {  
      await this.ejectModel(key);  
    }  
  }  
}

### **4.2 Library 2: Phi4Handler (Layer 2 \- Interaction Management)**

This class consumes the LMStudioManager and implements all "Phi-4-Reasoning-Plus" specific logic, including prompt injection, context management, and the FSM stream parser.

**File: Phi4StreamParser.ts**

TypeScript

import { Transform } from "stream";

// Type for the streamed token fragment from the SDK  
type SdkTokenFragment \= { content: string };

/\*\*  
 \* This is a NodeJS TransformStream implementing the Finite-State Machine (FSM)  
 \* required to parse the \<think\>...\</think\> block from a real-time  
 \* Phi-4-Reasoning stream (see Part 3.3).  
 \*/  
export class Phi4StreamParser extends Transform {  
  private state: "INITIAL" | "THINKING" | "SOLUTION" \= "INITIAL";  
  private buffer: string \= "";  
  private thought\_buffer: string \= "";

  /\*\*  
   \* @param onThink A callback function that will be invoked with the  
   \*                full \<think\> block content once it is fully received.  
   \*/  
  constructor(private onThink: (thought: string) \=\> void) {  
    // We are processing object chunks from the SDK stream  
    super({ readableObjectMode: true, writableObjectMode: true });  
  }

  \_transform(  
    chunk: SdkTokenFragment,  
    encoding: string,  
    callback: Function,  
  ): void {  
    const token \= chunk.content |

| "";

    if (this.state \=== "SOLUTION") {  
      // State 3: Solution. Pass all tokens directly through.  
      this.push(chunk);  
      return callback();  
    }

    this.buffer \+= token;

    if (this.state \=== "INITIAL") {  
      // State 1: Initial. Watch for \<think\> tag.  
      const thinkStartTag \= "\<think\>";  
      if (this.buffer.includes(thinkStartTag)) {  
        this.state \= "THINKING";  
          
        // Extract the thought buffer, starting from the tag  
        this.thought\_buffer \= this.buffer.substring(  
          this.buffer.indexOf(thinkStartTag)  
        );  
        this.buffer \= ""; // Clear the main buffer  
      }  
    }  
      
    if (this.state \=== "THINKING") {  
      // State 2: Thinking. Buffer until \</think\> tag.  
      this.thought\_buffer \+= token; // Add to thought buffer (was already in main buffer)  
        
      const thinkEndTag \= "\</think\>";  
      if (this.thought\_buffer.includes(thinkEndTag)) {  
        this.state \= "SOLUTION";  
          
        // Find the complete thought block  
        const thinkEndIndex \= this.thought\_buffer.indexOf(thinkEndTag) \+ thinkEndTag.length;  
        const fullThought \= this.thought\_buffer.substring(0, thinkEndIndex);  
          
        // Emit the 'onThink' event with the full reasoning block  
        this.onThink(fullThought);   
          
        // Push any remaining tokens \*after\* the tag as the first solution token  
        const solutionStart \= this.thought\_buffer.substring(thinkEndIndex);  
        if (solutionStart.length \> 0) {  
          this.push({ content: solutionStart });  
        }  
          
        this.thought\_buffer \= ""; // Clear the thought buffer  
      }  
    }  
      
    callback();  
  }

  \_flush(callback: Function): void {  
    // Handle the end of the stream  
    if (this.state \=== "INITIAL") {  
      // Failure Mode 2: No \<think\> tag was ever found. Flush buffer as solution.  
      if (this.buffer.length \> 0) {  
        this.push({ content: this.buffer });  
      }  
    } else if (this.state \=== "THINKING") {  
      // Failure Mode 1: \<think\> tag was unclosed. Emit truncated thought.  
      this.onThink(\`: ${this.thought\_buffer}\`);  
    }  
    callback();  
  }  
}

**File: Phi4Handler.ts**

TypeScript

import { LMStudioManager } from "./LMStudioManager";  
import { Phi4StreamParser } from "./Phi4StreamParser";  
import { Chat, LLM, LLMLoadModelConfig, Message } from "@lmstudio/sdk";  
import { Writable } from "stream";

// Define the event handler types for the chatStream method  
type OnTokenHandler \= (token: string) \=\> void;  
type OnThinkHandler \= (thought: string) \=\> void;  
type OnErrorHandler \= (error: string) \=\> void;

/\*\*  
 \* Implements the Layer 2 logic for interacting specifically with  
 \* "Phi 4 Reasoning Plus".  
 \*/  
export class Phi4Handler {  
  private manager: LMStudioManager;  
  private model: LLM | null \= null;  
  private chatHistory: Message;  
    
  // The mandatory, hard-coded system prompt   
  private readonly PHI\_4\_SYSTEM\_PROMPT: string \= "You are Phi, a language model trained by Microsoft to help users. Your role as an assistant involves thoroughly exploring questions through a systematic thinking process before providing the final precise and accurate solutions. This requires engaging in a comprehensive cycle of analysis, summarizing, exploration, reassessment, reflection, backtracing, and iteration to develop well-considered thinking process. Please structure your response into two main sections: Thought and Solution using the specified format: \<think\> Thought section \</think\> Solution section.";  
    
  // Model key for Phi-4-Reasoning-Plus. Can be made configurable.  
  private readonly MODEL\_KEY \= "microsoft/Phi-4-reasoning-plus"; 

  constructor(manager: LMStudioManager) {  
    this.manager \= manager;  
    // Initialize chat history with the mandatory prompt  
    this.chatHistory \=;  
  }

  /\*\*  
   \* Loads the Phi-4 model using the Layer 1 manager.  
   \*/  
  async load(config: Partial\<LLMLoadModelConfig\> \= {}): Promise\<void\> {  
    this.model \= await this.manager.getModel(this.MODEL\_KEY, {  
      contextLength: 32768, // Default for Phi-4 \[23, 25\]  
     ...config,  
    });  
  }

  /\*\*  
   \* Ejects the Phi-4 model.  
   \*/  
  async eject(): Promise\<void\> {  
    await this.manager.ejectModel(this.MODEL\_KEY);  
    this.model \= null;  
  }  
    
  /\*\*  
   \* Resets the chat history, preserving the system prompt.  
   \*/  
  clearHistory(): void {  
    this.chatHistory \=;  
  }

  /\*\*  
   \* Sends a prompt to the model and streams the response.  
   \* Handles \<think\> block parsing and chat history management.  
   \*  
   \* @param prompt The new user prompt.  
   \* @param onToken Callback for each "solution" token.  
   \* @param onThink Callback for the complete "\<think\>..." block.  
   \* @param onError Callback for any errors.  
   \*/  
  async chatStream(  
    prompt: string,  
    onToken: OnTokenHandler,  
    onThink: OnThinkHandler,  
    onError: OnErrorHandler  
  ): Promise\<void\> {  
    if (\!this.model) {  
      onError("Model not loaded. Call load() first.");  
      return;  
    }

    // 1\. Add new prompt to history  
    this.chatHistory.push({ role: "user", content: prompt });

    try {  
      // 2\. Manage history (Token-Aware Sliding Window)  
      this.chatHistory \= await this.truncateHistory();

      // 3\. Get the raw stream from the SDK   
      const stream \= await this.model.respond(this.chatHistory);

      // 4\. Create the FSM parser instance  
      const parser \= new Phi4StreamParser((thought) \=\> {  
        onThink(thought); // The parser fires the onThink event  
      });

      // 5\. Pipe the SDK stream through the FSM parser  
      // We also need to capture the final solution for our history  
      let assistantResponse \= "";  
        
      const solutionStream \= stream.pipeThrough(parser);  
        
      for await (const fragment of solutionStream) {  
        const token \= (fragment as SdkTokenFragment).content;  
        onToken(token);  
        assistantResponse \+= token;  
      }  
        
      // 6\. Add the final \*solution\* (not the thought) to history  
      if (assistantResponse.length \> 0) {  
        this.chatHistory.push({ role: "assistant", content: assistantResponse });  
      }

    } catch (err: any) {  
      onError(err.message);  
      // Optional: Remove the user's prompt from history if the call failed  
      this.chatHistory.pop();  
    }  
  }

  /\*\*  
   \* Implements the Token-Aware Sliding Window algorithm (see 2.3.3).  
   \* Ensures the chat history fits within the model's context limit.  
   \*/  
  private async truncateHistory(): Promise\<Message\> {  
    if (\!this.model) throw new Error("Model not set for history truncation");

    // Get max context and reserve 2048 tokens for the answer \[21, 46\]  
    const maxTokens \= (await this.model.getContextLength()) \- 2048;   
      
    // Always keep the system prompt   
    const systemPrompt \= this.chatHistory;  
    const mutableHistory \= this.chatHistory.slice(1);  
      
    const truncatedHistory: Message \= \[systemPrompt\];  
    let currentTokenCount \= 0;

    // Iterate backwards (newest to oldest)  
    for (let i \= mutableHistory.length \- 1; i \>= 0; i--) {  
      const messagesToTest \= \[  
        systemPrompt,   
       ...mutableHistory.slice(i) // All messages from this one to the end  
      \];  
        
      const chat \= Chat.from(messagesToTest); //   
        
      // The only accurate way to count: format and then count   
      const formatted \= await this.model.applyPromptTemplate(chat);  
      const tokenCount \= await this.model.countTokens(formatted);

      if (tokenCount \> maxTokens) {  
        // This message (and all older) would cause an overflow. Stop.  
        break;   
      }  
        
      // This history configuration fits.  
      // We store the messages in the correct (oldest to newest) order.  
      truncatedHistory.splice(1, 0, mutableHistory\[i\]);  
      currentTokenCount \= tokenCount;  
    }  
      
    return truncatedHistory;  
  }  
}

## **Part 5: Conclusions and Recommendations**

The provided two-layer architecture fulfills all requirements of the user query.

* **Layer 1 (LMStudioManager)** provides a robust, JIT-based resource manager for the LM Studio server, directly addressing the need to control model loading, ejection, and configuration parameters like contextLength.8  
* **Layer 2 (Phi4Handler)** provides a specialized, model-aware client for "Phi-4-Reasoning-Plus." It automatically handles the mandatory system prompt 36, implements a token-aware sliding window for context management 34, and, most critically, uses a Finite-State Machine parser to separate the \<think\> block from the "solution" in a real-time stream.14

Developers implementing this solution must remain aware of three critical failure modes:

1. **Infrastructure Failure (Server-Side Parsing):** Some server backends (e.g., vLLM or llama-server) can be configured with a reasoning\_parser that *intercepts* and *strips* the \<think\> tags from the stream, moving them to a metadata field.66 This will break the client-side Phi4StreamParser. The LM Studio server configuration must be verified to ensure it is passing the raw, unmodified token stream to the client.  
2. **Model Failure (Unclosed Tag):** The model may generate \<think\> but fail to generate a corresponding \</think\> before ending its generation.65 The provided Phi4StreamParser is designed to handle this: its \_flush method detects the unclosed THINKING state and emits the content as a \`\`, preventing the application from hanging.  
3. **Prompting Failure (Missing System Prompt):** Failure to provide the specific "You are Phi..." system prompt 36 will result in the model *not* generating the \<think\> block. The provided Phi4Handler class mitigates this entirely by hard-coding this prompt in its constructor, ensuring it is always the first message in any new chat session.

#### **Bibliografia**

1. LM Studio Developer Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/developer](https://lmstudio.ai/docs/developer)  
2. OpenAI Compatibility Endpoints | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/developer/openai-compat](https://lmstudio.ai/docs/developer/openai-compat)  
3. Use OpenAI's Responses API with local models | LM Studio Blog, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/blog/lmstudio-v0.3.29](https://lmstudio.ai/blog/lmstudio-v0.3.29)  
4. REST API v0 | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/developer/rest/endpoints](https://lmstudio.ai/docs/developer/rest/endpoints)  
5. lmstudio-js (TypeScript SDK) | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript](https://lmstudio.ai/docs/typescript)  
6. llms.txt \- LM Studio, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/llms.txt](https://lmstudio.ai/llms.txt)  
7. Manage Models in Memory | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python/manage-models/loading](https://lmstudio.ai/docs/python/manage-models/loading)  
8. Unloading a model programmatically · Issue \#267 · lmstudio-ai/lmstudio-js \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/lmstudio-ai/lmstudio-js/issues/267](https://github.com/lmstudio-ai/lmstudio-js/issues/267)  
9. lms — LM Studio's CLI | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/cli](https://lmstudio.ai/docs/cli)  
10. Manage Models in Memory | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript/manage-models/loading](https://lmstudio.ai/docs/typescript/manage-models/loading)  
11. lms unload | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/cli/unload](https://lmstudio.ai/docs/cli/unload)  
12. lms load | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/cli/load](https://lmstudio.ai/docs/cli/load)  
13. LLMLoadModelConfig | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config](https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config)  
14. Chat Completions | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript/llm-prediction/chat-completion](https://lmstudio.ai/docs/typescript/llm-prediction/chat-completion)  
15. Responses | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/developer/openai-compat/responses](https://lmstudio.ai/docs/developer/openai-compat/responses)  
16. lmstudio-ai/lmstudio-js: LM Studio TypeScript SDK \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/lmstudio-ai/lmstudio-js](https://github.com/lmstudio-ai/lmstudio-js)  
17. lmstudio-python (Python SDK) | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python](https://lmstudio.ai/docs/python)  
18. Configuring the Model | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python/llm-prediction/parameters](https://lmstudio.ai/docs/python/llm-prediction/parameters)  
19. does not load a model if context size is "too big" · Issue \#111 · lmstudio-ai/lms \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/lmstudio-ai/lms/issues/111](https://github.com/lmstudio-ai/lms/issues/111)  
20. Get Context Length | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python/model-info/get-context-length](https://lmstudio.ai/docs/python/model-info/get-context-length)  
21. Get Context Length | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript/model-info/get-context-length](https://lmstudio.ai/docs/typescript/model-info/get-context-length)  
22. Phi-4 \- a microsoft Collection \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/collections/microsoft/phi-4](https://huggingface.co/collections/microsoft/phi-4)  
23. microsoft/Phi-4-reasoning-plus \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/microsoft/Phi-4-reasoning-plus](https://huggingface.co/microsoft/Phi-4-reasoning-plus)  
24. Phi-4-Reasoning-Onnx \- AI Model Catalog | Azure AI Foundry Models, accesso eseguito il giorno novembre 11, 2025, [https://ai.azure.com/catalog/models/Phi-4-reasoning-plus-onnx](https://ai.azure.com/catalog/models/Phi-4-reasoning-plus-onnx)  
25. How to Run Phi-4 Reasoning (with Free API, Locally with Ollama) \- Apidog, accesso eseguito il giorno novembre 11, 2025, [https://apidog.com/blog/phi-4-reasoning/](https://apidog.com/blog/phi-4-reasoning/)  
26. cortexso/phi-4-reasoning \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/cortexso/phi-4-reasoning](https://huggingface.co/cortexso/phi-4-reasoning)  
27. Phi-4-Reasoning: Building Smarter AI Agents with 14B Param \- Labellerr, accesso eseguito il giorno novembre 11, 2025, [https://www.labellerr.com/blog/phi-4-reasoning-model/](https://www.labellerr.com/blog/phi-4-reasoning-model/)  
28. Phi-4 Technical Report \- Microsoft, accesso eseguito il giorno novembre 11, 2025, [https://www.microsoft.com/en-us/research/wp-content/uploads/2024/12/P4TechReport.pdf](https://www.microsoft.com/en-us/research/wp-content/uploads/2024/12/P4TechReport.pdf)  
29. vanilj/Phi-4/template \- Ollama, accesso eseguito il giorno novembre 11, 2025, [https://ollama.com/vanilj/Phi-4:latest/blobs/1ae29500b4be](https://ollama.com/vanilj/Phi-4:latest/blobs/1ae29500b4be)  
30. microsoft/Phi-4-mini-instruct \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/microsoft/Phi-4-mini-instruct](https://huggingface.co/microsoft/Phi-4-mini-instruct)  
31. microsoft/Phi-3-mini-128k-instruct \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/microsoft/Phi-3-mini-128k-instruct](https://huggingface.co/microsoft/Phi-3-mini-128k-instruct)  
32. Error in template when trying to use phi-4-reasoning-plus-bf16 · Issue \#654 \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/654](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/654)  
33. Working with Chats | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python/llm-prediction/working-with-chats](https://lmstudio.ai/docs/python/llm-prediction/working-with-chats)  
34. Tokenization | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/python/tokenization](https://lmstudio.ai/docs/python/tokenization)  
35. Fine-Tuning Phi-4 Reasoning: A Step-By-Step Guide | DataCamp, accesso eseguito il giorno novembre 11, 2025, [https://www.datacamp.com/tutorial/fine-tuning-phi-4-reasoning](https://www.datacamp.com/tutorial/fine-tuning-phi-4-reasoning)  
36. Papers Explained 358: Phi-4-Reasoning | by Ritvik Rastogi \- Medium, accesso eseguito il giorno novembre 11, 2025, [https://ritvik19.medium.com/papers-explained-358-phi-4-reasoning-98c1d3b5e52d](https://ritvik19.medium.com/papers-explained-358-phi-4-reasoning-98c1d3b5e52d)  
37. Keeping State (TypeScript) \- Microsoft Learn, accesso eseguito il giorno novembre 11, 2025, [https://learn.microsoft.com/en-us/microsoftteams/platform/teams-ai-library/typescript/in-depth-guides/ai/keeping-state](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-ai-library/typescript/in-depth-guides/ai/keeping-state)  
38. Prompt engineering \- OpenAI API, accesso eseguito il giorno novembre 11, 2025, [https://platform.openai.com/docs/guides/prompt-engineering](https://platform.openai.com/docs/guides/prompt-engineering)  
39. Infinite chat using a sliding window \- Surface Duo Blog, accesso eseguito il giorno novembre 11, 2025, [https://devblogs.microsoft.com/surface-duo/android-openai-chatgpt-16/](https://devblogs.microsoft.com/surface-duo/android-openai-chatgpt-16/)  
40. How do you currently manage conversation history and user context in your LLM-api apps, and what challenges or costs do you face as your interactions grow longer or more complex? : r/AI\_Agents \- Reddit, accesso eseguito il giorno novembre 11, 2025, [https://www.reddit.com/r/AI\_Agents/comments/1ld1ey0/how\_do\_you\_currently\_manage\_conversation\_history/](https://www.reddit.com/r/AI_Agents/comments/1ld1ey0/how_do_you_currently_manage_conversation_history/)  
41. Creating and managing a chat history object \- Microsoft Learn, accesso eseguito il giorno novembre 11, 2025, [https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/chat-history](https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/chat-history)  
42. Managing the Context Window of GPT-4o-mini in JavaScript \- DEV Community, accesso eseguito il giorno novembre 11, 2025, [https://dev.to/grzegorz\_dubiel\_db99203fe/managing-the-context-window-of-gpt-4o-mini-in-javascript-1o1e](https://dev.to/grzegorz_dubiel_db99203fe/managing-the-context-window-of-gpt-4o-mini-in-javascript-1o1e)  
43. 3 Strategies to Overcome OpenAI Token Limits \- Bret Cameron, accesso eseguito il giorno novembre 11, 2025, [https://www.bretcameron.com/blog/three-strategies-to-overcome-open-ai-token-limits](https://www.bretcameron.com/blog/three-strategies-to-overcome-open-ai-token-limits)  
44. How to truncate Chat history to a fixed token count in an LCEL+RunnableWithMessageHistory RAG chain \#21041 \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/langchain-ai/langchain/discussions/21041](https://github.com/langchain-ai/langchain/discussions/21041)  
45. Tokenization | LM Studio Docs, accesso eseguito il giorno novembre 11, 2025, [https://lmstudio.ai/docs/typescript/tokenization](https://lmstudio.ai/docs/typescript/tokenization)  
46. Truncating conversation history for OpenAI chat completions \- pamela fox's blog, accesso eseguito il giorno novembre 11, 2025, [http://blog.pamelafox.org/2024/06/truncating-conversation-history-for.html](http://blog.pamelafox.org/2024/06/truncating-conversation-history-for.html)  
47. Streaming API responses \- OpenAI Platform, accesso eseguito il giorno novembre 11, 2025, [https://platform.openai.com/docs/guides/streaming-responses](https://platform.openai.com/docs/guides/streaming-responses)  
48. JavaScript (Node.js) Quick Start Guide for /v1/chat/completions API | Heroku Dev Center, accesso eseguito il giorno novembre 11, 2025, [https://devcenter.heroku.com/articles/heroku-inference-quickstart-javascript-v1-chat-completions](https://devcenter.heroku.com/articles/heroku-inference-quickstart-javascript-v1-chat-completions)  
49. How do I Stream OpenAI's completion API? \- Stack Overflow, accesso eseguito il giorno novembre 11, 2025, [https://stackoverflow.com/questions/73547502/how-do-i-stream-openais-completion-api](https://stackoverflow.com/questions/73547502/how-do-i-stream-openais-completion-api)  
50. HTTP Stream using Axios (Node JS) \- javascript \- Stack Overflow, accesso eseguito il giorno novembre 11, 2025, [https://stackoverflow.com/questions/71534322/http-stream-using-axios-node-js](https://stackoverflow.com/questions/71534322/http-stream-using-axios-node-js)  
51. How to use stream: true? · Issue \#18 · openai/openai-node \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/openai/openai-node/issues/18](https://github.com/openai/openai-node/issues/18)  
52. How to stream data over HTTP using Node and Fetch API \- DEV Community, accesso eseguito il giorno novembre 11, 2025, [https://dev.to/bsorrentino/how-to-stream-data-over-http-using-node-and-fetch-api-4ij2](https://dev.to/bsorrentino/how-to-stream-data-over-http-using-node-and-fetch-api-4ij2)  
53. API Stream mode coding for Javascript(Successful) \- OpenAI Developer Community, accesso eseguito il giorno novembre 11, 2025, [https://community.openai.com/t/api-stream-mode-coding-for-javascript-successful/110889](https://community.openai.com/t/api-stream-mode-coding-for-javascript-successful/110889)  
54. OpenAI Completion Stream with Node.js and Express.js \- Stack Overflow, accesso eseguito il giorno novembre 11, 2025, [https://stackoverflow.com/questions/76137987/openai-completion-stream-with-node-js-and-express-js](https://stackoverflow.com/questions/76137987/openai-completion-stream-with-node-js-and-express-js)  
55. Stream response from \`/v1/chat/completions\` endpoint is missing the first token \- API, accesso eseguito il giorno novembre 11, 2025, [https://community.openai.com/t/stream-response-from-v1-chat-completions-endpoint-is-missing-the-first-token/187835](https://community.openai.com/t/stream-response-from-v1-chat-completions-endpoint-is-missing-the-first-token/187835)  
56. Unable to Stream OpenAI Response to Client Using eventsource-parser and Next.js Edge Runtime \- Stack Overflow, accesso eseguito il giorno novembre 11, 2025, [https://stackoverflow.com/questions/76059995/unable-to-stream-openai-response-to-client-using-eventsource-parser-and-next-js](https://stackoverflow.com/questions/76059995/unable-to-stream-openai-response-to-client-using-eventsource-parser-and-next-js)  
57. sindresorhus/parse-sse: Parse Server-Sent Events (SSE) from a Response \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/sindresorhus/parse-sse](https://github.com/sindresorhus/parse-sse)  
58. fetch-event-stream \- NPM, accesso eseguito il giorno novembre 11, 2025, [https://www.npmjs.com/package/fetch-event-stream](https://www.npmjs.com/package/fetch-event-stream)  
59. OpenAI SSE (Server-Sent Events) Streaming API | by David Richards | Feb, 2023 | Better Programming \- Medium, accesso eseguito il giorno novembre 11, 2025, [https://medium.com/better-programming/openai-sse-sever-side-events-streaming-api-733b8ec32897](https://medium.com/better-programming/openai-sse-sever-side-events-streaming-api-733b8ec32897)  
60. Phi-4-reasoning Technical Report \- Microsoft, accesso eseguito il giorno novembre 11, 2025, [https://www.microsoft.com/en-us/research/wp-content/uploads/2025/04/phi\_4\_reasoning.pdf](https://www.microsoft.com/en-us/research/wp-content/uploads/2025/04/phi_4_reasoning.pdf)  
61. microsoft/Phi-4-reasoning \- Hugging Face, accesso eseguito il giorno novembre 11, 2025, [https://huggingface.co/microsoft/Phi-4-reasoning](https://huggingface.co/microsoft/Phi-4-reasoning)  
62. HTML regex (regex remove html tags) \- UI Bakery, accesso eseguito il giorno novembre 11, 2025, [https://uibakery.io/regex-library/html](https://uibakery.io/regex-library/html)  
63. Regex select all text between tags \- Stack Overflow, accesso eseguito il giorno novembre 11, 2025, [https://stackoverflow.com/questions/7167279/regex-select-all-text-between-tags](https://stackoverflow.com/questions/7167279/regex-select-all-text-between-tags)  
64. What is the right algorithm to match regex on a stream?, accesso eseguito il giorno novembre 11, 2025, [https://softwareengineering.stackexchange.com/questions/406733/what-is-the-right-algorithm-to-match-regex-on-a-stream](https://softwareengineering.stackexchange.com/questions/406733/what-is-the-right-algorithm-to-match-regex-on-a-stream)  
65. microsoft/Phi-4-reasoning-plus · Running with VLLM is not printing '  
66. Think tags missing : r/LocalLLaMA \- Reddit, accesso eseguito il giorno novembre 11, 2025, [https://www.reddit.com/r/LocalLLaMA/comments/1nceqny/think\_tags\_missing/](https://www.reddit.com/r/LocalLLaMA/comments/1nceqny/think_tags_missing/)  
67. \[Bug\]: When running phi-4-reasoning-plus with vLLM, the model gets stuck repeating reasoning phrases · Issue \#18141 \- GitHub, accesso eseguito il giorno novembre 11, 2025, [https://github.com/vllm-project/vllm/issues/18141](https://github.com/vllm-project/vllm/issues/18141)