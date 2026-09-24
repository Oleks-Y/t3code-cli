import {
  ApprovalRequestId,
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderApprovalDecision,
  RuntimeMode,
  type ServerProvider,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "#contracts";
import { text as readAll } from "node:stream/consumers";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { login, readSavedServer, removeSavedServer, withRpcClient, type T3RpcClient } from "./connection.ts";
import {
  approvalRequest,
  describeApproval,
  formatModelList,
  formatProjectList,
  formatThreadDetail,
  formatThreadList,
  formatUsageLimits,
  isProviderUsable,
  oneLine,
  pendingApprovals,
  prettyJson,
  relativeTime,
  shortId,
  thinkingDescriptor,
  thinkingLevels,
} from "./format.ts";

export class UnexpectedResponseError extends Schema.TaggedError<UnexpectedResponseError>()(
  "UnexpectedResponseError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `The T3 Code server returned no ${this.operation} snapshot.`;
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  kind: Schema.Literals(["project", "thread"]),
  input: Schema.String,
}) {
  override get message(): string {
    return this.kind === "project"
      ? `No project matches '${this.input}'. Run 't3c project list'.`
      : `No thread matches '${this.input}'. Run 't3c thread list --all'; archived threads need their full id.`;
  }
}

export class AmbiguousError extends Schema.TaggedError<AmbiguousError>()("AmbiguousError", {
  kind: Schema.Literals(["project", "thread"]),
  input: Schema.String,
  matches: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `'${this.input}' matches ${this.matches.length} ${this.kind}s (${this.matches.join(", ")}). Use a longer id.`;
  }
}

export class MessageInvalidError extends Schema.TaggedError<MessageInvalidError>()(
  "MessageInvalidError",
  {
    reason: Schema.Literals(["empty", "too-long"]),
    length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {
  override get message(): string {
    return this.reason === "empty"
      ? "The message is empty."
      : `The message is too long. The limit is ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`;
  }
}

export class ThreadArchivedError extends Schema.TaggedError<ThreadArchivedError>()(
  "ThreadArchivedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${shortId(this.threadId)} is archived.`;
  }
}

export class ModelInvalidError extends Schema.TaggedError<ModelInvalidError>()(
  "ModelInvalidError",
  { model: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    const subject = this.model === "" ? "No model to use" : `Cannot use model '${this.model}'`;
    return `${subject}: ${this.reason} Run 't3c models' to see available models.`;
  }
}

export class NoPendingApprovalError extends Schema.TaggedError<NoPendingApprovalError>()(
  "NoPendingApprovalError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${shortId(this.threadId)} is not waiting for an approval.`;
  }
}

const TurnState = Schema.Literals(["completed", "interrupted", "error", "needs-approval", "needs-input"]);

/** Raised by --wait when the turn ended without completing, so the exit code is 1. */
export class TurnIncompleteError extends Schema.TaggedError<TurnIncompleteError>()(
  "TurnIncompleteError",
  { threadId: ThreadId, state: TurnState, detail: Schema.optional(Schema.String) },
) {
  override get message(): string {
    const id = shortId(this.threadId);
    switch (this.state) {
      case "needs-approval":
        return `Waiting for approval: ${this.detail}\nRun 't3c thread approve ${id}' or 't3c thread deny ${id}'.`;
      case "needs-input":
        return `The agent asked a question: ${this.detail}\nAnswer it in T3 Code, or reply with 't3c thread send ${id}'.`;
      case "error":
        return `The turn failed${this.detail ? `: ${this.detail}` : "."}`;
      default:
        return `The turn was ${this.state}.`;
    }
  }
}

const uuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);
const newCommandId = Effect.map(uuid, CommandId.make);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withAlias("w"),
  Flag.withDescription("Stream the agent's reply and exit when the turn ends (exit 1 unless it completes)."),
  Flag.withDefault(false),
);

const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("Thread id, or any unique prefix of it."),
);

const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message text, or '-' to read it from stdin."),
);

const ThreadTurnLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
);

const loadShellSnapshot = Effect.fn("loadShellSnapshot")(function* (client: T3RpcClient) {
  const item = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runHead);
  if (Option.isNone(item) || item.value.kind !== "snapshot") {
    return yield* new UnexpectedResponseError({ operation: "thread list" });
  }
  return item.value.snapshot;
});

