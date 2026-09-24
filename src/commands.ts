import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectId,
  RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
  type ClientOrchestrationCommand,
} from "#contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { login, removeSavedServer, withRpcClient, type T3RpcClient } from "./connection.ts";

type DispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.create" | "thread.turn.start" | "thread.session.stop" | "thread.archive" }
>;

const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

export class UnexpectedResponseError extends Schema.TaggedError<UnexpectedResponseError>()(
  "UnexpectedResponseError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `The T3 Code server returned no ${this.operation} snapshot.`;
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { identifier: Schema.String },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'. Run 't3c project list'.`;
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
      ? "Thread message cannot be empty."
      : `Thread message is too long. The limit is ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`;
  }
}

export class ThreadArchivedError extends Schema.TaggedError<ThreadArchivedError>()(
  "ThreadArchivedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived.`;
  }
}

export class ModelInvalidError extends Schema.TaggedError<ModelInvalidError>()(
  "ModelInvalidError",
  { model: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot use model '${this.model}': ${this.reason} Run 't3c thread models' to see available models.`;
  }
}

const uuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const ThreadTurnLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
);

const threadIdArgument = Argument.String("thread-id").pipe(
  Argument.withDescription("Thread id."),
  Argument.withSchema(ThreadId),
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
  }).pipe(Stream.runHead);
  if (Option.isNone(item) || item.value.kind !== "snapshot") {
    return yield* new UnexpectedResponseError({ operation: "thread detail" });
  }
  return item.value.snapshot;
});

const loadProviders = (client: T3RpcClient) =>
  client[WS_METHODS.serverGetConfig]({}).pipe(Effect.map((config) => config.providers));

const dispatch = (client: T3RpcClient, command: DispatchCommand) =>
  client[ORCHESTRATION_WS_METHODS.dispatchCommand](command);

const threadStatus = (thread: OrchestrationThreadShell | OrchestrationThread): string =>
  thread.session?.status ?? thread.latestTurn?.state ?? "idle";

const oneLine = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/**
 * Resolve a project id or workspace path. Paths resolve on this machine, so a
 * relative path like `.` only matches when the server shares the filesystem.
 */
export const resolveProject = Effect.fn("resolveProject")(function* (
  snapshot: OrchestrationShellSnapshot,
  identifier: string,
) {
  const trimmed = identifier.trim();
  const idMatch = snapshot.projects.find((project) => project.id === trimmed);
  if (idMatch) return idMatch.id;

  const path = yield* Path.Path;
  const workspaceRoot = path.resolve(trimmed);
  const pathMatch = snapshot.projects.find((project) => project.workspaceRoot === workspaceRoot);
  if (pathMatch) return pathMatch.id;

  return yield* new ProjectNotFoundError({ identifier });
});

export const formatProjectList = (
  snapshot: OrchestrationShellSnapshot,
  options: { readonly json: boolean },
): string => {
  const projects = snapshot.projects.map((project) => ({
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
  }));
  if (options.json) return prettyJson(projects);
  if (projects.length === 0) return "No active projects.";
  return [
    "ID\tTITLE\tPATH",
    ...projects.map((project) => `${project.id}\t${oneLine(project.title)}\t${project.workspaceRoot}`),
  ].join("\n");
};

export const formatThreadList = (
  snapshot: OrchestrationShellSnapshot,
  options: {
    readonly json: boolean;
    readonly projectId?: ProjectId;
    readonly includeSettled?: boolean;
  },
): string => {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const entries = snapshot.threads
    .filter((thread) => options.projectId === undefined || thread.projectId === options.projectId)
    // Settled ("Done") threads live in the sidebar's collapsed Settled section.
    .filter((thread) => options.includeSettled || thread.settledOverride !== "settled")
    .map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      projectTitle: projects.get(thread.projectId) ?? thread.projectId,
      title: thread.title,
      status: thread.settledOverride === "settled" ? "settled" : threadStatus(thread),
      updatedAt: thread.updatedAt,
    }));
  if (options.json) return prettyJson(entries);
  if (entries.length === 0) return "No active threads.";

  return [
    "ID\tSTATUS\tPROJECT\tTITLE",
    ...entries.map(
      (entry) =>
        `${entry.id}\t${entry.status}\t${oneLine(entry.projectTitle)}\t${oneLine(entry.title)}`,
    ),
  ].join("\n");
};

const indentMessage = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

export const formatThreadDetail = (
  snapshot: OrchestrationThreadDetailSnapshot,
  shell: OrchestrationShellSnapshot,
  options: { readonly json: boolean },
): string => {
  if (options.json) return prettyJson(snapshot);

  const { thread } = snapshot;
  const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
  const messages = thread.messages.flatMap((message) =>
    message.text.length === 0
      ? []
      : [`${message.role} ${message.createdAt}`, indentMessage(message.text)],
  );
  return [
    `Thread ${thread.id}`,
    `Title: ${thread.title}`,
    `Project: ${project?.title ?? thread.projectId}`,
    `Status: ${threadStatus(thread)}`,
    `Model: ${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    `Runtime: ${thread.runtimeMode}`,
    `Branch: ${thread.branch ?? "none"}`,
    `Worktree: ${thread.worktreePath ?? "none"}`,
    `Updated: ${thread.updatedAt}`,
    ...(messages.length > 0 ? ["", "Messages", ...messages] : []),
  ].join("\n");
};

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

const requireActiveThread = (snapshot: OrchestrationThreadDetailSnapshot) =>
  snapshot.thread.archivedAt === null
    ? Effect.succeed(snapshot.thread)
    : Effect.fail(new ThreadArchivedError({ threadId: snapshot.thread.id }));

const isProviderUsable = (provider: ServerProvider) =>
  provider.enabled && provider.availability !== "unavailable";

// Provider option ids that carry a model's thinking level. Models without one
// may expose a boolean "thinking" toggle instead.
const THINKING_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning", "variant"]);

const thinkingDescriptor = (model: ServerProviderModel) =>
  model.capabilities?.optionDescriptors?.find((descriptor) =>
    descriptor.type === "select"
      ? THINKING_OPTION_IDS.has(descriptor.id)
      : descriptor.id === "thinking",
  );

const thinkingLevels = (model: ServerProviderModel): ReadonlyArray<string> => {
  const descriptor = thinkingDescriptor(model);
  if (descriptor === undefined) return ["none"];
  if (descriptor.type === "boolean") return ["on", "off"];
  // Prompt-injected levels (Claude "ultrathink") live in the message text, not the selection.
  return descriptor.options
    .map((option) => option.id)
    .filter((id) => !descriptor.promptInjectedValues?.includes(id));
};

export const resolveModelSelection = Effect.fn("resolveModelSelection")(function* (
  providers: ReadonlyArray<ServerProvider>,
  model: string,
  thinking: string,
) {
  const separator = model.indexOf("/");
  const instanceId = model.slice(0, separator);
  const slug = model.slice(separator + 1);
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (separator <= 0 || provider === undefined || !isProviderUsable(provider)) {
    return yield* new ModelInvalidError({ model, reason: "unknown or disabled provider." });
  }
  const providerModel = provider.models.find((candidate) => candidate.slug === slug);
  if (providerModel === undefined) {
    return yield* new ModelInvalidError({ model, reason: `${instanceId} has no model '${slug}'.` });
  }
  const levels = thinkingLevels(providerModel);
  if (!levels.includes(thinking)) {
    return yield* new ModelInvalidError({
      model,
      reason: `thinking level must be one of: ${levels.join(", ")}.`,
    });
  }

  const descriptor = thinkingDescriptor(providerModel);
  const selection: ModelSelection = { instanceId: provider.instanceId, model: slug };
  if (descriptor === undefined) return selection;
  return {
    ...selection,
    options: [
      { id: descriptor.id, value: descriptor.type === "boolean" ? thinking === "on" : thinking },
    ],
  };
});

export const formatModelList = (
  providers: ReadonlyArray<ServerProvider>,
  options: { readonly json: boolean },
): string => {
  const entries = providers.filter(isProviderUsable).flatMap((provider) =>
    provider.models.map((model) => ({
      model: `${provider.instanceId}/${model.slug}`,
      name: model.name,
      providerStatus: provider.status,
      auth: provider.auth.status,
      thinking: thinkingLevels(model),
    })),
  );
  if (options.json) return prettyJson(entries);
  if (entries.length === 0) return "No enabled providers.";

  return [
    "MODEL\tSTATUS\tTHINKING\tNAME",
    ...entries.map(
      (entry) =>
        `${entry.model}\t${entry.providerStatus}/${entry.auth}\t${entry.thinking.join(",")}\t${entry.name}`,
    ),
  ].join("\n");
};

const formatLocalTime = (iso: string | undefined) =>
  iso === undefined ? "-" : new Date(iso).toLocaleString();

export const formatUsageLimits = (
  providers: ReadonlyArray<ServerProvider>,
  options: { readonly json: boolean },
): string => {
  const entries = providers.flatMap((provider) =>
    isProviderUsable(provider) && provider.usageLimits
      ? [{ instanceId: provider.instanceId, ...provider.usageLimits }]
      : [],
  );
  if (options.json) return prettyJson(entries);
  if (entries.length === 0) return "No subscription usage limits reported.";

  return [
    "PROVIDER\tWINDOW\tLEFT\tRESETS\tCHECKED",
    ...entries.flatMap((entry) =>
      entry.unavailable
        ? [
            `${entry.instanceId}\t-\t-\t-\t${formatLocalTime(entry.checkedAt)}\t${entry.unavailable.message ?? entry.unavailable.reason}`,
          ]
        : entry.windows.map(
            (window) =>
              `${entry.instanceId}\t${window.label}\t${Math.max(0, 100 - window.usedPercent)}%\t${formatLocalTime(window.resetsAt)}\t${formatLocalTime(entry.checkedAt)}`,
          ),
    ),
  ].join("\n");
};

const formatAccepted = (input: {
  readonly action: "created" | "sent" | "stop-requested" | "archived";
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly messageId?: MessageId;
  readonly json: boolean;
}): string => {
  if (input.json) {
    return prettyJson({
      status: "accepted",
      action: input.action,
      threadId: input.threadId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      sequence: input.sequence,
    });
  }
  switch (input.action) {
    case "created":
      return `Created thread ${input.threadId}.`;
    case "sent":
      return `Sent message to thread ${input.threadId}.`;
    case "stop-requested":
      return `Requested stop for thread ${input.threadId}.`;
    case "archived":
      return `Archived thread ${input.threadId}.`;
  }
};

const loginCommand = Command.make("login", {
  pairingUrl: Argument.String("pairing-url").pipe(
    Argument.withDescription("Pairing URL from 't3 pair' or Settings → Connections."),
  ),
}).pipe(
  Command.withDescription("Pair with a T3 Code server."),
  Command.withHandler(({ pairingUrl }) =>
    login(pairingUrl).pipe(
      Effect.flatMap((server) =>
        Console.log(`Paired with ${server.origin}. Session expires ${server.expiresAt}.`),
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

const projectListCommand = Command.make("list", { json: jsonFlag }).pipe(
  Command.withDescription("List active projects."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      loadShellSnapshot(client).pipe(
        Effect.flatMap((snapshot) => Console.log(formatProjectList(snapshot, flags))),
      ),
    ),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withDescription("Inspect projects on the paired server."),
  Command.withSubcommands([projectListCommand]),
);

const threadListCommand = Command.make("list", {
  project: Flag.String("project").pipe(
    Flag.withDescription("Limit results to a project id or workspace path."),
    Flag.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Include settled threads."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active threads. Settled threads are hidden unless --all is set."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const snapshot = yield* loadShellSnapshot(client);
        const projectId = Option.isSome(flags.project)
          ? yield* resolveProject(snapshot, flags.project.value)
          : undefined;
        yield* Console.log(
          formatThreadList(snapshot, {
            json: flags.json,
            includeSettled: flags.all,
            ...(projectId === undefined ? {} : { projectId }),
          }),
        );
      }),
    ),
  ),
);

const threadModelsCommand = Command.make("models", { json: jsonFlag }).pipe(
  Command.withDescription("List models and thinking levels available for new threads."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      loadProviders(client).pipe(
        Effect.flatMap((providers) => Console.log(formatModelList(providers, flags))),
      ),
    ),
  ),
);

const threadCreateCommand = Command.make("create", {
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or workspace path for the new thread."),
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title."),
    Flag.withSchema(TrimmedNonEmptyString),
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model as <provider-instance>/<model>, as printed by 't3c thread models'."),
  ),
  thinking: Flag.String("thinking").pipe(
    Flag.withDescription("Thinking level listed for the model by 't3c thread models'."),
  ),
  access: Flag.Literals("access", RuntimeMode.literals).pipe(
    Flag.withDescription("Access mode for the agent."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a new thread in a project."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const [snapshot, providers] = yield* Effect.all([
          loadShellSnapshot(client),
          loadProviders(client),
        ]);
        const projectId = yield* resolveProject(snapshot, flags.project);
        const modelSelection = yield* resolveModelSelection(providers, flags.model, flags.thinking);
        const [commandUuid, threadUuid, now] = yield* Effect.all([uuid, uuid, DateTime.now]);
        const threadId = ThreadId.make(threadUuid);
        const result = yield* dispatch(client, {
          type: "thread.create",
          commandId: CommandId.make(commandUuid),
          threadId,
          projectId,
          title: flags.title,
          modelSelection,
          runtimeMode: flags.access,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(now),
        });
        yield* Console.log(
          formatAccepted({ action: "created", threadId, sequence: result.sequence, json: flags.json }),
        );
      }),
    ),
  ),
);

