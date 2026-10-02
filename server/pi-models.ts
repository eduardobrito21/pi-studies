import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { join } from "node:path";
import { z } from "zod";

export class PiSetupError extends Data.TaggedError("PiSetupError")<{ message: string }> {}

export const piModelSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

export type PiModelSelection = z.infer<typeof piModelSchema>;

type PiModelAccess = Pick<ModelRuntime, "getModel" | "getAvailable" | "listCredentials">;

export function selectPiModel(provider: string | undefined, model: string | undefined) {
  const selection = piModelSchema.safeParse({ provider, model });

  return selection.success
    ? Effect.succeed(selection.data)
    : Effect.fail(
        new PiSetupError({
          message: "Choose both TASKBOARD_PI_PROVIDER and TASKBOARD_PI_MODEL; no model is assumed.",
        }),
      );
}

// Authentication/configuration only: never create a coding-agent session or load extensions.
export const loadPiRuntime = Effect.tryPromise({
  try: async (signal) => {
    const agentDir = getAgentDir();

    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal,
    });

    if (runtime.getError()) {
      throw new PiSetupError({ message: "Invalid pi model configuration." });
    }

    return runtime;
  },
  catch: () => new PiSetupError({ message: "Cannot load pi credentials/model configuration." }),
});

export function checkPiModel(runtime: PiModelAccess, selection: PiModelSelection) {
  return Effect.tryPromise({
    try: async (signal) => {
      const credentials = await runtime.listCredentials({ signal });
      const credential = credentials.find((entry) => entry.providerId === selection.provider);

      if (!credential) {
        throw new PiSetupError({ message: "No stored pi login for this provider. Use pi /login." });
      }

      if (!runtime.getModel(selection.provider, selection.model)) {
        throw new PiSetupError({ message: "Selected model is not in pi's local catalog/config." });
      }

      const available = await runtime.getAvailable(selection.provider, { signal });

      if (
        !available.some(
          (model) => model.provider === selection.provider && model.id === selection.model,
        )
      ) {
        throw new PiSetupError({
          message: "Selected model does not have configured authentication.",
        });
      }

      // Only identifiers and credential type leave this boundary, never auth/header values.
      return { ...selection, credentialType: credential.type };
    },
    catch: (cause) =>
      cause instanceof PiSetupError
        ? cause
        : new PiSetupError({
            message: "Pi authentication availability check failed. Use pi /login.",
          }),
  });
}

export function listPiModels(runtime: PiModelAccess) {
  return Effect.tryPromise({
    try: async (signal) => {
      const credentials = await runtime.listCredentials({ signal });
      const result: (PiModelSelection & { credentialType: "api_key" | "oauth" })[] = [];

      for (const credential of credentials) {
        const available = await runtime.getAvailable(credential.providerId, { signal });

        for (const model of available) {
          result.push({
            provider: model.provider,
            model: model.id,
            credentialType: credential.type,
          });
        }
      }

      return result;
    },
    catch: () => new PiSetupError({ message: "Cannot enumerate models for stored pi logins." }),
  });
}

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const args = process.argv.slice(2);

    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
      return yield* new PiSetupError({ message: "Usage: bun server/pi-models.ts [--check]" });
    }

    // Validate explicit selection before even reading credentials in check mode.
    const selection =
      args[0] === "--check"
        ? yield* selectPiModel(process.env.TASKBOARD_PI_PROVIDER, process.env.TASKBOARD_PI_MODEL)
        : undefined;

    const runtime = yield* loadPiRuntime;

    if (selection) {
      const checked = yield* checkPiModel(runtime, selection);

      console.log(JSON.stringify(checked));
      console.log("Model/authentication configured; no inference request was made.");
    } else {
      const models = yield* listPiModels(runtime);

      console.log(JSON.stringify(models, null, 2));
      console.log("Choose a provider/model explicitly. No inference request was made.");
    }
  });

  await Effect.runPromise(
    Effect.match(Effect.timeout(program, "15 seconds"), {
      onFailure: (error) => {
        console.error(error instanceof PiSetupError ? error.message : "Pi setup check timed out.");
        process.exitCode = 1;
      },
      onSuccess: () => {},
    }),
  );
}
