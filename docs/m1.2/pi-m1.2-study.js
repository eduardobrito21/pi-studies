// Static teaching snapshots: no network or database operations.
const steps = [
  {
    title: "The migration laid out storage; nothing has run yet.",
    description:
      "Root ID 1 is reserved, not inserted. Metadata is initialized, but there are no durable records. Click Next to initialize the root.",
    touched: [],
    nextId: 2,
    claims: "No claims yet",
    conversations: "No conversation records",
    entries: "No transcript entries",
    tasks: "No execution work",
    submissions: "No admitted requests",
    documents: "No state incarnations",
    revisions: "No content revisions",
  },
  {
    title: "Initialize the root conversation.",
    description:
      "Commit seq 1 creates conversation 1 and its immutable ID claim. A conversation is a scope for history, not a message.",
    touched: ["metadata", "claims", "conversations"],
    nextId: 2,
    claims: "1 → conversation",
    conversations: "id: 1\nparent: absent\nowner: absent",
    entries: "No transcript entries",
    tasks: "No execution work",
    submissions: "No admitted requests",
    documents: "No state incarnations",
    revisions: "No content revisions",
  },
  {
    title: "Admit a request; save a receipt.",
    description:
      "The sample mints IDs 2–5 before commit seq 2, which stores only submission 2. The request is queued: it has no transcript entry or answer yet. ID candidates are not commit sequences.",
    touched: ["metadata", "claims", "submissions"],
    nextId: 6,
    claims: "1 → conversation\n2 → submission",
    conversations: "id: 1\nparent: absent\nowner: absent",
    entries: "No transcript entries",
    tasks: "No execution work",
    submissions: "id: 2 · conversation: 1\nrequestId: study-001\ntype: input · status: queued",
    documents: "No state incarnations",
    revisions: "No content revisions",
  },
  {
    title: "Place the input and record work + state together.",
    description:
      "Commit seq 3 atomically appends user entry 3, stores running task 4, creates document 5 and its base, and replaces submission 2 with placed. One commit touches several tables.",
    touched: ["metadata", "claims", "entries", "tasks", "submissions", "documents", "revisions"],
    nextId: 6,
    claims: "1 → conversation\n2 → submission\n3 → entry\n4 → task\n5 → document",
    conversations: "id: 1\nparent: absent\nowner: absent",
    entries:
      "id: 3 · conversation: 1 · seq: 3\nkind: study.user\nmodel: user message\ndata: { text: Explain durable records }",
    tasks: "id: 4 · kind: study.explain\nstate.status: running\ncheckpoint: { phase: explain }",
    submissions: "id: 2 · requestId: study-001\nstatus: placed\nentry: 3 · no answer yet",
    documents:
      "id: 5 · kind: study.progress\nscope: conversation 1\ncreatedAt: seq 3 · not retired\nhistory: rewindable · fork: asOf",
    revisions: 'document: 5 · seq: 3\nkind: base · version: 1\ncontent: {"explained":0}',
  },
  {
    title: "Save the answer and complete the work atomically.",
    description:
      "Commit seq 4 appends answer entry 6, replaces task 4 with terminal/completed, replaces submission 2 with done, and adds a delta to document 5. Entries accumulate; tasks and receipts keep the same IDs.",
    touched: ["metadata", "claims", "entries", "tasks", "submissions", "revisions"],
    nextId: 7,
    claims: "1 → conversation\n2 → submission\n3 → entry\n4 → task\n5 → document\n6 → entry",
    conversations: "id: 1\nparent: absent\nowner: absent",
    entries:
      "id: 3 · study.user · seq 3\nid: 6 · study.answer · seq 4\n  byTaskId: 4\n  data only (no model messages)",
    tasks:
      "id: 4 · same work identity\nstate.status: terminal\noutcome.status: completed\nNo live checkpoint",
    submissions: "id: 2 · same receipt\nstatus: done\nentry: 3 · answer: 6",
    documents:
      "id: 5 · same incarnation\ncreatedAt: seq 3 · not retired\nContent changed, identity did not",
    revisions:
      '(5, 3) base: {"explained":0}\n(5, 4) delta: [["s",["explained"],1]]\nmaterialized now: {"explained":1}',
  },
];

const tableNames = [
  "claims",
  "conversations",
  "entries",
  "tasks",
  "submissions",
  "documents",
  "revisions",
];

const previous = document.getElementById("previous");

const next = document.getElementById("next");

const play = document.getElementById("play");

const slider = document.getElementById("step");

let current = 0;

let timer;

function stop() {
  clearInterval(timer);
  timer = undefined;
  play.textContent = "Play commits";
  play.setAttribute("aria-pressed", "false");
}

function render() {
  const step = steps[current];
  document.getElementById("sequence").textContent =
    current === 0 ? "SCHEMA ONLY / NO COMMIT YET" : `COMMIT SEQ ${current} / 4`;
  document.getElementById("step-title").textContent = step.title;
  document.getElementById("step-description").textContent = step.description;
  document.querySelector("#metadata .snapshot").textContent =
    `singleton: 1 · format: 1\nnext_id: ${step.nextId}\nnext_seq: ${current + 1}`;

  for (const name of tableNames) {
    document.querySelector(`#${name} .snapshot`).textContent = step[name];
  }

  for (const card of document.querySelectorAll(".table-card")) {
    card.classList.toggle("touched", step.touched.includes(card.id));
  }

  slider.value = String(current);
  slider.setAttribute(
    "aria-valuetext",
    current === 0 ? "Before the first commit" : `Commit ${current}: ${step.title}`,
  );
  previous.disabled = current === 0;
  next.disabled = current === 4;
}

previous.addEventListener("click", () => {
  stop();
  current = Math.max(0, current - 1);
  render();
});

next.addEventListener("click", () => {
  stop();
  current = Math.min(4, current + 1);
  render();
});

document.getElementById("reset").addEventListener("click", () => {
  stop();
  current = 0;
  render();
});

slider.addEventListener("input", () => {
  stop();
  current = Number(slider.value);
  render();
});

play.addEventListener("click", () => {
  if (timer !== undefined) {
    stop();

    return;
  }

  if (current === 4) current = 0;
  render();
  play.textContent = "Pause";
  play.setAttribute("aria-pressed", "true");
  timer = setInterval(() => {
    current += 1;
    render();

    if (current === 4) stop();
  }, 3500);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});

render();