const threadShowCommand = Command.make("show", {
  threadId: threadIdArgument,
  turns: Flag.Int("turns").pipe(
    Flag.withSchema(ThreadTurnLimit),
    Flag.withDescription("Number of recent user turns to load."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show recent thread history and status."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const [thread, shell] = yield* Effect.all([
          loadThreadSnapshot(client, flags.threadId, flags.turns),
          loadShellSnapshot(client),
        ]);
        yield* Console.log(formatThreadDetail(thread, shell, flags));
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  threadId: threadIdArgument,
  message: Argument.String("message").pipe(
    Argument.withDescription("Message to send to the thread."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send a new user message to a thread."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const message = yield* validateThreadMessage(flags.message);
        const thread = yield* loadThreadSnapshot(client, flags.threadId, 1).pipe(
          Effect.flatMap(requireActiveThread),
        );
        const [commandUuid, messageUuid, now] = yield* Effect.all([uuid, uuid, DateTime.now]);
        const messageId = MessageId.make(messageUuid);
        const result = yield* dispatch(client, {
          type: "thread.turn.start",
          commandId: CommandId.make(commandUuid),
          threadId: thread.id,
          message: { messageId, role: "user", text: message, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(now),
        });
        yield* Console.log(
          formatAccepted({
            action: "sent",
            threadId: thread.id,
            messageId,
            sequence: result.sequence,
            json: flags.json,
          }),
        );
      }),
    ),
  ),
);