const loadThreadSnapshot = Effect.fn("loadThreadSnapshot")(function* (
  client: T3RpcClient,
  threadId: ThreadId,
  turnLimit: number,
) {
  const item = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
    threadId,
    turnLimit,
    reasoningMessages: true,
  }).pipe(Stream.runHead);
  if (Option.isNone(item) || item.value.kind !== "snapshot") {
    return yield* new UnexpectedResponseError({ operation: "thread detail" });
  }
  return item.value.snapshot;
});

const loadProviders = (client: T3RpcClient) =>
  client[WS_METHODS.serverGetConfig]({}).pipe(Effect.map((config) => config.providers));

const dispatch = (client: T3RpcClient, command: ClientOrchestrationCommand) =>
  client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);

/** Find an item by exact id or unique id prefix, the way git resolves short hashes. */
export const pickById = <T extends { readonly id: string }>(
  kind: "project" | "thread",
  items: ReadonlyArray<T>,
  input: string,
): Effect.Effect<T, NotFoundError | AmbiguousError> => {
  const exact = items.find((item) => item.id === input);
  if (exact) return Effect.succeed(exact);
  const matches = input === "" ? [] : items.filter((item) => item.id.startsWith(input));
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  return Effect.fail(
    matches.length === 0
      ? new NotFoundError({ kind, input })
      : new AmbiguousError({ kind, input, matches: matches.map((item) => shortId(item.id)) }),
  );
};

const FULL_ID_LENGTH = 36;

/**
 * Resolve a thread id or prefix. Full ids skip the lookup, which also reaches
 * archived threads the shell snapshot leaves out.
 */
const resolveThreadId = Effect.fn("resolveThreadId")(function* (
  client: T3RpcClient,
  input: string,
  shell?: OrchestrationShellSnapshot,
) {
  const trimmed = input.trim();
  if (trimmed.length >= FULL_ID_LENGTH) return ThreadId.make(trimmed);
  const snapshot = shell ?? (yield* loadShellSnapshot(client));
  return (yield* pickById("thread", snapshot.threads, trimmed)).id;
});

const loadActiveThread = Effect.fn("loadActiveThread")(function* (client: T3RpcClient, input: string) {
  const { thread } = yield* loadThreadSnapshot(client, yield* resolveThreadId(client, input), 1);
  if (thread.archivedAt !== null) return yield* new ThreadArchivedError({ threadId: thread.id });
  return thread;
});

/**
 * Resolve a project by id, id prefix, name, or path. A path matches the
 * project that contains it, so any directory inside a project works. Paths
 * resolve on this machine, so they only match when the server shares its
 * filesystem.
 */
export const resolveProject = Effect.fn("resolveProject")(function* (
  snapshot: OrchestrationShellSnapshot,
  input: string,
) {
  const trimmed = input.trim();
  const exact = snapshot.projects.find((project) => project.id === trimmed);
  if (exact) return exact;

  const named = snapshot.projects.filter(
    (project) => project.title.toLowerCase() === trimmed.toLowerCase(),
  );
  const candidates =
    named.length > 0
      ? named
      : trimmed === ""
        ? []
        : snapshot.projects.filter((project) => project.id.startsWith(trimmed));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    return yield* new AmbiguousError({
      kind: "project",
      input,
      matches: candidates.map((project) => shortId(project.id)),
    });
  }

  // Only path-like input counts as a path, so a mistyped name can't match the current directory.
  const path = yield* Path.Path;
  if (trimmed !== "." && trimmed !== ".." && !trimmed.includes("/")) {
    return yield* new NotFoundError({ kind: "project", input });
  }
  const target = path.resolve(trimmed);
  const containing = snapshot.projects
    .filter(
      (project) =>
        target === project.workspaceRoot || target.startsWith(project.workspaceRoot + path.sep),
    )
    .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length);
  if (containing[0]) return containing[0];

  return yield* new NotFoundError({ kind: "project", input });
});

export const validateThreadMessage = Effect.fn("validateThreadMessage")(function* (
  message: string,
) {
  if (message.trim().length === 0) {
    return yield* new MessageInvalidError({ reason: "empty", length: message.length });
  }
  if (message.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return yield* new MessageInvalidError({ reason: "too-long", length: message.length });
  }
  return message;
});

