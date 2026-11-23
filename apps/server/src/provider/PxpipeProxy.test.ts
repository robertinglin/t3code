import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PxpipeProxy from "./PxpipeProxy.ts";

const withSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  PxpipeProxy.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

describe("PxpipeProxy", () => {
  it.effect("starts pxpipe when the proxy reports readiness and stops it with the server", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const commands: Array<string> = [];
      const hosts: Array<unknown> = [];
      let killed = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") {
            commands.push(command.command);
            hosts.push(command.options.env?.HOST);
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(99),
            exitCode: Deferred.await(exited),
            isRunning: Effect.succeed(true),
            kill: () =>
              Effect.sync(() => {
                killed++;
                Deferred.doneUnsafe(exited, Effect.succeed(ChildProcessSpawner.ExitCode(0)));
              }),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.make(
              new TextEncoder().encode("[pxpipe] listening on http://127.0.0.1:47821\n"),
            ),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      yield* Effect.scoped(Layer.build(withSpawner(spawner)).pipe(Effect.asVoid));

      expect(commands).toEqual(["pxpipe"]);
      expect(hosts).toEqual(["127.0.0.1"]);
      expect(killed).toBe(1);
    }),
  );

  it.effect("keeps server startup alive when pxpipe is not installed", () =>
    Effect.gen(function* () {
      let spawnAttempts = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => spawnAttempts++).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                pathOrDescriptor: "pxpipe",
                syscall: "spawn pxpipe",
              }),
            ),
          ),
        ),
      );

      yield* Effect.scoped(Layer.build(withSpawner(spawner)).pipe(Effect.asVoid));
      expect(spawnAttempts).toBe(1);
    }),
  );
});
