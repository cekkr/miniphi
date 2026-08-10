import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import PromptSchemaRegistry from "../src/libs/prompt-schema-registry.js";
import AgentsBootstrapper, {
  HANDBOOK_SECTIONS,
  renderSurvey,
  surveyRepository,
} from "../src/libs/agents-bootstrapper.js";

const makeRepo = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-repo-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export const run = () => 1;\n");
  await fs.writeFile(path.join(root, "test", "index.test.js"), "// tests\n");
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "// vendored\n");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test test/*.test.js", build: "tsc" } }),
  );
  await fs.writeFile(path.join(root, "README.md"), "# Demo\nA demonstration project.\n");
  return root;
};

test("the survey reports what is on disk and ignores installed code", async () => {
  const root = await makeRepo();
  const survey = await surveyRepository(root);
  const paths = survey.files.map((file) => file.path);
  assert.ok(paths.includes("src/index.js"));
  assert.ok(paths.includes("test/index.test.js"));
  assert.ok(
    !paths.some((file) => file.startsWith("node_modules/")),
    "installed code is never surveyed as project source",
  );
  assert.deepEqual(survey.directories, ["src", "test"]);
  assert.deepEqual(survey.rootFiles.sort(), ["README.md", "package.json"]);
  assert.deepEqual(survey.testFiles, ["test/index.test.js"]);
  assert.equal(survey.scripts.test, "node --test test/*.test.js");

  const rendered = renderSurvey(survey);
  assert.match(rendered, /node --test test\/\*\.test\.js/);
  assert.match(rendered, /README\.md/);
});

test("without a model the handbook is factual, headed, and admits what it does not know", async () => {
  const root = await makeRepo();
  const bootstrapper = new AgentsBootstrapper({ client: null, schemaRegistry: null, model: null });
  const result = await bootstrapper.build({ workspaceRoot: root });

  assert.equal(result.fallbacks, HANDBOOK_SECTIONS.length);
  for (const section of HANDBOOK_SECTIONS) {
    assert.match(result.markdown, new RegExp(`## ${section.heading}`));
  }
  // Real facts, taken from the manifest, not invented.
  assert.match(result.markdown, /`npm run test` — `node --test test\/\*\.test\.js`/);
  assert.match(result.markdown, /`test\/index\.test\.js`/);
  // And an explicit gap wherever nothing was established.
  assert.match(result.markdown, /Unverified in this section/);
  assert.doesNotMatch(result.markdown, /node_modules/);
});

test("a repository with no tests is told so as a gap, with the rule that fixes it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miniphi-repo-"));
  await fs.writeFile(path.join(root, "main.py"), "print('hi')\n");
  const bootstrapper = new AgentsBootstrapper({ client: null, schemaRegistry: null, model: null });
  const result = await bootstrapper.build({ workspaceRoot: root, sections: ["validation"] });
  assert.match(result.markdown, /\*\*Known gap:\*\* the survey found no test files/);
  assert.match(result.markdown, /textual verdict/);
});

test("a model-written section is used, and its unverified facts are surfaced", async () => {
  const root = await makeRepo();
  const calls = [];
  const bootstrapper = new AgentsBootstrapper({
    client: {
      async createChatCompletion(request) {
        calls.push(request);
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: "project-handbook-section@v1",
                  section: "mission",
                  markdown: "## Mission and scope\n\nDemo is a demonstration project.",
                  unknowns: ["its maturity level is not stated anywhere in the repository"],
                  needs_more_context: false,
                  missing_snippets: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
        };
      },
    },
    schemaRegistry: new PromptSchemaRegistry(),
    model: "m",
    contextLength: 16384,
  });
  const result = await bootstrapper.build({ workspaceRoot: root, sections: ["mission"] });

  assert.equal(result.fallbacks, 0);
  assert.match(result.markdown, /Demo is a demonstration project\./);
  assert.match(result.markdown, /its maturity level is not stated/);
  // The prompt must carry the protocol's requirement for that section and the
  // survey — the model is not asked to remember either.
  assert.match(calls[0].messages[0].content, /construction protocol/);
  assert.match(calls[0].messages[0].content, /Never invent a file, command/);
  assert.match(calls[0].messages[1].content, /REPOSITORY SURVEY/);
  assert.equal(calls[0].response_format.json_schema.name, "project-handbook-section");
});

test("the validation section's requirement carries the vision-free testing rule", () => {
  const validation = HANDBOOK_SECTIONS.find((section) => section.id === "validation");
  assert.match(validation.requirement, /unit tests/i);
  assert.match(validation.requirement, /end-to-end/i);
  assert.match(validation.requirement, /no vision/i);
});
