import { describe, it, expect } from "vitest";
import { createGuardedLookup, isBlockedHostname, isBlockedIp } from "../../../src/net/ip-guard.js";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:0001::1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "142.250.74.14", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public address %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    }
  );

  it("treats non-IP strings as unsafe", () => {
    expect(isBlockedIp("example.com")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "foo.localhost", "db.railway.internal", "printer.local", "metadata.google.internal", "LOCALHOST."])(
    "blocks %s",
    (h) => expect(isBlockedHostname(h)).toBe(true)
  );
  it("allows normal hosts", () => {
    expect(isBlockedHostname("drive.google.com")).toBe(false);
    expect(isBlockedHostname("dl.dropboxusercontent.com")).toBe(false);
  });
});

describe("createGuardedLookup (DNS-rebinding guard)", () => {
  const lookupWith = (addresses: Array<{ address: string; family: number }>) =>
    createGuardedLookup((_h, _o, cb) => cb(null, addresses));

  const run = (lookup: ReturnType<typeof createGuardedLookup>, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => {
      (lookup as unknown as (h: string, o: object, cb: (e: NodeJS.ErrnoException | null, a?: unknown) => void) => void)(
        "files.example.com",
        { all },
        (err, address) => resolve({ err, address })
      );
    });

  it("passes public addresses through", async () => {
    const r = await run(lookupWith([{ address: "93.184.216.34", family: 4 }]));
    expect(r.err).toBeNull();
    expect(r.address).toBe("93.184.216.34");
  });

  it("returns the full list when asked for all addresses", async () => {
    const r = await run(lookupWith([{ address: "93.184.216.34", family: 4 }]), true);
    expect(Array.isArray(r.address)).toBe(true);
  });

  it("refuses a host that resolves to a private address", async () => {
    const r = await run(lookupWith([{ address: "10.0.0.7", family: 4 }]));
    expect(r.err?.code).toBe("EBLOCKED");
  });

  it("refuses when ANY resolved address is private (mixed answers)", async () => {
    const r = await run(
      lookupWith([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ])
    );
    expect(r.err?.code).toBe("EBLOCKED");
  });
});
