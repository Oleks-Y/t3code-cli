import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  WS_METHODS,
  WsRpcGroup,
} from "#contracts";
import * as NodeOs from "node:os";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import * as Layer from "effect/Layer";

const CONNECT_TIMEOUT = "5 seconds";

const makeRpcClient = RpcClient.make(WsRpcGroup);
export type T3RpcClient =
  typeof makeRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

/** Credentials saved by `t3c login`. One server at a time. */
export const SavedServer = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
});
export type SavedServer = typeof SavedServer.Type;
const SavedServerJson = Schema.fromJsonString(SavedServer);

export class PairingUrlInvalidError extends Schema.TaggedError<PairingUrlInvalidError>()(
  "PairingUrlInvalidError",
  { input: Schema.String },
) {
  override get message(): string {
    return "Expected a pairing URL like http://host:3773/pair#token=ABC123. Create one with 't3 pair' or Settings → Connections.";
  }
}

export class NotLoggedInError extends Schema.TaggedError<NotLoggedInError>()(
  "NotLoggedInError",
  { reason: Schema.Literals(["missing", "expired", "rejected"]) },
) {
  override get message(): string {
    const why = {
      missing: "Not paired with a T3 Code server.",
      expired: "The saved T3 Code session has expired.",
      rejected: "The T3 Code server rejected the saved session.",
    }[this.reason];
    return `${why} Run 't3c login <pairing-url>'.`;
  }
}

export class ServerUnavailableError extends Schema.TaggedError<ServerUnavailableError>()(
  "ServerUnavailableError",
  { origin: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not reach the T3 Code server at ${this.origin}.`;
  }
}

export class PairingRejectedError extends Schema.TaggedError<PairingRejectedError>()(
  "PairingRejectedError",
  { origin: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `${this.origin} rejected the pairing token. Pairing tokens work once; create a new one.`;
  }
}

export const parsePairingUrl = (input: string) => {
  const url = URL.parse(input.trim());
  const pairingToken = url ? new URLSearchParams(url.hash.slice(1)).get("token") : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !pairingToken) {
    return Effect.fail(new PairingUrlInvalidError({ input }));
  }
  return Effect.succeed({ origin: url.origin, pairingToken });
};

const configPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const base = process.env.XDG_CONFIG_HOME || path.join(NodeOs.homedir(), ".config");
  return path.join(base, "t3c", "server.json");
});

export const readSavedServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* configPath;
  const contents = yield* fs
    .readFileString(file)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
  if (contents === null) return yield* new NotLoggedInError({ reason: "missing" });
  return yield* Schema.decodeEffect(SavedServerJson)(contents).pipe(
    Effect.mapError(() => new NotLoggedInError({ reason: "missing" })),
  );
});

const writeSavedServer = Effect.fn("writeSavedServer")(function* (server: SavedServer) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* configPath;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(file, Schema.encodeSync(SavedServerJson)(server), { mode: 0o600 });
});

export const removeSavedServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* configPath, { force: true });
});

const httpClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

/** Exchange a one-time pairing token for a session, the same way app.t3.codes and mobile pair. */
export const login = Effect.fn("login")(function* (pairingUrl: string) {
  const { origin, pairingToken } = yield* parsePairingUrl(pairingUrl);
  const client = yield* httpClient(origin);
  const issued = yield* client.auth
    .token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pairingToken,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: `t3c on ${NodeOs.hostname()}`,
        client_device_type: "bot",
        client_os: process.platform,
      },
    })
    .pipe(
      Effect.timeout(CONNECT_TIMEOUT),
      Effect.mapError((cause) =>
        cause._tag === "TimeoutError" || cause._tag === "HttpClientError"
          ? new ServerUnavailableError({ origin, cause })
          : new PairingRejectedError({ origin, cause }),
      ),
    );
  const now = yield* DateTime.now;
  const server: SavedServer = {
    origin,
    token: issued.access_token,
    expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: issued.expires_in })),
  };
  yield* writeSavedServer(server);
  return server;
}, Effect.provide(FetchHttpClient.layer));

const webSocketUrl = (origin: string, ticket: string) => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

/** Run `use` with an RPC client connected to the saved server. */
export const withRpcClient = <A, E, R>(use: (client: T3RpcClient) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const server = yield* readSavedServer;
    if (Date.parse(server.expiresAt) <= Date.now()) {
      return yield* new NotLoggedInError({ reason: "expired" });
    }
    const http = yield* httpClient(server.origin);
    const { ticket } = yield* http.auth
      .webSocketTicket({ headers: { authorization: `Bearer ${server.token}` } })
      .pipe(
        Effect.timeout(CONNECT_TIMEOUT),
        Effect.mapError((cause) =>
          cause._tag === "EnvironmentAuthInvalidError"
            ? new NotLoggedInError({ reason: "rejected" })
            : new ServerUnavailableError({ origin: server.origin, cause }),
        ),
      );

    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(webSocketUrl(server.origin, ticket))),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeRpcClient;
        yield* client[WS_METHODS.serverProbe]({}).pipe(
          Effect.timeout(CONNECT_TIMEOUT),
          Effect.mapError((cause) => new ServerUnavailableError({ origin: server.origin, cause })),
        );
        return yield* use(client);
      }),
    ).pipe(Effect.provide(protocol));
  }).pipe(Effect.provide(FetchHttpClient.layer));
