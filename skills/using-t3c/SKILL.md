---
name: using-t3c
description: Use when delegating coding work to T3 Code agents from a terminal or another agent, or when the user mentions t3c, T3 Code threads, or starting, checking on, steering, approving, or settling T3 Code agents.
---

# Using t3c

`t3c` drives a paired T3 Code server. Each thread is one agent working on one task in one project.
Work the way T3 Code is meant to be used: one thread per task, deliberate permissions, the user
decides approvals and questions, and finished work gets settled.

## Quick reference

| Intent | Command |
| --- | --- |
| Check the connection | `t3c status` |
| Start a task and get the reply | `t3c thread new -p <project> --access <mode> --wait "<task>"` |
| Follow up, or change course mid-turn | `t3c thread send <id> --wait "<message>"` |
| See status, messages, pending approval | `t3c thread show <id>` |
| What's running and what needs the user | `t3c thread list` |
| Answer an approval | `t3c thread approve <id>` / `t3c thread deny <id>` |
| Abandon the current turn | `t3c thread stop <id>` |
| Finished | `t3c thread settle <id>` |
| Capacity before big or parallel work | `t3c usage`, `t3c models` |

Ids accept any unique prefix. Every command takes `--json`. A message of `-` reads stdin.

## Principles

1. **One thread per task.** Follow-ups and corrections go to the same thread with `send`; it
   keeps the context and access mode. Start a new thread only for a separate task.
2. **Write the first message for someone who hasn't seen your conversation.** State the goal, the
   constraints ("read-only", "don't touch the API"), and what the agent should report back.
3. **Pass `--access` on every `thread new`.** Leaving it out can mean full access. Enforce the
   user's constraints with the mode, not just the prompt: `approval-required` for read-only or risky
   work, `auto-accept-edits` or `auto` for routine changes, and `full-access` only when the user
   allows it.
4. **Approvals and questions belong to the user.** Read the exact request in the `--wait` output or
   in `t3c thread show`. Approve only what the user's instructions clearly cover, deny what they
   rule out, and ask the user about anything else. `t3c` cannot answer an agent's questions
   (`needs-input`): pass the question on and have the user answer it in T3 Code.
5. **Steer instead of restarting.** A `send` to a running thread reaches the agent mid-turn. Use
   `stop` only to abandon the current approach.
6. **Parallel edits need separate worktrees.** `t3c` starts threads in the project's own checkout.
   Two threads editing one project at once collide. Start them in the T3 Code app with **New
   worktree**, or run them one after another. Agent-made git worktrees are invisible to T3 Code.
7. **Check capacity before big or parallel work** with `t3c usage`. Leave `--thinking` unset to
   use the provider's default unless the task calls for more.
8. **Settle finished work** once the user has what they need. `settle` keeps the history and moves
   the thread out of the active list. Archive only when asked. Leave threads whose changes the user
   still has to review active.

## Waiting for results

- **One task:** `--wait` streams the reply to stdout and exits 0 only when the turn completes.
  Exit 1 prints why: `needs-approval` (answer with approve or deny), `needs-input`, `error`, or
  `interrupted`.
- **Several threads:** run each `--wait` in the background and use its exit code, or poll
  `t3c thread list --json` for `status`: `running`, `needs-approval`, `needs-input`, `idle`,
  `error`, `interrupted`, or `settled`.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| No `--access`, so the thread runs with full access | Choose a mode for every new thread |
| New thread for a follow-up | `send` to the existing thread |
| `stop` then `send` to change direction | Just `send`; it steers the running turn |
| Approving to keep things moving | Approve only what the user's instructions cover |
| Parallel code changes in one project | App worktrees, or run them one after another |
| Leaving done threads active, or archiving them | `settle` |

## Setup

If a command says it isn't paired, ask the user for a pairing link (`t3 pair`, or Settings →
Connections in T3 Code), then run `t3c login "<link>"`. `--project` accepts a path only when the
server runs on this machine; otherwise use a project name or id from `t3c project list`.
