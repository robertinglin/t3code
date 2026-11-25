import { useGT, useMessages } from "gt-react";

import { useEnvironmentQuery } from "../../state/query";
import { pxpipeStats } from "../../state/pxpipe";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";

/* oxlint-disable react/iframe-missing-sandbox -- The fixed loopback dashboards need scripts and same-origin API calls; their ports are cross-origin to T3. */
const NUMBER_FORMAT = new Intl.NumberFormat();

export function UsageCompression({
  environments,
  dashboardEnvironmentIds,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly dashboardEnvironmentIds: ReadonlySet<EnvironmentUsageStatus["environmentId"]>;
}) {
  return (
    <div className="space-y-5">
      {environments.map((environment) => (
        <EnvironmentCompression
          key={environment.environmentId}
          environment={environment}
          canOpenDashboards={dashboardEnvironmentIds.has(environment.environmentId)}
        />
      ))}
    </div>
  );
}

function EnvironmentCompression({
  environment,
  canOpenDashboards,
}: {
  environment: EnvironmentUsageStatus;
  canOpenDashboards: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environment.isConnected
      ? pxpipeStats({ environmentId: environment.environmentId, input: {} })
      : null,
    m,
  );
  const savedPercent =
    data?.available && data.baselineTokens > 0
      ? `${((data.savedTokens / data.baselineTokens) * 100).toFixed(1)}%`
      : gt("N/A");

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-base font-semibold">{environment.label}</h2>
      <div className="grid gap-3">
        <article className="flex min-w-0 flex-col gap-3 rounded-md border p-4">
          <div>
            <h3 className="font-medium">{gt("Billion Context")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {gt("Inspect Bili sessions, token savings, and compression activity.")}
            </p>
          </div>
          {canOpenDashboards ? (
            <iframe
              className="h-[34rem] w-full rounded-md bg-background"
              sandbox="allow-scripts allow-same-origin allow-forms"
              src="http://127.0.0.1:18787/__bili/"
              title={gt("Billion Context")}
            />
          ) : null}
        </article>

        <article className="flex min-w-0 flex-col gap-3 rounded-md border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">pxpipe</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {gt("Token savings reported by pxpipe.")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={!environment.isConnected || isPending}
            >
              {gt("Refresh")}
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!data?.available && !isPending ? (
            <p className="text-sm text-muted-foreground">
              {gt(
                "pxpipe stats are unavailable. Check that pxpipe is installed and running on this server.",
              )}
            </p>
          ) : null}
          {data?.available ? (
            <dl className="grid grid-cols-2 gap-3">
              <Stat label={gt("Tokens saved")} value={NUMBER_FORMAT.format(data.savedTokens)} />
              <Stat label={gt("Estimated reduction")} value={savedPercent} />
              <Stat
                label={gt("Measured requests")}
                value={NUMBER_FORMAT.format(data.measuredEvents)}
              />
              <Stat
                label={gt("Compressed requests")}
                value={`${NUMBER_FORMAT.format(data.compressedRequests)} / ${NUMBER_FORMAT.format(data.totalRequests)}`}
              />
            </dl>
          ) : null}
          {canOpenDashboards ? (
            <iframe
              className="h-[34rem] w-full rounded-md bg-background"
              sandbox="allow-scripts allow-same-origin allow-forms"
              src="http://127.0.0.1:47821/"
              title="pxpipe"
            />
          ) : null}
        </article>
      </div>
    </section>
  );
}

/* oxlint-enable react/iframe-missing-sandbox */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-3">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