const threadStopCommand = Command.make("stop", { threadId: threadIdArgument, json: jsonFlag }).pipe(
  Command.withDescription("Stop a thread's provider session."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const thread = yield* loadThreadSnapshot(client, flags.threadId, 1).pipe(
          Effect.flatMap(requireActiveThread),
        );
        if (thread.session === null || thread.session.status === "stopped") {
          yield* Console.log(
            flags.json
              ? prettyJson({ status: "not-running", threadId: thread.id })
              : `Thread ${thread.id} has no running provider session.`,
          );
          return;
        }
        const [commandUuid, now] = yield* Effect.all([uuid, DateTime.now]);
        const result = yield* dispatch(client, {
          type: "thread.session.stop",
          commandId: CommandId.make(commandUuid),
          threadId: thread.id,
          createdAt: DateTime.formatIso(now),
        });
        yield* Console.log(
          formatAccepted({
            action: "stop-requested",
            threadId: thread.id,
            sequence: result.sequence,
            json: flags.json,
          }),
        );
      }),
    ),
  ),
);

const threadArchiveCommand = Command.make("archive", {
  threadId: threadIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Archive a thread and stop its provider session."),
  Command.withHandler((flags) =>
    withRpcClient((client) =>
      Effect.gen(function* () {
        const thread = yield* loadThreadSnapshot(client, flags.threadId, 1).pipe(
          Effect.flatMap(requireActiveThread),
        );
        const result = yield* dispatch(client, {
          type: "thread.archive",
          commandId: CommandId.make(yield* uuid),
          threadId: thread.id,
        });
        yield* Console.log(
          formatAccepted({
            action: "archived",
            threadId: thread.id,
            sequence: result.sequence,
            json: flags.json,
          }),
        );
      }),
    ),
  ),
);

const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads on the paired server."),
  Command.withSubcommands([
    threadListCommand,
    threadModelsCommand,
    threadCreateCommand,
    threadShowCommand,
    threadSendCommand,
    threadStopCommand,
    threadArchiveCommand,
  ]),
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

export const cli = Command.make("t3c").pipe(
  Command.withDescription("Drive a T3 Code server from the terminal."),
  Command.withSubcommands([loginCommand, logoutCommand, projectCommand, threadCommand, usageCommand]),
);
