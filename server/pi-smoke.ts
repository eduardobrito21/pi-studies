import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  getAgentDir,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { join } from "node:path";
import { z } from "zod";

export const smokeModelSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

const reply = "PI_LOGIN_OK";

// Reuse credentials, not CLI extensions, skills, instructions, or filesystem tools.
const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a connection test. Return only the exact text requested.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

export function createSmokeSession(modelRuntime: ModelRuntime, model: Model<Api>) {
  return createAgentSession({
    modelRuntime,
    model,
    thinkingLevel: "off",
    tools: [],
    noTools: "all",
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 60_000 } },
      cacheWarming: "off",
    }),
  });
}

export const piSmoke = Effect.tryPromise({
  try: async () => {
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });

    const selection = smokeModelSchema.parse({
      provider: process.env.TASKBOARD_PI_PROVIDER ?? settings.getDefaultProvider(),
      model: process.env.TASKBOARD_PI_MODEL ?? settings.getDefaultModel(),
    });

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });

    const model = modelRuntime.getModel(selection.provider, selection.model);

    if (!model) {
      throw new Error("Selected model is not in the pi catalog.");
    }

    // Check credential metadata only; never read or print API keys or OAuth tokens.
    const credentials = await modelRuntime.listCredentials();
    const credential = credentials.find((entry) => entry.providerId === selection.provider);

    if (!credential) {
      throw new Error("No stored pi login for the selected provider.");
    }

    console.log(`Checking ${model.provider}/${model.id} with stored pi credentials.`);
    const { session } = await createSmokeSession(modelRuntime, model);
    const timeout = setTimeout(() => void session.abort(), 60_000);

    try {
      await session.prompt(`Reply with exactly ${reply}`);
      const response = session.getLastAssistantText()?.trim();
      const lastMessage = session.messages.at(-1);

      if (
        lastMessage?.role !== "assistant" ||
        lastMessage.stopReason !== "stop" ||
        response !== reply
      ) {
        throw new Error("Pi did not return the expected successful response.");
      }

      console.log(`Pi existing-login integration verified: ${reply}`);
    } finally {
      clearTimeout(timeout);
      session.dispose();
    }
  },
  // Provider errors may contain request details. Do not emit them or credential values.
  catch: () => new Error("Pi smoke check failed. Check pi /login, /model, and the selected model."),
});

if (import.meta.main) {
  await Effect.runPromise(
    Effect.match(piSmoke, {
      onFailure: (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
      onSuccess: () => {},
    }),
  );
}
