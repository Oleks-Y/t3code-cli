# t3c

A command-line client for [T3 Code](https://github.com/pingdotgg/t3code) servers. It pairs like the
web and mobile apps do, so it works with any server you can reach: the desktop app, `npx t3`, or a
remote machine on your LAN or tailnet.

## Install

Requires Node 24 and pnpm.

```bash
git clone --recurse-submodules --shallow-submodules <this-repo> t3code-cli
cd t3code-cli
pnpm install
ln -sf "$PWD/src/main.ts" ~/.local/bin/t3c   # any directory on your PATH
```

Link the file rather than installing the package globally: Node does not run TypeScript from inside
`node_modules`, and pnpm 11 removed `pnpm link --global`.

## Pair

Create a pairing link on the server with `t3 pair`, or in Settings → Connections, then:

```bash
t3c login "http://127.0.0.1:3773/pair#token=ABC123"
```

Pairing tokens work once. The session lasts 30 days and shows up in the server's connections list,
where you can revoke it. `t3c logout` forgets it locally. The session is stored in
`$XDG_CONFIG_HOME/t3c/server.json` (default `~/.config/t3c/server.json`), readable only by you.

## Usage

```bash
t3c status                                  # paired server, version, session expiry
t3c thread new "Fix the flaky tests"        # new thread in the project containing this directory
t3c thread new -p backend -m claude-opus-5-5 -t high --wait "Review the last commit"
git diff | t3c thread new --title "Review diff" -   # "-" reads the message from stdin
t3c thread list                             # most recent first; --all adds settled threads
t3c thread show 64f5                        # status, recent messages, pending approvals
t3c thread send 64f5 --wait "Summarize the changes" > summary.md
t3c thread approve 64f5                     # or: deny
t3c thread stop 64f5                        # interrupt the running turn
t3c thread settle 64f5                      # mark done; archive removes it entirely
t3c project list
t3c models                                  # models and their thinking levels
t3c usage                                   # how much of each subscription window is left
```

- **Ids**: tables show 8-character ids. Any unique prefix works, like short git hashes.
- **Projects**: `--project` takes an id, a name, or a path. A path matches the project that
  contains it, so it only works when the server shares this machine's filesystem.
- **New threads**: model, thinking level, and `--access` default to the project's most recent
  thread. The server generates the title from the first message unless you pass `--title`.
  `--access` is one of `approval-required`, `auto-accept-edits`, `auto`, or `full-access`.
- **`--wait`**: streams the agent's reply to stdout and exits when the turn ends. Status lines go
  to stderr. The exit code is 1 unless the turn completes, including when it stops to wait for an
  approval.
- **`--json`**: every command accepts it.

## Agent skill

`skills/using-t3c` teaches coding agents to delegate work through `t3c` the way T3 Code is meant to
be used: one thread per task, an explicit access mode, approvals and questions left to you, and
finished work settled. Install it for Claude Code with:

```bash
ln -sf "$PWD/skills/using-t3c" ~/.claude/skills/using-t3c
```

## Staying in sync with the server

`t3c` uses the server's own wire contracts from `vendor/t3code`, a submodule pinned to a T3 Code
release tag. The pin should match the server you pair with; check its version at
`<server>/.well-known/t3/environment` (`serverVersion`). To move the pin:

```bash
git -C vendor/t3code fetch --depth 1 origin tag v0.0.43-nightly.20260923.2135
git -C vendor/t3code checkout v0.0.43-nightly.20260923.2135
# match "effect" and "@effect/platform-node" to vendor/t3code/pnpm-workspace.yaml's catalog
pnpm install && pnpm typecheck && pnpm test
git add vendor/t3code package.json pnpm-lock.yaml && git commit -m "chore: pin t3code <tag>"
```

`pnpm-workspace.yaml` applies T3 Code's own `effect` patch from the submodule, so the RPC client
behaves like the one the server was built against.

## Limits

- One paired server at a time.
- Pairing URLs must point straight at the server (`http(s)://host/pair#token=…`). T3 Connect relay
  links are not supported.
