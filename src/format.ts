import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ServerProvider,
} from "#contracts";

export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Tables print the first 8 characters of UUID ids; any unique prefix resolves
 * back to the full id. Other ids (imported threads use `import:<provider>:<session>`)
 * share long prefixes, so they print in full.
 */
export const shortId = (id: string) => (/^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id);

export const oneLine = (value: string) => value.replaceAll(/\s+/g, " ").trim();

/** Left-aligned columns separated by two spaces. The last column is never padded. */
export const table = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => row[column]!.length)));
  return all
    .map((row) =>
      row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  "),
    )
    .join("\n");
};

export const relativeTime = (iso: string, now = Date.now()): string => {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return seconds <= 0 ? "just now" : "in <1m";
  const text =
    abs < 3600
      ? `${Math.floor(abs / 60)}m`
      : abs < 86_400
        ? `${Math.floor(abs / 3600)}h`
        : `${Math.floor(abs / 86_400)}d`;
  return seconds < 0 ? `${text} ago` : `in ${text}`;
};

/** What the agent is doing, collapsed to the states a user acts on. */
const activityStatus = (thread: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}): string => {
  switch (thread.session?.status ?? thread.latestTurn?.state) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return "idle";
  }
};

export const threadStatus = (thread: OrchestrationThreadShell): string => {
  if (thread.hasPendingApprovals) return "needs-approval";
  if (thread.hasPendingUserInput) return "needs-input";
  if (thread.settledOverride === "settled") return "settled";
  return activityStatus(thread);
};

export interface PendingApproval {
  readonly requestId: string;
  readonly summary: string;
  readonly detail?: string;
}

/** An approval request the user can answer, or undefined for any other activity. */
export const approvalRequest = (activity: OrchestrationThreadActivity): PendingApproval | undefined => {
  if (activity.kind !== "approval.requested") return undefined;
  const payload = activity.payload as Record<string, unknown> | null;
  if (
    typeof payload?.requestId !== "string" ||
    // The app answers these itself; they never reach the approval prompt.
    payload.requestType === "tool_user_input" ||
    payload.requestType === "auth_tokens_refresh"
  ) {
    return undefined;
  }
  return {
    requestId: payload.requestId,
    summary: activity.summary,
    ...(typeof payload.detail === "string" && payload.detail ? { detail: payload.detail } : {}),
  };
};

/** Approval requests without a resolution, oldest first. Mirrors the app's pending-request logic. */
export const pendingApprovals = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingApproval> => {
  const pending = new Map<string, PendingApproval>();
  const closed = new Set<string>();
  for (const activity of activities) {
    const request = approvalRequest(activity);
    if (request !== undefined) {
      if (!closed.has(request.requestId)) pending.set(request.requestId, request);
      continue;
    }
    const payload = activity.payload as Record<string, unknown> | null;
    if (
      typeof payload?.requestId === "string" &&
      (activity.kind === "approval.resolved" || activity.kind === "provider.approval.respond.failed")
    ) {
      closed.add(payload.requestId);
      pending.delete(payload.requestId);
    }
  }
  return [...pending.values()];
};

export const describeApproval = (approval: PendingApproval): string =>
  approval.detail === undefined ? approval.summary : `${approval.summary}: ${oneLine(approval.detail)}`;

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
  if (projects.length === 0) return "No projects.";
  return table(
    ["ID", "NAME", "PATH"],
    projects.map((project) => [shortId(project.id), oneLine(project.title), project.workspaceRoot]),
  );
};

export const formatThreadList = (
  snapshot: OrchestrationShellSnapshot,
  options: {
    readonly json: boolean;
    readonly projectId?: string;
    readonly includeSettled?: boolean;
  },
): string => {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const entries = snapshot.threads
    .filter((thread) => options.projectId === undefined || thread.projectId === options.projectId)
    // Settled threads live in the sidebar's collapsed Settled section.
    .filter((thread) => options.includeSettled || thread.settledOverride !== "settled")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({
      id: thread.id,
      status: threadStatus(thread),
      projectId: thread.projectId,
      project: projects.get(thread.projectId) ?? thread.projectId,
      title: thread.title,
      model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
      updatedAt: thread.updatedAt,
    }));
  if (options.json) return prettyJson(entries);
  if (entries.length === 0) return options.includeSettled ? "No threads." : "No active threads.";
  return table(
    ["ID", "STATUS", "UPDATED", "PROJECT", "TITLE"],
    entries.map((entry) => [
      shortId(entry.id),
      entry.status,
      relativeTime(entry.updatedAt),
      oneLine(entry.project),
      oneLine(entry.title),
    ]),
  );
};

