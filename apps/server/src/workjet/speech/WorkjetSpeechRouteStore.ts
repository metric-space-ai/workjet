// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  EnvironmentId,
  type WorkjetSpeechRoute,
  type WorkjetSpeechRouteListResult,
  type WorkjetSpeechSessionKind,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../../persistence/Errors.ts";

const SESSION_KINDS: ReadonlyArray<WorkjetSpeechSessionKind> = ["regeltermin", "spontan"];

const emptyRoute = (sessionKind: WorkjetSpeechSessionKind): WorkjetSpeechRoute => ({
  sessionKind,
  sttEnvironmentId: null,
  ttsEnvironmentId: null,
});

export interface WorkjetSpeechRouteStoreShape {
  readonly list: Effect.Effect<WorkjetSpeechRouteListResult, PersistenceSqlError>;
  readonly set: (
    route: WorkjetSpeechRoute,
  ) => Effect.Effect<WorkjetSpeechRoute, PersistenceSqlError>;
}

export class WorkjetSpeechRouteStore extends Context.Service<
  WorkjetSpeechRouteStore,
  WorkjetSpeechRouteStoreShape
>()("workjet/speech/WorkjetSpeechRouteStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly session_kind: WorkjetSpeechSessionKind;
      readonly stt_environment_id: string | null;
      readonly tts_environment_id: string | null;
    }>`
      SELECT session_kind, stt_environment_id, tts_environment_id
      FROM workjet_speech_routes
    `;
    const stored = new Map(
      rows.map((row) => [
        row.session_kind,
        {
          sessionKind: row.session_kind,
          sttEnvironmentId:
            row.stt_environment_id === null ? null : EnvironmentId.make(row.stt_environment_id),
          ttsEnvironmentId:
            row.tts_environment_id === null ? null : EnvironmentId.make(row.tts_environment_id),
        } satisfies WorkjetSpeechRoute,
      ]),
    );
    return {
      routes: SESSION_KINDS.map((kind) => stored.get(kind) ?? emptyRoute(kind)),
    };
  }).pipe(Effect.mapError((cause) => new PersistenceSqlError({ operation: "list", cause })));

  const set = (route: WorkjetSpeechRoute) =>
    sql`
      INSERT INTO workjet_speech_routes (session_kind, stt_environment_id, tts_environment_id)
      VALUES (${route.sessionKind}, ${route.sttEnvironmentId}, ${route.ttsEnvironmentId})
      ON CONFLICT(session_kind) DO UPDATE SET
        stt_environment_id = excluded.stt_environment_id,
        tts_environment_id = excluded.tts_environment_id
    `.pipe(
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "set", cause })),
      Effect.as(route),
    );

  return { list, set } satisfies WorkjetSpeechRouteStoreShape;
});

export const WorkjetSpeechRouteStoreLive = Layer.effect(WorkjetSpeechRouteStore, make);
