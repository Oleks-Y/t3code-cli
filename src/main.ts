#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import packageJson from "../package.json" with { type: "json" };
import { cli } from "./commands.ts";

Command.run(cli, { version: packageJson.version }).pipe(
  // Expected failures carry a user-facing message; print it without a stack trace.
  Effect.catchIf(
    (error) => !CliError.isCliError(error),
    (error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
