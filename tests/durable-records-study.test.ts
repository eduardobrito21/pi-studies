import { expect, test } from "bun:test";
import { demonstrateRecords } from "../docs/m1.2/examples/durable-records";

test("study example separates records, commits, receipts and document state", async () => {
  const result = await demonstrateRecords();

  expect(Object.values(result.ids).map(Number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(Object.values(result.sequences).map(Number)).toEqual([1, 2, 3, 4]);
  expect(result.before?.value).toEqual({ explained: 0 });
  expect(result.after?.value).toEqual({ explained: 1 });
  expect(result.after?.deltasSinceBase).toBe(1);
  expect(result.receipt?.status).toBe("done");
  expect(result.task?.state.status).toBe("terminal");
  expect(result.transcript.items.map((entry) => Number(entry.id))).toEqual([6, 3]);
});
