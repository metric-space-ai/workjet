import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { WorkjetNativeProviderRegistry } from "@workjet/contracts";
import {
  createWorkjetWorkerDraft,
  WorkjetWorkerEditor,
} from "../components/settings/WorkjetWorkerEditor";
import { nativeLumaRoutes } from "./workjetNativeProviders";

const decodeRegistry = Schema.decodeUnknownSync(WorkjetNativeProviderRegistry);

describe("native Claude Luma editor", () => {
  it("shows full live model names without presenting catalog metadata as inference", () => {
    const registry = decodeRegistry({
      ok: true,
      schema: "ctox.provider-federation-registry.v1",
      revision: 0,
      accounts: [
        {
          id: "196a89ba-ee86-4413-885c-04ca60e6f291",
          holder: { kind: "ctox_instance", id: "322084e5-8239-48d7-b3c5-c5178fbe5822" },
          provider: "claude",
          enabled: true,
          credentialReady: true,
          revision: 3,
          observedAtMs: 1,
          nativeAccountReference: {
            accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
            holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
            accountRevision: 3,
          },
          modelCatalogObserved: true,
          modelCatalog: {
            observed: true,
            fresh: true,
            models: ["claude-opus-5-5"],
            lastSuccessAtMs: 1,
            lastAttempt: {
              checkedAtMs: 1,
              httpStatus: 200,
              elapsedMs: 100,
              retryAfterSeconds: null,
              failure: null,
              success: true,
            },
          },
          excludedModels: [],
          effectiveModels: ["claude-opus-5-5"],
          inferenceVerified: false,
        },
      ],
      providers: [{ provider: "claude", selection: ["claude-opus-5-5"] }],
    });
    const markup = renderToStaticMarkup(
      <WorkjetWorkerEditor
        draftScopeKey="native-test"
        computers={[]}
        routes={nativeLumaRoutes([], registry, "Welsch")}
        nativeAccounts={registry.accounts}
        initialDraft={{
          ...createWorkjetWorkerDraft({
            computers: [],
            routes: nativeLumaRoutes([], registry, "Welsch"),
          }),
          modelId: "claude-opus-5-5",
        }}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain("claude-opus-5-5");
    expect(markup).toContain("CTOX");
    const failedRefresh = renderToStaticMarkup(<WorkjetWorkerEditor draftScopeKey="native-error"
      computers={[]} routes={nativeLumaRoutes([], registry, "Welsch")} nativeAccounts={registry.accounts}
      nativeModelsError="The instance connection was interrupted."
      onSave={() => undefined} onCancel={() => undefined} />);
    expect(failedRefresh).toContain('role="alert"');
    expect(failedRefresh).toContain("The instance connection was interrupted.");
    expect(failedRefresh).not.toContain("Live instance account models.");
    expect(markup).not.toContain("source-claude-account");
  });
});
