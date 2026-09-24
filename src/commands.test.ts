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

import {
  formatProjectList,
  formatThreadDetail,
  formatThreadList,
  formatUsageLimits,
  MessageInvalidError,
  ModelInvalidError,
  resolveModelSelection,
  resolveProject,
  validateThreadMessage,
} from "./commands.ts";

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

it("formats projects and threads for terminal use", () => {
  assert.strictEqual(
    formatProjectList(shellSnapshot, { json: false }),
    "ID\tTITLE\tPATH\nproject-cli\tT3 Code\t/tmp/t3code",
  );
  assert.strictEqual(
    formatThreadList(shellSnapshot, { json: false }),
    "ID\tSTATUS\tPROJECT\tTITLE\nthread-cli\tidle\tT3 Code\tCLI thread",
  );
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
  assert.include(
    formatThreadList(snapshot, { json: false, includeSettled: true }),
    "thread-done\tsettled\tT3 Code\tDone thread",
  );
});

it("formats thread details with recent messages", () => {
  const output = formatThreadDetail(detailSnapshot, shellSnapshot, { json: false });
  assert.include(output, "Project: T3 Code");
  assert.include(output, "Model: codex/gpt-5.6-sol");
  assert.include(output, "user 2026-09-17T10:00:00.000Z\n  Run the focused tests.");
});

it.effect("rejects empty and oversized thread messages before dispatch", () =>
  Effect.gen(function* () {
    const empty = yield* validateThreadMessage("   ").pipe(Effect.flip);
    assert.instanceOf(empty, MessageInvalidError);
    const oversized = yield* validateThreadMessage("x".repeat(120_001)).pipe(Effect.flip);
    assert.strictEqual(oversized.reason, "too-long");
  }),
);

it.effect("resolves --project . to the project rooted at the current directory", () =>
  Effect.gen(function* () {
    const snapshot = {
      ...shellSnapshot,
      projects: [...shellSnapshot.projects, { ...project, id: "cwd", workspaceRoot: process.cwd() }],
    } as unknown as OrchestrationShellSnapshot;
    assert.strictEqual(yield* resolveProject(snapshot, "."), "cwd");
    assert.strictEqual(yield* resolveProject(snapshot, "project-cli"), "project-cli");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requires a listed model and one of its thinking levels", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* resolveModelSelection(providers, "codex/gpt-5.6-sol", "high"), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.deepStrictEqual(yield* resolveModelSelection(providers, "codex/plain", "none"), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "plain",
    });

    for (const [model, thinking] of [
      ["codex/gpt-5.6-sol", "max"],
      ["codex/missing", "high"],
      ["claude/gpt-5.6-sol", "high"],
      ["gpt-5.6-sol", "high"],
    ] as const) {
      const error = yield* resolveModelSelection(providers, model, thinking).pipe(Effect.flip);
      assert.instanceOf(error, ModelInvalidError);
    }
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
  assert.include(formatUsageLimits(withLimits, { json: false }), "codex\t5h\t88%\t-\t");
  assert.strictEqual(
    formatUsageLimits(providers, { json: false }),
    "No subscription usage limits reported.",
  );
});
