import { createKnowledgeRuntime } from "../libs/knowledge-runtime.js";

/** UI choices override configuration for this session only. */
export function createUiKnowledgeControl({ session, configData, runtimeFactory = createKnowledgeRuntime }) {
  let disposed = false;
  const configureKnowledge = async function (enabled) {
    if (disposed) return { enabled: false, status: "Off" };
    if (session.context.nodes.size > 0) throw new Error("Graph knowledge cannot change after the task has started.");
    if (!enabled) {
      const previous = session.knowledgeRuntime;
      session.configureKnowledge(null);
      await previous?.close();
      return { enabled: false, status: "Off" };
    }
    if (!session.knowledgeRuntime) {
      const runtime = await runtimeFactory({ client: session.client, configData,
        env: { ...process.env, MINIPHI_KNOWLEDGE: "1" }, model: session.model,
        contextLength: session.contextLength, schemaRegistry: session.schemaRegistry,
        trace: session.trace, baseDir: session.baseDir, sessionId: session.sessionId,
        sessionDeadline: session.sessionDeadline });
      if (disposed) {
        await runtime?.close();
        return { enabled: false, status: "Off" };
      }
      if (!runtime) return { enabled: false, status: "Cheetah unavailable. Start Cheetah and press g to retry." };
      session.configureKnowledge(runtime);
    }
    return { enabled: true, status: "Ready" };
  };
  configureKnowledge.close = async () => {
    disposed = true;
    await session.knowledgeRuntime?.close();
  };
  return configureKnowledge;
}
