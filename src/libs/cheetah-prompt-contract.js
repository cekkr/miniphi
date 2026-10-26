// Graph-specific phase policy over the reusable schema registry contract builder.
// Never put a prior answer, gold triple or guessed answer in these templates.
export function graphSourceSentences(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  return [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
    .map(item => item.segment.trim()).filter(Boolean);
}

export function buildGraphResponseContract(schemaRegistry, schemaId, payload) {
  const common = { needs_more_context: false, missing_snippets: [], stop_reason: "completed" };
  const template = (when, response) => ({ when, response });
  let templates;
  const instructions = [];
  if (schemaId.startsWith("cheetah-knowledge-assessment")) {
    const count = Math.max(1, Math.min(3, payload.requested_concept_count ?? 1));
    templates = [template("Assess each requested fact before reading the database", {
      concepts: Array.from({ length: count }, (_, i) => ({ id: `c${i + 1}`,
        entity: "<exact complete entity name from question>", aspect: "<one requested aspect>",
        question: "<standalone question naming that entity and aspect>", prior_answer: "",
        self_confidence: 0, basis: "<brief basis for remembered knowledge or uncertainty>" })),
      ...common, needs_more_context: true,
    })];
    instructions.push("Fill each prior_answer only from remembered knowledge, or leave it empty if unknown. self_confidence=0 is an illustrative number: replace it with your own 0..1 estimate. A prior answer is not graph evidence. Keep distinct requested aspects in distinct concepts.");
  } else if (schemaId.startsWith("cheetah-graph-extract")) {
    const slots = Math.max(1, Math.min(4, graphSourceSentences(payload.source_text).length));
    templates = [template("Extract source-supported atomic claims", {
      facts: Array.from({ length: slots }, (_, i) => ({ subject: `<complete subject for source sentence ${i + 1}>`, relation: "relation_from_quote",
        object: `<complete object or literal for source sentence ${i + 1}>`, quote: `<exact supporting quote for source sentence ${i + 1}>` })), ...common,
    })];
    instructions.push("The template shows up to four source sentences, not a fixed fact count. Extract every supported statement, extending facts for multiple claims in a sentence within schema bounds. Omit unsupported slots; never invent claims to fill them. Replace relation_from_quote with a snake_case role or verb supported by the same quote. Preserve source direction and qualifiers. An empty facts array is allowed only when the active schema allows it and no supported claim exists.");
  } else {
    const focused = Boolean(payload.entity_candidates?.length);
    const entity = schemaId === "cheetah-focused-query" ? "focus" : focused ? "<observed entity candidate id>" : "<exact question name or observed endpoint>";
    const lookup = { lookups: [payload.next_lookup ?? { entity, relation: "", direction: "out" }], ...common, needs_more_context: true };
    if (["cheetah-graph-query", "cheetah-focused-query"].includes(schemaId)) {
      templates = [template("Read graph evidence; an answer is not permitted yet", lookup)];
    } else {
      const confidence = schemaId === "cheetah-concept-reason"
        ? { self_confidence: 0, reasoning_summary: "<brief explanation of supporting or missing evidence>" } : {};
      templates = [
        template("More evidence is needed: query an observed endpoint", { ...lookup, answer_entity: "", evidence_ids: [], ...confidence }),
        template("Evidence answers the requested aspect: cite its connected path", {
          lookups: [], answer_entity: payload.citation_repair?.answer_entity ?? "<exact final endpoint from graph evidence>",
          evidence_ids: payload.citation_repair?.evidence_ids ?? ["<supporting evidence id>"], ...common, ...confidence,
        }),
        template("No supported answer or useful lookup remains: decline", {
          lookups: [], answer_entity: "", evidence_ids: [], ...common, ...confidence,
        }),
      ];
      if (payload.citation_repair) {
        templates = templates.slice(1);
        instructions.push("Your previously proposed endpoint has an observed connected path shown in the answer template. Re-cite ALL its evidence ids with lookups=[] or decline. No additional graph lookup is needed. This candidate is not accepted until you return valid connected citations.");
      }
      instructions.push("Choose exactly one mode. Do not combine a final answer with lookups. The cited relation must answer the question/requested_aspect, not merely reach a named node. If support is missing, request another observed endpoint or decline. Replace confidence numbers with your evidence-based estimate.");
    }
    instructions.push(focused
      ? "Lookup entity values must be ids from entity_candidates; focus refers to the current subject. Use eN_subject/eN_object to follow returned evidence. direction=out is illustrative: choose in for a reverse lookup."
      : "Copy lookup names only from the question or observed evidence. direction=out is illustrative: choose in for a reverse lookup.");
    if (payload.next_lookup) instructions.push("The lookup template is prefilled with an observed, not-yet-queried endpoint/direction. Use this request if more evidence is needed rather than repeating the original lookup; it is not an answer hint.");
  }
  const enumConstraints = payload.required_lookup ? ["entity", "relation", "direction"].map(field => ({
    path: ["properties", "lookups", "items", "properties", field], values: [payload.required_lookup[field]],
  })) : [];
  if (payload.citation_repair) enumConstraints.push(
    { path: ["properties", "answer_entity"], values: ["", payload.citation_repair.answer_entity] },
    { path: ["properties", "evidence_ids", "items"], values: payload.citation_repair.evidence_ids },
  );
  return schemaRegistry.buildResponseContract(schemaId, { templates, instructions, enumConstraints });
}
