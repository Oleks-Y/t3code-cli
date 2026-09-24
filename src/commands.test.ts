import {
  MessageId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "#contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AmbiguousError,
  makeTurnTracker,
  MessageInvalidError,
  ModelInvalidError,
  NotFoundError,
  pickById,
  resolveModelSelection,
  resolveNewThreadSettings,
  resolveProject,
  validateThreadMessage,
} from "./commands.ts";
import {
  formatProjectList,
  formatThreadDetail,
  formatThreadList,
  formatUsageLimits,
  pendingApprovals,
  shortId,
  table,
} from "./format.ts";

const now = "2026-09-17T10:00:00.000Z";
const projectId = ProjectId.make("project-cli");
const threadId = ThreadId.make("thread-cli");

const project = {
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/tmp/t3code",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const thread = {
  id: threadId,
  projectId,
  title: "CLI thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

// Fixtures cover only the fields the formatters read.
const shellSnapshot = {
  snapshotSequence: 12,
  updatedAt: now,
  projects: [project],
  threads: [thread],
} as unknown as OrchestrationShellSnapshot;

const detailSnapshot = {
  snapshotSequence: 12,
  thread: {
    ...thread,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-cli"),
        role: "user",
        text: "Run the focused tests.",
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
} as unknown as OrchestrationThreadDetailSnapshot;

const providers = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      { slug: "plain", name: "Plain", isCustom: true, capabilities: null },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

it("aligns columns and leaves the last one unpadded", () => {
  assert.strictEqual(table(["ID", "NAME"], [["a", "x"], ["abcd", "y"]]), "ID    NAME\na     x\nabcd  y");
});

it("formats projects and threads for terminal use", () => {
  assert.strictEqual(
    formatProjectList(shellSnapshot, { json: false }),
    "ID           NAME     PATH\nproject-cli  T3 Code  /tmp/t3code",
  );
  const lines = formatThreadList(shellSnapshot, { json: false }).split("\n");
  assert.match(lines[0]!, /^ID +STATUS +UPDATED +PROJECT +TITLE$/);
  assert.match(lines[1]!, /^thread-cli +idle +\S.* +T3 Code +CLI thread$/);
});

it("hides settled threads unless asked for all", () => {
  const snapshot = {
    ...shellSnapshot,
    threads: [
      ...shellSnapshot.threads,
      { ...thread, id: "thread-done", title: "Done thread", settledOverride: "settled" },
    ],
  } as unknown as OrchestrationShellSnapshot;
  assert.notInclude(formatThreadList(snapshot, { json: false }), "thread-done");
  assert.match(
    formatThreadList(snapshot, { json: false, includeSettled: true }),
    /thread-done +settled .* Done thread/,
  );
});

it("formats thread details with recent messages", () => {
  const output = formatThreadDetail(detailSnapshot, shellSnapshot, { json: false });
  assert.include(output, "project   T3 Code (/tmp/t3code)");
  assert.include(output, "model     codex/gpt-5.6-sol, full-access");
  assert.match(output, /── user · .*\nRun the focused tests\./);
});

it("lists approval requests until they are resolved", () => {
  const activity = (kind: string, requestId: string, detail?: string) => ({
    kind,
    summary: "Command approval requested",
    payload: { requestId, requestType: "command", ...(detail ? { detail } : {}) },
  });
  const activities = [
    activity("approval.requested", "a", "rm -rf build"),
    activity("approval.requested", "b", "pnpm test"),
    activity("approval.resolved", "a"),
  ] as never;
  assert.deepStrictEqual(pendingApprovals(activities), [
    { requestId: "b", summary: "Command approval requested", detail: "pnpm test" },
  ]);
});

it("shortens UUIDs but keeps other ids whole", () => {
  assert.strictEqual(shortId("64f570ce-b685-4732-85b1-4b99b82abdfc"), "64f570ce");
  assert.strictEqual(shortId("import:claudeAgent:abc"), "import:claudeAgent:abc");
});

// Only the fields the tracker reads.
const event = (type: string, payload: object) => ({ type, payload }) as never;
const session = (status: string, lastError: string | null = null) =>
  event("thread.session-set", { session: { status, lastError } });
const assistant = (messageId: string, text: string, streaming: boolean) =>
  event("thread.message-sent", { messageId, role: "assistant", text, streaming });

it("follows a turn: streams the reply and ends when the session settles", () => {
  let out = "";
  const tracker = makeTurnTracker({ running: false, write: (text) => (out += text) });
  const outcomes = [
    session("ready"), // the previous turn settling doesn't end ours
    session("running"),
    assistant("m1", "Hel", true),
    assistant("m1", "lo", true),
    assistant("m1", "", false),
    assistant("m2", "Done.", false),
    session("ready"),
  ].map(tracker.step);
  tracker.end();
  assert.deepStrictEqual(outcomes.slice(0, -1), Array(6).fill(undefined));
  assert.deepStrictEqual(outcomes.at(-1), { state: "completed" });
  assert.strictEqual(tracker.reply(), "Hello\n\nDone.");
  assert.strictEqual(out, "Hello\n\nDone.\n");
});

it("reports interrupts, failures, and approvals instead of completion", () => {
  const run = (running: boolean, ...events: Array<never>) => {
    const tracker = makeTurnTracker({ running, write: () => undefined });
    return events.map(tracker.step).find((outcome) => outcome !== undefined);
  };
  assert.deepStrictEqual(
    run(false, session("running"), event("thread.turn-interrupt-requested", {}), session("ready")),
    { state: "interrupted" },
  );
  assert.deepStrictEqual(run(true, session("stopped")), { state: "interrupted" });
  assert.deepStrictEqual(run(true, session("error", "boom")), { state: "error", detail: "boom" });
  assert.deepStrictEqual(
    run(
      true,
      event("thread.activity-appended", {
        activity: {
          kind: "provider.approval.respond.failed",
          summary: "Provider approval response failed",
          payload: { detail: "No active provider session is bound to this thread." },
        },
      }),
    ),
    { state: "error", detail: "No active provider session is bound to this thread." },
  );
  assert.deepStrictEqual(
    run(
      false,
      event("thread.activity-appended", {
        activity: {
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: "r1", requestType: "command", detail: "echo pong" },
        },
      }),
    ),
    { state: "needs-approval", detail: "Command approval requested: echo pong" },
  );
});

it.effect("resolves ids by unique prefix", () =>
  Effect.gen(function* () {
    const items = [{ id: "abc123" }, { id: "abd456" }];
    assert.strictEqual((yield* pickById("thread", items, "abc")).id, "abc123");
    assert.instanceOf(yield* pickById("thread", items, "ab").pipe(Effect.flip), AmbiguousError);
    assert.instanceOf(yield* pickById("thread", items, "zz").pipe(Effect.flip), NotFoundError);
  }),
);

it.effect("rejects empty and oversized thread messages before dispatch", () =>
  Effect.gen(function* () {
    const empty = yield* validateThreadMessage("   ").pipe(Effect.flip);
    assert.instanceOf(empty, MessageInvalidError);
    const oversized = yield* validateThreadMessage("x".repeat(120_001)).pipe(Effect.flip);
    assert.strictEqual(oversized.reason, "too-long");
  }),
);

it.effect("resolves a project by id, prefix, name, or any path inside it", () =>
  Effect.gen(function* () {
    const snapshot = {
      ...shellSnapshot,
      projects: [...shellSnapshot.projects, { ...project, id: "cwd", title: "Here", workspaceRoot: process.cwd() }],
    } as unknown as OrchestrationShellSnapshot;
    const id = (input: string) => resolveProject(snapshot, input).pipe(Effect.map((found) => found.id));
    assert.strictEqual(yield* id("."), "cwd");
    assert.strictEqual(yield* id("./src"), "cwd");
    assert.strictEqual(yield* id("project-cli"), "project-cli");
    assert.strictEqual(yield* id("proj"), "project-cli");
    assert.strictEqual(yield* id("t3 code"), "project-cli");
    assert.instanceOf(yield* id("/nowhere").pipe(Effect.flip), NotFoundError);
    assert.instanceOf(yield* id("nowhere").pipe(Effect.flip), NotFoundError);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires a listed model and one of its thinking levels", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* resolveModelSelection(providers, "codex/gpt-5.6-sol", "high"), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.deepStrictEqual(yield* resolveModelSelection(providers, "plain", undefined), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "plain",
    });

    for (const [model, thinking] of [
      ["codex/gpt-5.6-sol", "max"],
      ["codex/plain", "high"],
      ["codex/missing", "high"],
      ["claude/gpt-5.6-sol", "high"],
    ] as const) {
      const error = yield* resolveModelSelection(providers, model, thinking).pipe(Effect.flip);
      assert.instanceOf(error, ModelInvalidError);
    }
  }),
);

