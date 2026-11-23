import { render } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  data: {
    available: true,
    baselineTokens: 5000,
    measuredTokens: 3200,
    measuredEvents: 12,
    savedTokens: 1800,
    totalRequests: 20,
    compressedRequests: 12,
    passthroughRequests: 8,
  } as {
    available: boolean;
    baselineTokens: number;
    measuredTokens: number;
    measuredEvents: number;
    savedTokens: number;
    totalRequests: number;
    compressedRequests: number;
    passthroughRequests: number;
  },
  refresh: vi.fn(),
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.data,
    error: null,
    isPending: false,
    refresh: state.refresh,
  })) as never,
}));

import { UsageCompression } from "./UsageCompression";

function setup() {
  state.data = {
    available: true,
    baselineTokens: 5000,
    measuredTokens: 3200,
    measuredEvents: 12,
    savedTokens: 1800,
    totalRequests: 20,
    compressedRequests: 12,
    passthroughRequests: 8,
  };
  state.refresh.mockClear();
}

const environments = [
  {
    environmentId: EnvironmentId.make("compression-env"),
    label: "Workstation",
    isPending: false,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    summary: null,
  },
];

it("reports pxpipe savings and links to both compression dashboards", async () => {
  setup();
  await using _screen = await render(
    <UsageCompression
      environments={environments}
      dashboardEnvironmentIds={new Set([environments[0]!.environmentId])}
    />,
  );

  await expect.element(page.getByText("Workstation")).toBeInTheDocument();
  await expect.element(page.getByText("1,800")).toBeInTheDocument();
  await expect.element(page.getByText("36.0%")).toBeInTheDocument();
  await expect.element(page.getByText("12 / 20")).toBeInTheDocument();

  const bili = page.getByRole("link", { name: "Open Bili dashboard" });
  const pxpipe = page.getByRole("link", { name: "Open pxpipe dashboard" });
  expect(bili.element().getAttribute("href")).toBe("http://127.0.0.1:8787/__bili/");
  expect(pxpipe.element().getAttribute("href")).toBe("http://127.0.0.1:47821/");

  await userEvent.click(page.getByRole("button", { name: "Refresh" }));
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("shows a clear message when pxpipe cannot report stats", async () => {
  setup();
  state.data = { ...state.data, available: false };
  await using _screen = await render(
    <UsageCompression
      environments={environments}
      dashboardEnvironmentIds={new Set([environments[0]!.environmentId])}
    />,
  );

  await expect.element(page.getByText(/pxpipe stats are unavailable/)).toBeInTheDocument();
  expect(page.getByText("Tokens saved").query()).toBeNull();
});

it("hides local-only dashboard links for remote environments", async () => {
  setup();
  await using _screen = await render(
    <UsageCompression environments={environments} dashboardEnvironmentIds={new Set()} />,
  );

  await expect.element(page.getByText("1,800")).toBeInTheDocument();
  expect(page.getByRole("link", { name: "Open Bili dashboard" }).query()).toBeNull();
  expect(page.getByRole("link", { name: "Open pxpipe dashboard" }).query()).toBeNull();
});