/** Stdin is read only for an explicit "-", so a caller with an open, idle stdin never hangs. */
const readMessage = Effect.fn("readMessage")(function* (message: string) {
  if (message !== "-") return yield* validateThreadMessage(message);
  const text = yield* Effect.promise(() => readAll(process.stdin));
  return yield* validateThreadMessage(text.trimEnd());
});

/**
 * Resolve `provider/model`, or a bare model slug offered by one provider, and
 * an optional thinking level. Without a level the provider's default applies.
 */
export const resolveModelSelection = Effect.fn("resolveModelSelection")(function* (
  providers: ReadonlyArray<ServerProvider>,
  model: string,
  thinking: string | undefined,
) {
  const separator = model.indexOf("/");
  const instanceId = separator === -1 ? undefined : model.slice(0, separator);
  const slug = model.slice(separator + 1);
  const candidates = providers.filter(isProviderUsable).flatMap((provider) =>
    instanceId === undefined || provider.instanceId === instanceId
      ? provider.models
          .filter((candidate) => candidate.slug === slug)
          .map((providerModel) => ({ provider, providerModel }))
      : [],
  );
  if (candidates.length === 0) {
    return yield* new ModelInvalidError({ model, reason: "no enabled provider offers it." });
  }
  if (candidates.length > 1) {
    const names = candidates.map(({ provider }) => `${provider.instanceId}/${slug}`).join(", ");
    return yield* new ModelInvalidError({ model, reason: `pick one of ${names}.` });
  }

  const { provider, providerModel } = candidates[0]!;
  const selection: ModelSelection = { instanceId: provider.instanceId, model: slug };
  if (thinking === undefined) return selection;

  const levels = thinkingLevels(providerModel);
  const descriptor = thinkingDescriptor(providerModel);
  if (descriptor === undefined || !levels.includes(thinking)) {
    return yield* new ModelInvalidError({
      model,
      reason:
        levels.length === 0
          ? "it has no thinking levels."
          : `thinking level must be one of: ${levels.join(", ")}.`,
    });
  }
  return {
    ...selection,
    options: [
      { id: descriptor.id, value: descriptor.type === "boolean" ? thinking === "on" : thinking },
    ],
  };
});

/**
 * Model and access for a new thread. Anything not given on the command line
 * follows the project's most recent thread, like the app's sticky composer.
 */
export const resolveNewThreadSettings = Effect.fn("resolveNewThreadSettings")(function* (
  snapshot: OrchestrationShellSnapshot,
  providers: ReadonlyArray<ServerProvider>,
  project: OrchestrationProjectShell,
  flags: {
    readonly model: Option.Option<string>;
    readonly thinking: Option.Option<string>;
    readonly access: Option.Option<RuntimeMode>;
  },
) {
  const byRecency = snapshot.threads.toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const previous = byRecency.find((thread) => thread.projectId === project.id);
  const thinking = Option.getOrUndefined(flags.thinking);
  const runtimeMode = Option.getOrElse(
    flags.access,
    () => previous?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
  );

  if (Option.isSome(flags.model)) {
    return {
      modelSelection: yield* resolveModelSelection(providers, flags.model.value, thinking),
      runtimeMode,
    };
  }
  // The first candidate a provider still offers wins; a disabled one falls through.
  const candidates = [
    previous?.modelSelection,
    project.defaultModelSelection,
    byRecency[0]?.modelSelection,
  ].filter((selection) => selection != null);
  for (const inherited of candidates) {
    const resolved = yield* resolveModelSelection(
      providers,
      `${inherited.instanceId}/${inherited.model}`,
      thinking,
    ).pipe(Effect.option);
    if (Option.isNone(resolved)) continue;
    // Keep the inherited options (fast mode, context window); --thinking replaces only its own.
    const replaced = new Set(resolved.value.options?.map((option) => option.id));
    const options = [
      ...(inherited.options ?? []).filter((option) => !replaced.has(option.id)),
      ...(resolved.value.options ?? []),
    ];
    return {
      modelSelection: options.length > 0 ? { ...resolved.value, options } : resolved.value,
      runtimeMode,
    };
  }
  return yield* new ModelInvalidError({ model: "", reason: "pass --model." });
});

