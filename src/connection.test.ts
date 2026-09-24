import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PairingUrlInvalidError, parsePairingUrl } from "./connection.ts";

it.effect("reads the origin and one-time token from a pairing URL", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parsePairingUrl(" https://box.tail1234.ts.net/pair#token=ABC123 "), {
      origin: "https://box.tail1234.ts.net",
      pairingToken: "ABC123",
    });

    for (const input of ["http://host:3773/pair", "ftp://host/pair#token=A", "not a url"]) {
      const error = yield* parsePairingUrl(input).pipe(Effect.flip);
      assert.instanceOf(error, PairingUrlInvalidError);
    }
  }),
);
