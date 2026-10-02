import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmokeSession, smokeModelSchema } from "../server/pi-smoke";

test("smoke model selection requires nonblank provider and model", () => {
  expect(smokeModelSchema.safeParse({}).success).toBe(false);
  expect(smokeModelSchema.safeParse({ provider: " ", model: "test" }).success).toBe(false);
  expect(smokeModelSchema.safeParse({ provider: "openai", model: "" }).success).toBe(false);
  expect(smokeModelSchema.parse({ provider: " openai ", model: " gpt-6.1-sol " })).toEqual({
    provider: "openai",
    model: "gpt-6.1-sol",
  });
});

test("smoke session has no tools or discovered resources and does not persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-pi-test-"));

  try {
    // No real credentials, model refresh, or provider request in the normal test suite.
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"),
      refreshOnCreate: false,
    });

    const model = runtime.getModel("openai", "gpt-6.1-sol");

    if (!model) {
      throw new Error("Pinned pi catalog is missing the smoke-test model.");
    }

    const { session, extensionsResult } = await createSmokeSession(runtime, model);

    try {
      expect(session.getActiveToolNames()).toEqual([]);
      expect(extensionsResult.extensions).toEqual([]);
      expect(extensionsResult.errors).toEqual([]);
      expect(session.systemPrompt).toContain("You are a connection test.");
      expect(session.systemPrompt).not.toContain("Project instructions");
      expect(session.sessionManager.getSessionFile()).toBeUndefined();
      expect(session.messages).toEqual([]);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