type TurnOutcome = {
  readonly state: typeof TurnState.Type;
  readonly detail?: string;
  readonly reply: string;
};

/**
 * Reduce a thread's events to the outcome of its current turn. `step` returns
 * the outcome once the turn ends; assistant text goes to `write` as it streams.
 *
 * ponytail: the turn "ends" at the first idle session after it started, so a
 * message queued behind a running turn returns when that earlier turn ends.
 */
export const makeTurnTracker = (options: {
  readonly running: boolean;
  readonly write: (text: string) => void;
}) => {
  const replies = new Map<string, string>();
  let started = options.running;
  let interruptRequested = false;
  let printed = "";
  const write = (text: string) => {
    if (text === "") return;
    options.write(text);
    printed = text;
  };

  const step = (event: OrchestrationEvent): Omit<TurnOutcome, "reply"> | undefined => {
    switch (event.type) {
      case "thread.message-sent": {
        const { messageId, role, streaming, text } = event.payload;
        if (role !== "assistant") return undefined;
        const previous = replies.get(messageId);
        if (previous === undefined && printed !== "") write("\n\n");
        // Streaming events carry deltas; the final event carries the whole text, or none.
        if (streaming) {
          replies.set(messageId, (previous ?? "") + text);
          write(text);
        } else if (previous === undefined) {
          replies.set(messageId, text);
          write(text);
        } else if (text !== "") {
          replies.set(messageId, text);
        }
        return undefined;
      }
      case "thread.activity-appended": {
        const { activity } = event.payload;
        const approval = approvalRequest(activity);
        if (approval !== undefined) return { state: "needs-approval", detail: describeApproval(approval) };
        if (activity.kind === "user-input.requested") return { state: "needs-input", detail: activity.summary };
        // Some failures (a turn that never starts, a stale approval) only surface as an activity.
        if (activity.kind.startsWith("provider.") && activity.kind.endsWith(".failed")) {
          const payload = activity.payload as Record<string, unknown> | null;
          const detail = typeof payload?.detail === "string" ? payload.detail : activity.summary;
          return { state: "error", detail };
        }
        return undefined;
      }
      // An interrupted turn can still end in a "ready" session, so remember the request.
      case "thread.turn-interrupt-requested":
        interruptRequested = true;
        return undefined;
      case "thread.session-set": {
        const { status, lastError } = event.payload.session;
        if (status === "starting" || status === "running") {
          started = true;
          return undefined;
        }
        if (!started) return undefined;
        if (status === "error") return { state: "error", ...(lastError ? { detail: lastError } : {}) };
        // Same mapping as the server's projector: a stopped session interrupts its turn.
        const interrupted = interruptRequested || status === "interrupted" || status === "stopped";
        return { state: interrupted ? "interrupted" : "completed" };
      }
      default:
        return undefined;
    }
  };

  return {
    step,
    reply: () => [...replies.values()].join("\n\n"),
    /** Finish the echoed output on its own line. */
    end: () => (printed === "" || printed.endsWith("\n") ? undefined : write("\n")),
  };
};

/** Follow a thread's events after `afterSequence` until its turn ends. */
const followTurn = (
  client: T3RpcClient,
  threadId: ThreadId,
  options: { readonly afterSequence: number; readonly running: boolean; readonly echo: boolean },
) => {
  const tracker = makeTurnTracker({
    running: options.running,
    write: (text) => (options.echo ? process.stdout.write(text) : undefined),
  });
  return client[ORCHESTRATION_WS_METHODS.subscribeThread]({
    threadId,
    afterSequence: options.afterSequence,
  }).pipe(
    Stream.map((item) => (item.kind === "event" ? tracker.step(item.event) : undefined)),
    Stream.filter((outcome) => outcome !== undefined),
    Stream.runHead,
    Effect.map(
      (outcome): TurnOutcome => ({
        ...Option.getOrElse(outcome, () => ({
          state: "error" as const,
          detail: "the server closed the thread stream.",
        })),
        reply: tracker.reply(),
      }),
    ),
    Effect.tap(() => Effect.sync(tracker.end)),
  );
};

/**
 * Report an accepted command. With --wait, follow the turn: the confirmation
 * moves to stderr so stdout carries only the reply.
 */
