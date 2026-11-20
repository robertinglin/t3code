/**
 * Finds detached loopback helpers (e.g. bili's shared proxy) in an agent scope
 * that other agents still use, so stopping that scope does not kill them.
 */

export interface TcpSocket {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
  readonly inode: string;
}

export interface ScopeProcess {
  readonly pid: number;
  readonly ppid: number;
  /** Session id; a detached daemon leads its own session. */
  readonly sid: number;
  readonly socketInodes: ReadonlySet<string>;
}

const TCP_LISTEN = "0A";
const TCP_ESTABLISHED = "01";

const LOOPBACK_OR_ANY = new Set([
  "0100007F", // 127.0.0.1
  "00000000", // 0.0.0.0
  "00000000000000000000000001000000", // ::1
  "00000000000000000000000000000000", // ::
  "0000000000000000FFFF00000100007F", // ::ffff:127.0.0.1
]);

/** Parses /proc/net/tcp or /proc/net/tcp6. */
export function parseTcpTable(text: string): Array<TcpSocket> {
  const sockets: Array<TcpSocket> = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [localAddress = "", localPort = ""] = fields[1]!.split(":");
    const [remoteAddress = "", remotePort = ""] = fields[2]!.split(":");
    sockets.push({
      localAddress: localAddress.toUpperCase(),
      localPort: Number.parseInt(localPort, 16),
      remoteAddress: remoteAddress.toUpperCase(),
      remotePort: Number.parseInt(remotePort, 16),
      state: fields[3]!.toUpperCase(),
      inode: fields[9]!,
    });
  }
  return sockets;
}

/** Parses ppid and session id from /proc/<pid>/stat. */
export function parseProcStat(text: string): { ppid: number; sid: number } | undefined {
  // The command name is parenthesized and may hold spaces or parentheses.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const sid = Number(fields[3]);
  return Number.isInteger(ppid) && Number.isInteger(sid) ? { ppid, sid } : undefined;
}

/** `socket:[123]` from /proc/<pid>/fd links. */
export function socketInode(link: string): string | undefined {
  return /^socket:\[(\d+)\]$/.exec(link)?.[1];
}

/** Detached loopback listeners in the scope; the only candidates worth a wider search. */
export function detachedListeners(
  processes: ReadonlyArray<ScopeProcess>,
  sockets: ReadonlyArray<TcpSocket>,
): Map<number, number> {
  const ownerByPort = new Map<number, number>();
  for (const socket of sockets) {
    if (socket.state !== TCP_LISTEN || !LOOPBACK_OR_ANY.has(socket.localAddress)) continue;
    const owner = processes.find(
      (process) => process.sid === process.pid && process.socketInodes.has(socket.inode),
    );
    if (owner !== undefined) ownerByPort.set(socket.localPort, owner.pid);
  }
  return ownerByPort;
}

/**
 * Pids to move out of the scope: each detached listener another agent is
 * connected to, with its descendants in the scope.
 */
export function sharedHelperPids(input: {
  readonly processes: ReadonlyArray<ScopeProcess>;
  readonly sockets: ReadonlyArray<TcpSocket>;
  /** Socket inodes held by processes in other agent scopes. */
  readonly otherAgentInodes: ReadonlySet<string>;
}): Array<number> {
  const { processes, sockets, otherAgentInodes } = input;
  const ownerByPort = detachedListeners(processes, sockets);
  const roots = new Set<number>();
  for (const socket of sockets) {
    if (socket.state !== TCP_ESTABLISHED || !otherAgentInodes.has(socket.inode)) continue;
    if (!LOOPBACK_OR_ANY.has(socket.remoteAddress)) continue;
    const owner = ownerByPort.get(socket.remotePort);
    if (owner !== undefined) roots.add(owner);
  }
  const moved = new Set(roots);
  let grew = moved.size > 0;
  while (grew) {
    grew = false;
    for (const process of processes) {
      if (!moved.has(process.pid) && moved.has(process.ppid)) {
        moved.add(process.pid);
        grew = true;
      }
    }
  }
  return [...moved].sort((a, b) => a - b);
}