export const formatThreadDetail = (
  snapshot: OrchestrationThreadDetailSnapshot,
  shell: OrchestrationShellSnapshot,
  options: { readonly json: boolean },
): string => {
  if (options.json) return prettyJson(snapshot);

  const { thread } = snapshot;
  const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
  const shellThread = shell.threads.find((candidate) => candidate.id === thread.id);
  const status =
    thread.archivedAt !== null
      ? "archived"
      : shellThread === undefined
        ? activityStatus(thread)
        : threadStatus(shellThread);
  const fields: Array<[string, string]> = [
    ["id", thread.id],
    ["project", project === undefined ? thread.projectId : `${project.title} (${project.workspaceRoot})`],
    ["status", `${status}, updated ${relativeTime(thread.updatedAt)}`],
    ["model", `${thread.modelSelection.instanceId}/${thread.modelSelection.model}, ${thread.runtimeMode}`],
  ];
  if (thread.branch !== null) fields.push(["branch", thread.branch]);
  if (thread.worktreePath !== null) fields.push(["worktree", thread.worktreePath]);

  // Reasoning stays out of the transcript; --json keeps it.
  const messages = thread.messages
    .filter((message) => message.role !== "reasoning" && message.text.trim().length > 0)
    .map((message) => `── ${message.role} · ${relativeTime(message.createdAt)}\n${message.text.trimEnd()}`);
  const approvals = pendingApprovals(thread.activities).map(
    (approval) => `Waiting for approval: ${describeApproval(approval)}`,
  );
  const id = shortId(thread.id);

  return [
    thread.title,
    ...fields.map(([label, value]) => `  ${label.padEnd(8)}  ${value}`),
    ...messages.map((message) => `\n${message}`),
    ...(approvals.length > 0
      ? ["", ...approvals, `Run 't3c thread approve ${id}' or 't3c thread deny ${id}'.`]
      : []),
  ].join("\n");
};

// Provider option ids that carry a model's thinking level. Models without one
// may expose a boolean "thinking" toggle instead.
const THINKING_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning", "variant"]);

export const thinkingDescriptor = (model: ServerProvider["models"][number]) =>
  model.capabilities?.optionDescriptors?.find((descriptor) =>
    descriptor.type === "select" ? THINKING_OPTION_IDS.has(descriptor.id) : descriptor.id === "thinking",
  );

export const thinkingLevels = (model: ServerProvider["models"][number]): ReadonlyArray<string> => {
  const descriptor = thinkingDescriptor(model);
  if (descriptor === undefined) return [];
  if (descriptor.type === "boolean") return ["on", "off"];
  // Prompt-injected levels (Claude "ultrathink") live in the message text, not the selection.
  return descriptor.options
    .map((option) => option.id)
    .filter((id) => !descriptor.promptInjectedValues?.includes(id));
};

export const isProviderUsable = (provider: ServerProvider) =>
  provider.enabled && provider.availability !== "unavailable";

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
  return table(
    ["MODEL", "THINKING", "NAME"],
    entries.map((entry) => [entry.model, entry.thinking.join(",") || "-", entry.name]),
  );
};

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

  const rows = entries.flatMap((entry) =>
    entry.unavailable
      ? []
      : entry.windows.map((window) => [
          entry.instanceId,
          window.label,
          `${Math.max(0, 100 - window.usedPercent)}%`,
          window.resetsAt === undefined ? "-" : relativeTime(window.resetsAt),
        ]),
  );
  const unavailable = entries.flatMap((entry) =>
    entry.unavailable
      ? [`${entry.instanceId}: ${entry.unavailable.message ?? entry.unavailable.reason}`]
      : [],
  );
  return [
    ...(rows.length > 0 ? [table(["PROVIDER", "WINDOW", "LEFT", "RESETS"], rows)] : []),
    ...(rows.length > 0 && unavailable.length > 0 ? [""] : []),
    ...unavailable,
  ].join("\n");
};
