import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

const STARTUP_TIMEOUT = "10 seconds";

const start = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("pxpipe", [], {
        stdin: "ignore",
        env: { HOST: "127.0.0.1" },
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not start the pxpipe proxy", { error }).pipe(Effect.as(undefined)),
      ),
    );
  if (child === undefined) return;

  yield* Effect.addFinalizer(() => child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore));

  const ready = yield* Deferred.make<void>();
  yield* Stream.splitLines(child.all.pipe(Stream.decodeText())).pipe(
    Stream.runForEach((text) =>
      text.includes("[pxpipe] listening on http://")
        ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
        : Effect.void,
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const startup = yield* Effect.raceFirst(
    Deferred.await(ready).pipe(Effect.as("ready" as const)),
    child.exitCode.pipe(Effect.as("exited" as const)),
  ).pipe(Effect.timeoutOption(STARTUP_TIMEOUT));

  if (Option.isSome(startup) && startup.value === "ready") {
    yield* Effect.logInfo("Started the pxpipe proxy for this T3 server");
    return;
  }

  yield* Effect.logWarning("The pxpipe proxy did not start; it may already be running");
});

export const layer = Layer.effectDiscard(start);
