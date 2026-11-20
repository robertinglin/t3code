import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CovenControlService } from "./CovenControlService.ts";
import type { CovenService } from "./CovenService.ts";

export const makeHandlers = (
  covens: CovenService["Service"],
  control: CovenControlService["Service"],
) => ({
  [WS_METHODS.covensSubscribeList]: (
    input: Parameters<CovenService["Service"]["subscribeList"]>[0],
  ) => covens.subscribeList(input),
  [WS_METHODS.covensGet]: (input: { readonly covenId: string }) => covens.get(input.covenId),
  [WS_METHODS.covensSave]: (input: Parameters<CovenService["Service"]["save"]>[0]) =>
    covens.save(input),
  [WS_METHODS.covensArchive]: (input: { readonly covenId: string }) =>
    control.archive(input.covenId),
  [WS_METHODS.covensSubscribeThread]: (input: {
    readonly threadId: Parameters<CovenService["Service"]["subscribeThread"]>[0];
  }) => covens.subscribeThread(input.threadId),
  [WS_METHODS.covensSetThread]: (input: {
    readonly threadId: Parameters<CovenControlService["Service"]["setThread"]>[0];
    readonly covenId: string;
  }) => control.setThread(input.threadId, input.covenId),
  [WS_METHODS.covensGetRevision]: (input: {
    readonly covenId: string;
    readonly revision: number;
  }) => covens.getRevision(input.covenId, input.revision),
  [WS_METHODS.covensControlRun]: (input: {
    readonly threadId: Parameters<CovenControlService["Service"]["controlRun"]>[0];
    readonly action: Parameters<CovenControlService["Service"]["controlRun"]>[1];
  }) => control.controlRun(input.threadId, input.action),
  [WS_METHODS.covensDecide]: (input: Parameters<CovenControlService["Service"]["decide"]>[0]) =>
    control.decide(input),
  [WS_METHODS.covensClearCooldown]: (input: {
    readonly providerInstanceId: string;
    readonly modelId: string;
  }) => covens.clearCooldown(input.providerInstanceId, input.modelId).pipe(Effect.as({})),
  [WS_METHODS.covensStartBuilder]: (
    input: Parameters<CovenControlService["Service"]["startBuilder"]>[0],
  ) => control.startBuilder(input),
  [WS_METHODS.covensSubscribeDraft]: (input: {
    readonly draftId: Parameters<CovenService["Service"]["subscribeDraft"]>[0];
  }) => covens.subscribeDraft(input.draftId),
  [WS_METHODS.covensDraftForThread]: (input: {
    readonly threadId: Parameters<CovenService["Service"]["draftForThread"]>[0];
  }) => covens.draftForThread(input.threadId).pipe(Effect.map((draft) => ({ draft }))),
  [WS_METHODS.covensUpdateDraft]: (input: {
    readonly draftId: string;
    readonly source: string;
    readonly expectedVersion: number;
  }) => covens.updateDraft({ ...input, by: "user", summary: null }),
  [WS_METHODS.covensSaveDraft]: (input: {
    readonly draftId: Parameters<CovenControlService["Service"]["saveDraft"]>[0];
  }) => control.saveDraft(input.draftId),
  [WS_METHODS.covensClearThread]: (input: {
    readonly threadId: Parameters<CovenControlService["Service"]["clearThread"]>[0];
  }) => control.clearThread(input.threadId),
});
