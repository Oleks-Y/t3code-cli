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

## Commands

```bash
t3c project list
t3c thread models                  # models and their thinking levels
t3c usage                          # how much of each subscription window is left
t3c thread list [--project <id|path>] [--all]   # --all includes settled ("Done") threads
t3c thread create --project . --title "Fix flaky tests" \
  --model codex/gpt-5.6-sol --thinking high --access approval-required
t3c thread show <thread-id> [--turns 10]
t3c thread send <thread-id> "Continue with the focused tests"
t3c thread stop <thread-id>
t3c thread archive <thread-id>
```

Every command accepts `--json`. `--access` is one of `approval-required`, `auto-accept-edits`,
`auto`, or `full-access`. Project paths resolve on the machine running `t3c`, so `--project .`
only matches when the server shares that filesystem; use the project id from `t3c project list`
for remote servers.

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
