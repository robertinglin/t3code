import { describe, expect, it } from "@effect/vitest";

import {
  parseProcStat,
  parseTcpTable,
  type ScopeProcess,
  sharedHelperPids,
  socketInode,
} from "./sharedHelpers.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (local: string, remote: string, state: string, inode: string) =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 0 0 10 -1\n`;

// Port 18787 is 0x4963.
const tcp =
  HEADER +
  row("0100007F:4963", "00000000:0000", "0A", "100") + // proxy listens
  row("0100007F:8CC0", "0100007F:4963", "01", "201") + // other agent's client
  row("0100007F:4963", "0100007F:8CC0", "01", "101") + // proxy's accepted side
  row("0100007F:9000", "00000000:0000", "0A", "300") + // dev server, not detached
  row("0100007F:9001", "00000000:0000", "0A", "400"); // detached, nobody connected

const proc = (pid: number, ppid: number, sid: number, inodes: Array<string>): ScopeProcess => ({
  pid,
  ppid,
  sid,
  socketInodes: new Set(inodes),
});

describe("parseTcpTable", () => {
  it("reads addresses, ports, state and inode", () => {
    expect(parseTcpTable(tcp)[1]).toEqual({
      localAddress: "0100007F",
      localPort: 0x8cc0,
      remoteAddress: "0100007F",
      remotePort: 18787,
      state: "01",
      inode: "201",
    });
  });
});

describe("parseProcStat", () => {
  it("reads ppid and session past a command name with spaces and parentheses", () => {
    expect(parseProcStat("81105 (node (main) x) S 1 81105 81105 0 -1 4194560")).toEqual({
      ppid: 1,
      sid: 81105,
    });
  });
});

describe("socketInode", () => {
  it("reads only socket links", () => {
    expect(socketInode("socket:[123]")).toBe("123");
    expect(socketInode("pipe:[123]")).toBeUndefined();
  });
});

describe("sharedHelperPids", () => {
  const processes = [
    proc(10, 1, 10, []), // the session's wrapper
    proc(11, 10, 10, ["999"]), // the agent itself
    proc(20, 1, 20, ["100", "101"]), // detached proxy
    proc(21, 20, 20, []), // proxy's child
    proc(30, 11, 10, ["300"]), // agent's dev server
    proc(40, 1, 40, ["400"]), // idle detached listener
  ];

  it("keeps a detached listener another agent is connected to, with its children", () => {
    expect(
      sharedHelperPids({
        processes,
        sockets: parseTcpTable(tcp),
        otherAgentInodes: new Set(["201"]),
      }),
    ).toEqual([20, 21]);
  });

  it("lets a helper only this session uses stop with it", () => {
    expect(
      sharedHelperPids({ processes, sockets: parseTcpTable(tcp), otherAgentInodes: new Set() }),
    ).toEqual([]);
  });

  it("never keeps a listener the agent started in its own session", () => {
    const client = HEADER + row("0100007F:8CC1", "0100007F:2328", "01", "202");
    expect(
      sharedHelperPids({
        processes,
        sockets: parseTcpTable(tcp + client.split("\n").slice(1).join("\n")),
        otherAgentInodes: new Set(["202"]),
      }),
    ).toEqual([]);
  });
});
