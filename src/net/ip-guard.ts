import dns from "node:dns";
import net from "node:net";

/**
 * SSRF guard: the server downloads files from URLs that an AI model (and therefore, in the
 * worst case, injected text) chose. Those requests must never reach private networks,
 * loopback, link-local/cloud-metadata or Railway-internal addresses.
 */

const blocked = new net.BlockList();
const v4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
for (const [addr, prefix] of v4) blocked.addSubnet(addr, prefix, "ipv4");
const v6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];
for (const [addr, prefix] of v6) blocked.addSubnet(addr, prefix, "ipv6");

/** Extract the IPv4 address embedded in an IPv4-mapped / 6to4 style IPv6 address, if any. */
function embeddedV4(address: string): string | undefined {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

export function isBlockedIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true; // not an IP → treat as unsafe
  if (family === 4) return blocked.check(address, "ipv4");
  const inner = embeddedV4(address);
  if (inner) return isBlockedIp(inner);
  // 6to4 (2002::/16) embeds an IPv4 address in bits 16..48.
  const six = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})::?/i.exec(address);
  if (six) {
    const hi = parseInt(six[1]!, 16);
    const lo = parseInt(six[2]!, 16);
    if (isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)) return true;
  }
  return blocked.check(address, "ipv6");
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".railway.internal"];

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "metadata.google.internal") return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

/**
 * A `lookup` function for http(s).request that refuses to connect to non-public addresses.
 * Validating at connection time (instead of resolving first and connecting later) closes the
 * DNS-rebinding window.
 */
export function createGuardedLookup(resolver: Resolver = dns.lookup as unknown as Resolver): net.LookupFunction {
  const lookup = (
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void
  ): void => {
    resolver(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length) {
        return callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }));
      }
      const bad = addresses.find((a) => isBlockedIp(a.address));
      if (bad) {
        return callback(
          Object.assign(new Error("Blocked: the host resolves to a private or reserved address"), { code: "EBLOCKED" })
        );
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
  return lookup as unknown as net.LookupFunction;
}
