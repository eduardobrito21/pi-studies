import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import {
  checkPiModel,
  listPiModels,
  piModelSchema,
  PiSetupError,
  selectPiModel,
} from "../server/pi-models";
import { runDurableSmoke, runFauxSmoke, smokePrompt, smokeReply } from "../server/pi-smoke";

test("selection requires an explicit nonblank provider/model pair", async () => {
  expect(piModelSchema.safeParse({}).success).toBe(false);
  expect(piModelSchema.safeParse({ provider: " ", model: "test" }).success).toBe(false);
  expect(piModelSchema.safeParse({ provider: "faux", model: "" }).success).toBe(false);
  expect(
    piModelSchema.safeParse({ provider: "faux", model: "faux-1", apiKey: "secret" }).success,
  ).toBe(false);
  expect(piModelSchema.parse({ provider: " faux ", model: " faux-1 " })).toEqual({
    provider: "faux",
    model: "faux-1",
  });
  expect(await Effect.runPromise(Effect.flip(selectPiModel(undefined, undefined)))).toBeInstanceOf(
    PiSetupError,
  );
  expect(await Effect.runPromise(Effect.flip(selectPiModel("faux", undefined)))).toBeInstanceOf(
    PiSetupError,
  );
});

test("Bun runs one pi-durable generation and commits its transcript without tools", async () => {
  expect(await Effect.runPromise(runFauxSmoke())).toEqual({
    answer: smokeReply,
    submissionStatus: "done",
    entryKinds: ["pi.user", "pi.system", "pi.assistant"],
    toolNames: [],
    extensionNames: [],
    providerCalls: 1,
  });
});

test("the scripted provider receives only the smoke prompt and no discovered tools/context", async () => {
  const faux = fauxProvider();
  const models = createModels();
  const storage = new MemoryStorage();

  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages)).toEqual([]);
      expect(getCurrentSystemPrompt(context.messages)).toContain("You are a connection test.");
      expect(getCurrentSystemPrompt(context.messages)).not.toContain("Project instructions");
      expect(context.messages.find((message) => message.role === "user")?.content).toBe(
        smokePrompt,
      );

      return fauxAssistantMessage(smokeReply);
    },
  ]);

  const program = runDurableSmoke(models, { provider: "faux", model: "faux-1" }, storage);

  expect(faux.state.callCount).toBe(0); // Constructing an Effect does not run it.
  await Effect.runPromise(program);
  expect(faux.state.callCount).toBe(1);
  expect(faux.getPendingResponseCount()).toBe(0);
  await expect(storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).rejects.toThrow();
});

test("failed provider response is not success, is not retried, and closes storage", async () => {
  const faux = fauxProvider();
  const models = createModels();
  const storage = new MemoryStorage();

  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "private-provider-detail" }),
  ]);

  const error = await Effect.runPromise(
    Effect.flip(runDurableSmoke(models, { provider: "faux", model: "faux-1" }, storage)),
  );

  expect(error).toBeInstanceOf(PiSetupError);
  expect(error.message).not.toContain("private-provider-detail");
  expect(faux.state.callCount).toBe(1);
  await expect(storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).rejects.toThrow();
});

test("unexpected assistant text fails the smoke check", async () => {
  const faux = fauxProvider();
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("not the expected answer")]);

  const error = await Effect.runPromise(
    Effect.flip(runDurableSmoke(models, { provider: "faux", model: "faux-1" })),
  );

  expect(error.message).toBe("Durable assistant returned an unexpected response.");
});

test("availability check and enumeration expose metadata only and make no model request", async () => {
  const faux = fauxProvider();
  const model = faux.getModel();

  // Deliberately place a non-secret test sentinel in a field that must not be projected.
  model.headers = { Authorization: "private-header-sentinel" };

  const runtime = {
    getModel: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    getAvailable: async () => [model],
    listCredentials: async () => [{ providerId: model.provider, type: "oauth" as const }],
  };

  const selection = { provider: model.provider, model: model.id };
  const result = await Effect.runPromise(checkPiModel(runtime, selection));

  expect(result).toEqual({ ...selection, credentialType: "oauth" });
  expect(await Effect.runPromise(listPiModels(runtime))).toEqual([result]);
  expect(JSON.stringify(result)).not.toContain("private-header-sentinel");
  expect(faux.state.callCount).toBe(0);

  const missingLogin = await Effect.runPromise(
    Effect.flip(checkPiModel({ ...runtime, listCredentials: async () => [] }, selection)),
  );

  const missingModel = await Effect.runPromise(
    Effect.flip(checkPiModel(runtime, { provider: model.provider, model: "missing" })),
  );

  const unavailable = await Effect.runPromise(
    Effect.flip(checkPiModel({ ...runtime, getAvailable: async () => [] }, selection)),
  );

  expect(missingLogin.message).toContain("No stored pi login");
  expect(missingModel.message).toContain("not in pi's local catalog");
  expect(unavailable.message).toContain("does not have configured authentication");
});

test("availability failures hide underlying secret-bearing errors", async () => {
  const faux = fauxProvider();

  const runtime = {
    getModel: () => faux.getModel(),
    getAvailable: async () => {
      throw new Error("private-key-sentinel");
    },
    listCredentials: async () => [{ providerId: "faux", type: "api_key" as const }],
  };

  const error = await Effect.runPromise(
    Effect.flip(checkPiModel(runtime, { provider: "faux", model: "faux-1" })),
  );

  expect(error.message).not.toContain("private-key-sentinel");
  expect(await Effect.runPromise(Effect.flip(listPiModels(runtime)))).toBeInstanceOf(PiSetupError);
});