it.effect("new threads inherit the project's last model and access unless given", () =>
  Effect.gen(function* () {
    const none = { model: Option.none(), thinking: Option.none(), access: Option.none() };
    const inherited = yield* resolveNewThreadSettings(shellSnapshot, providers, project as never, none);
    assert.deepStrictEqual(inherited, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
    });
    const explicit = yield* resolveNewThreadSettings(shellSnapshot, providers, project as never, {
      model: Option.some("plain"),
      thinking: Option.none(),
      access: Option.some("approval-required"),
    });
    assert.deepStrictEqual(explicit, {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "plain" },
      runtimeMode: "approval-required",
    });

    // A model no provider offers anymore falls through to the project default,
    // and --thinking replaces only the thinking option.
    const snapshot = {
      ...shellSnapshot,
      threads: [{ ...thread, modelSelection: { instanceId: "gone", model: "old" } }],
    } as unknown as OrchestrationShellSnapshot;
    const withDefault = {
      ...project,
      defaultModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ],
      },
    } as never;
    const fallback = yield* resolveNewThreadSettings(snapshot, providers, withDefault, {
      ...none,
      thinking: Option.some("high"),
    });
    assert.deepStrictEqual(fallback.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [
        { id: "fastMode", value: true },
        { id: "reasoningEffort", value: "high" },
      ],
    });
  }),
);

it("reports how much of each subscription window is left", () => {
  const withLimits = [
    {
      ...providers[0]!,
      usageLimits: {
        checkedAt: now,
        windows: [{ id: "session", kind: "session", label: "5h", usedPercent: 12 }],
      },
    },
  ] as unknown as ReadonlyArray<ServerProvider>;
  assert.strictEqual(
    formatUsageLimits(withLimits, { json: false }),
    "PROVIDER  WINDOW  LEFT  RESETS\ncodex     5h      88%   -",
  );
  assert.strictEqual(
    formatUsageLimits(providers, { json: false }),
    "No subscription usage limits reported.",
  );
});