const reportTurn = Effect.fn("reportTurn")(function* (
  client: T3RpcClient,
  accepted: { readonly action: string; readonly threadId: ThreadId } & Record<string, unknown>,
  summary: string,
  options: {
    readonly json: boolean;
    readonly wait: boolean;
    readonly afterSequence: number;
    readonly running: boolean;
  },
) {
  if (!options.wait) {
    return yield* Console.log(options.json ? prettyJson(accepted) : summary);
  }
  if (!options.json) yield* Console.error(summary);
  const outcome = yield* followTurn(client, accepted.threadId, { ...options, echo: !options.json });
  if (options.json) yield* Console.log(prettyJson({ ...accepted, turn: outcome }));
  if (outcome.state !== "completed") {
    return yield* new TurnIncompleteError({
      threadId: accepted.threadId,
      state: outcome.state,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });
  }
});

const loginCommand = Command.make("login", {
  pairingUrl: Argument.String("pairing-url").pipe(
    Argument.withDescription("Pairing URL from 't3 pair' or Settings → Connections."),
  ),
}).pipe(
  Command.withDescription("Pair with a T3 Code server."),
  Command.withExamples([{ command: `t3c login "http://127.0.0.1:3773/pair#token=ABC123"` }]),
  Command.withHandler(({ pairingUrl }) =>
    login(pairingUrl).pipe(
      Effect.flatMap((server) =>
        Console.log(`Paired with ${server.origin}. The session expires ${relativeTime(server.expiresAt)}.`),
      ),
    ),
  ),
);

const logoutCommand = Command.make("logout").pipe(
  Command.withDescription(
    "Forget the saved session. Revoke it on the server in Settings → Connections.",
  ),
  Command.withHandler(() =>
    removeSavedServer.pipe(Effect.andThen(Console.log("Removed the saved session."))),
  ),
);

const statusCommand = Command.make("status", { json: jsonFlag }).pipe(
  Command.withDescription("Show the paired server and check that it is reachable."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const server = yield* readSavedServer;
      const { environment } = yield* withRpcClient((client) =>
        client[WS_METHODS.serverGetConfig]({}),
      );
      const status = {
        origin: server.origin,
        label: environment.label,
        serverVersion: environment.serverVersion,
        expiresAt: server.expiresAt,
      };
      yield* Console.log(
        flags.json
          ? prettyJson(status)
          : [
              `Server   ${status.origin} (${status.label})`,
              `Version  T3 Code ${status.serverVersion}`,
              `Session  expires ${relativeTime(status.expiresAt)}`,
            ].join("\n"),
      );
    }),
  ),
);

const modelsCommand = Command.make("models", { json: jsonFlag }).pipe(
  Command.withDescription("List models and their thinking levels."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      loadProviders(client).pipe(
        Effect.flatMap((providers) => Console.log(formatModelList(providers, flags))),
      ),
    ),
  ),
);

const usageCommand = Command.make("usage", { json: jsonFlag }).pipe(
  Command.withDescription("Show how much of each subscription usage window is left."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      loadProviders(client).pipe(
        Effect.flatMap((providers) => Console.log(formatUsageLimits(providers, flags))),
      ),
    ),
  ),
);

const projectListCommand = Command.make("list", { json: jsonFlag }).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List projects."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      loadShellSnapshot(client).pipe(
        Effect.flatMap((snapshot) => Console.log(formatProjectList(snapshot, flags))),
      ),
    ),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withDescription("List projects on the paired server."),
  Command.withSubcommands([projectListCommand]),
);

const threadListCommand = Command.make("list", {
  project: Flag.String("project").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Only threads in this project: id, name, or path."),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withAlias("a"),
    Flag.withDescription("Include settled threads."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List threads, most recently updated first. Settled threads are hidden unless --all is set."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const snapshot = yield* loadShellSnapshot(client);
        const project = Option.isSome(flags.project)
          ? yield* resolveProject(snapshot, flags.project.value)
          : undefined;
        yield* Console.log(
          formatThreadList(snapshot, {
            json: flags.json,
            includeSettled: flags.all,
            ...(project === undefined ? {} : { projectId: project.id }),
          }),
        );
      }),
    ),
  ),
);

