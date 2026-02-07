import test from "node:test";
import assert from "node:assert/strict";
import {
  countLmStudioModels,
  extractLmStudioContextLength,
  extractLmStudioError,
  extractLmStudioGpu,
  extractLmStudioModel,
  extractLmStudioStatusPayload,
  isLmStudioStatusEndpointUnsupported,
} from "../src/libs/lmstudio-status-utils.js";

test("LM Studio status utils extract nested payload fields", () => {
  const status = {
    ok: true,
    status: {
      model_key: "mistralai/devstral-small-2-2512",
      context_length: 4096,
      gpu: "auto",
    },
  };

  assert.deepEqual(extractLmStudioStatusPayload(status), status.status);
  assert.equal(extractLmStudioModel(status), "mistralai/devstral-small-2-2512");
  assert.equal(extractLmStudioContextLength(status), 4096);
  assert.equal(extractLmStudioGpu(status), "auto");
  assert.equal(extractLmStudioError(status), null);
});

test("LM Studio status utils detect unsupported status endpoint and model counts", () => {
  const status = {
    ok: false,
    error: "Unexpected endpoint /api/v0/status",
  };
  assert.equal(isLmStudioStatusEndpointUnsupported(status), true);
  assert.equal(countLmStudioModels([{ id: "a" }, { id: "b" }]), 2);
  assert.equal(countLmStudioModels({ data: [{ id: "a" }] }), 1);
  assert.equal(countLmStudioModels({ models: [{ id: "a" }, { id: "b" }, { id: "c" }] }), 3);
  assert.equal(countLmStudioModels(null), null);
});
