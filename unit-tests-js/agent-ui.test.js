import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { html } from "../src/ui/html.js";
import FilePicker from "../src/ui/components/file-picker.js";
import PermissionModal from "../src/ui/components/permission-modal.js";
import ProgressPane from "../src/ui/components/progress-pane.js";

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("FilePicker filters, toggles, and submits the selection", async () => {
  let submitted = null;
  const app = render(
    html`<${FilePicker}
      files=${["a.js", "b.js", "src/c.js"]}
      onSubmit=${(sel) => {
        submitted = sel;
      }}
    />`,
  );
  await delay();
  assert.match(app.lastFrame(), /a\.js/);
  assert.match(app.lastFrame(), /src\/c\.js/);

  app.stdin.write("c"); // filter to src/c.js
  await delay();
  const frame = app.lastFrame();
  assert.match(frame, /src\/c\.js/);
  assert.doesNotMatch(frame, /\ba\.js/);

  app.stdin.write(" "); // toggle selection of the only filtered row
  await delay();
  assert.match(app.lastFrame(), /1 selected/);

  app.stdin.write("\r"); // confirm
  await delay();
  assert.deepEqual(submitted, ["src/c.js"]);
  app.unmount();
});

test("PermissionModal renders the diff and returns an approve-once decision", async () => {
  let decision = null;
  const app = render(
    html`<${PermissionModal}
      request=${{
        kind: "edit",
        type: "write_file",
        path: "x.js",
        danger: "low",
        isNewFile: true,
        diff: "+ [1] export const x = 1;",
        reason: "add module",
      }}
      onDecision=${(d) => {
        decision = d;
      }}
    />`,
  );
  await delay();
  const frame = app.lastFrame();
  assert.match(frame, /write_file x\.js/);
  assert.match(frame, /export const x = 1;/);
  assert.match(frame, /danger=low/);

  app.stdin.write("y");
  await delay();
  assert.deepEqual(decision, { approved: true, scope: "once" });
  app.unmount();
});

test("PermissionModal rejects on 'n'", async () => {
  let decision = null;
  const app = render(
    html`<${PermissionModal}
      request=${{ kind: "command", command: "rm -rf build", danger: "high" }}
      onDecision=${(d) => {
        decision = d;
      }}
    />`,
  );
  await delay();
  assert.match(app.lastFrame(), /rm -rf build/);
  app.stdin.write("n");
  await delay();
  assert.equal(decision.approved, false);
  app.unmount();
});

test("ProgressPane shows status lines and applied-edit rows", async () => {
  const app = render(
    html`<${ProgressPane}
      task="Add a helper"
      running=${false}
      summary="Added src/b.js"
      log=${[
        { kind: "status", text: "reading src/a.js" },
        { kind: "action", text: "read_file src/a.js", status: "executed" },
        { kind: "action", text: "write_file src/b.js", status: "written" },
      ]}
    />`,
  );
  await delay();
  const frame = app.lastFrame();
  assert.match(frame, /Add a helper/);
  assert.match(frame, /reading src\/a\.js/);
  assert.match(frame, /write_file src\/b\.js/);
  assert.match(frame, /Added src\/b\.js/);
  app.unmount();
});