const threadNewCommand = Command.make("new", {
  message: messageArgument,
  project: Flag.String("project").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Project id, name, or path. Defaults to the project containing the current directory."),
    Flag.withDefault("."),
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to one the server generates from the message."),
    Flag.withSchema(TrimmedNonEmptyString),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withAlias("m"),
    Flag.withDescription("Model from 't3c models', as provider/model or just model. Defaults to the project's last-used model."),
    Flag.optional,
  ),
  thinking: Flag.String("thinking").pipe(
    Flag.withAlias("t"),
    Flag.withDescription("Thinking level listed for the model by 't3c models'."),
    Flag.optional,
  ),
  access: Flag.Literals("access", RuntimeMode.literals).pipe(
    Flag.withDescription("What the agent may do without asking. Defaults to the project's last-used mode."),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a new thread with a first message."),
  Command.withExamples([
    { command: `t3c thread new "Fix the flaky tests"`, description: "In the project containing this directory" },
    { command: `t3c thread new -p backend -m claude-opus-5-5 -t high --wait "Review the last commit"` },
    { command: "git diff | t3c thread new --title 'Review diff' -", description: "Message from stdin" },
  ]),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const text = yield* readMessage(flags.message);
        const [snapshot, providers] = yield* Effect.all(
          [loadShellSnapshot(client), loadProviders(client)],
          { concurrency: "unbounded" },
        );
        const project = yield* resolveProject(snapshot, flags.project);
        const { modelSelection, runtimeMode } = yield* resolveNewThreadSettings(
          snapshot,
          providers,
          project,
          flags,
        );
        const threadId = ThreadId.make(yield* uuid);
        const messageId = MessageId.make(yield* uuid);
        const createdAt = yield* nowIso;
        // Like the app: a provisional title from the message that the server replaces with a generated one.
        const titleSeed = oneLineTitle(text);
        const title = Option.getOrElse(flags.title, () => titleSeed);
        const result = yield* dispatch(client, {
          type: "thread.turn.start",
          commandId: yield* newCommandId,
          threadId,
          message: { messageId, role: "user", text, attachments: [] },
          modelSelection,
          ...(Option.isNone(flags.title) ? { titleSeed } : {}),
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        });
        const model = `${modelSelection.instanceId}/${modelSelection.model}`;
        yield* reportTurn(
          client,
          { action: "created", threadId, messageId, projectId: project.id, model, runtimeMode },
          `Started thread ${shortId(threadId)} in ${project.title} (${model}, ${runtimeMode}).`,
          { ...flags, afterSequence: result.sequence, running: false },
        );
      }),
    ),
  ),
);

const TITLE_SEED_LENGTH = 50;
const oneLineTitle = (text: string) => {
  const line = oneLine(text);
  return line.length <= TITLE_SEED_LENGTH ? line : `${line.slice(0, TITLE_SEED_LENGTH).trimEnd()}...`;
};

const threadShowCommand = Command.make("show", {
  thread: threadArgument,
  turns: Flag.Int("turns").pipe(
    Flag.withAlias("n"),
    Flag.withSchema(ThreadTurnLimit),
    Flag.withDescription("Number of recent turns to show."),
    Flag.withDefault(5),
  ),
  json: jsonFlag,
}).pipe(
  Command.withAlias("view"),
  Command.withDescription("Show a thread's status and recent messages."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const shell = yield* loadShellSnapshot(client);
        const threadId = yield* resolveThreadId(client, flags.thread, shell);
        const thread = yield* loadThreadSnapshot(client, threadId, flags.turns);
        yield* Console.log(formatThreadDetail(thread, shell, flags));
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  thread: threadArgument,
  message: messageArgument,
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send a message to a thread."),
  Command.withExamples([
    { command: `t3c thread send 64f5 "Now run the focused tests"` },
    { command: `t3c thread send 64f5 --wait "Summarize the changes" > summary.md` },
  ]),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const text = yield* readMessage(flags.message);
        const thread = yield* loadActiveThread(client, flags.thread);
        const messageId = MessageId.make(yield* uuid);
        const result = yield* dispatch(client, {
          type: "thread.turn.start",
          commandId: yield* newCommandId,
          threadId: thread.id,
          message: { messageId, role: "user", text, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* nowIso,
        });
        yield* reportTurn(
          client,
          { action: "sent", threadId: thread.id, messageId },
          `Sent to thread ${shortId(thread.id)}.`,
          { ...flags, afterSequence: result.sequence, running: false },
        );
      }),
    ),
  ),
);

