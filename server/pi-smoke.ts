import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { PiSetupError, type PiModelSelection } from "./pi-models";

export const smokeReply = "PI_DURABLE_OK";

export const smokePrompt = `Reply with exactly ${smokeReply}`;

// One pi-durable loop. MemoryStorage is ONLY a disposable M1.1 compatibility test.
// The application will use PostgreSQL after the storage milestones are complete.
export function runDurableSmoke(models: Models, selection: PiModelSelection, storage?: Storage) {
  return Effect.tryPromise({
    try: async (signal) => {
      const context = withAbortSignal(signal, BACKGROUND_CONTEXT);

      const harness = await Harness.open(
        storage ?? new MemoryStorage(),
        {
          models,
          registry: createRegistry(),
          settings: {
            stream: { timeoutMs: 10_000, maxRetries: 0, cacheRetention: "none" },
            retry: { enabled: false, maxRetries: 0 },
            compaction: { enabled: false },
            toolExecution: "sequential",
          },
        },
        context,
      );

      try {
        const root = await harness.root(context, {
          agent: {
            model: { provider: selection.provider, modelId: selection.model },
            thinkingLevel: "off",
            tools: [],
            extensions: [],
            instructions: "You are a connection test. Return only the exact text requested.",
          },
        });

        const submission = await root.submit(
          { type: "input", content: smokePrompt, requestId: "m1.1-smoke" },
          context,
        );

        const settled = await submission.wait(context);

        if (settled.status !== "done" || settled.type !== "input") {
          throw new PiSetupError({ message: "Durable submission did not produce an answer." });
        }

        const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
        const answer = entry?.model?.[0];

        if (answer?.role !== "assistant" || answer.stopReason !== "stop") {
          throw new PiSetupError({
            message: "Durable assistant response did not finish normally.",
          });
        }

        let text = "";

        for (const block of answer.content) {
          if (block.type === "text") {
            text += block.text;
          }
        }

        if (text.trim() !== smokeReply) {
          throw new PiSetupError({ message: "Durable assistant returned an unexpected response." });
        }

        const transcript = await root.entries({}, 10, undefined, context);
        const agent = await root.agent(context);

        return {
          answer: text.trim(),
          submissionStatus: settled.status,
          entryKinds: [...transcript.items].reverse().map((item) => item.kind),
          toolNames: agent.tools.map((tool) => tool.name),
          extensionNames: agent.extensions.map((extension) => extension.name),
        };
      } finally {
        // Cancelling a waiter is not cancelling durable work. Closing this disposable
        // harness stops its scheduler; mandatory cleanup uses a non-cancelled context.
        await harness.close(BACKGROUND_CONTEXT);
      }
    },
    // Never emit raw provider errors: they can contain request or credential details.
    catch: (cause) =>
      cause instanceof PiSetupError
        ? cause
        : new PiSetupError({ message: "Pi-durable smoke check failed." }),
  });
}

export function runFauxSmoke() {
  return Effect.gen(function* () {
    const faux = fauxProvider();
    const models = createModels();

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(smokeReply)]);

    const result = yield* runDurableSmoke(models, {
      provider: faux.getModel().provider,
      model: faux.getModel().id,
    });

    return { ...result, providerCalls: faux.state.callCount };
  });
}

if (import.meta.main) {
  await Effect.runPromise(
    Effect.match(Effect.timeout(runFauxSmoke(), "15 seconds"), {
      onFailure: (error) => {
        console.error(
          error instanceof PiSetupError ? error.message : "Pi-durable smoke timed out.",
        );
        process.exitCode = 1;
      },
      onSuccess: (result) => {
        console.log(JSON.stringify(result, null, 2));
        console.log("Pi-durable/faux smoke passed. No credentials or network inference used.");
      },
    }),
  );
}