const threadStopCommand = Command.make("stop", { thread: threadArgument, json: jsonFlag }).pipe(
  Command.withDescription("Interrupt the thread's running turn."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const thread = yield* loadActiveThread(client, flags.thread);
        const session = thread.session;
        if (session === null || (session.status !== "running" && session.status !== "starting")) {
          return yield* Console.log(
            flags.json
              ? prettyJson({ action: "none", threadId: thread.id })
              : `Thread ${shortId(thread.id)} is not running.`,
          );
        }
        yield* dispatch(client, {
          type: "thread.turn.interrupt",
          commandId: yield* newCommandId,
          threadId: thread.id,
          ...(session.activeTurnId === null ? {} : { turnId: session.activeTurnId }),
          createdAt: yield* nowIso,
        });
        yield* Console.log(
          flags.json
            ? prettyJson({ action: "interrupted", threadId: thread.id })
            : `Interrupted thread ${shortId(thread.id)}.`,
        );
      }),
    ),
  ),
);

const approvalCommand = (
  name: "approve" | "deny",
  decision: ProviderApprovalDecision,
  description: string,
) =>
  Command.make(name, { thread: threadArgument, wait: waitFlag, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler((flags) =>
      withRpcClient((client) =>
        Effect.gen(function* () {
          const thread = yield* loadActiveThread(client, flags.thread);
          const approval = pendingApprovals(thread.activities)[0];
          if (approval === undefined) return yield* new NoPendingApprovalError({ threadId: thread.id });
          const result = yield* dispatch(client, {
            type: "thread.approval.respond",
            commandId: yield* newCommandId,
            threadId: thread.id,
            requestId: ApprovalRequestId.make(approval.requestId),
            decision,
            createdAt: yield* nowIso,
          });
          yield* reportTurn(
            client,
            { action: name === "approve" ? "approved" : "denied", threadId: thread.id, request: describeApproval(approval) },
            `${name === "approve" ? "Approved" : "Denied"}: ${describeApproval(approval)}`,
            { ...flags, afterSequence: result.sequence, running: true },
          );
        }),
      ),
    ),
  );

/** A command that dispatches one id-only thread command, like settle or archive. */
const threadActionCommand = (
  name: string,
  type: "thread.settle" | "thread.archive",
  description: string,
  past: string,
) =>
  Command.make(name, { thread: threadArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler((flags) =>
      withRpcClient((client) =>
        Effect.gen(function* () {
          const thread = yield* loadActiveThread(client, flags.thread);
          yield* dispatch(client, { type, commandId: yield* newCommandId, threadId: thread.id });
          yield* Console.log(
            flags.json
              ? prettyJson({ action: past.toLowerCase(), threadId: thread.id })
              : `${past} thread ${shortId(thread.id)}.`,
          );
        }),
      ),
    ),
  );

const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, follow, and manage threads."),
  Command.withSubcommands([
    threadListCommand,
    threadNewCommand,
    threadShowCommand,
    threadSendCommand,
    threadStopCommand,
    approvalCommand("approve", "accept", "Approve the thread's pending request."),
    approvalCommand("deny", "decline", "Deny the thread's pending request."),
    threadActionCommand(
      "settle",
      "thread.settle",
      "Mark a thread done. It moves to the Settled section and out of 'thread list'.",
      "Settled",
    ),
    threadActionCommand(
      "archive",
      "thread.archive",
      "Archive a thread and stop its provider session.",
      "Archived",
    ),
  ]),
);

export const cli = Command.make("t3c").pipe(
  Command.withDescription("Drive a T3 Code server from the terminal."),
  Command.withExamples([
    { command: `t3c login "http://127.0.0.1:3773/pair#token=ABC123"` },
    { command: `t3c thread new --wait "Explain this repo"`, description: "Start a thread here and stream the reply" },
    { command: "t3c thread list", description: "What's running and what needs you" },
  ]),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    statusCommand,
    projectCommand,
    threadCommand,
    modelsCommand,
    usageCommand,
  ]),
);
