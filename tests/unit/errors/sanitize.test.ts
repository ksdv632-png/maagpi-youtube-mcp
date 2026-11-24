import { describe, it, expect } from "vitest";
import { sanitizeMessage } from "../../../src/errors/sanitize.js";

describe("sanitizeMessage", () => {
  it("redacts bearer tokens, Google tokens and OAuth params", () => {
    const raw =
      "Request failed: Authorization: Bearer ya29.A0ARrdaM-abcdefghijklmnop refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz and refresh_token=abc123&client_secret=topsecret";
    const out = sanitizeMessage(raw);
    expect(out).not.toMatch(/ya29\.A0ARrdaM/);
    expect(out).not.toMatch(/0gAbCdEfGhIjKlMnOpQrStUvWxYz/);
    expect(out).not.toMatch(/abc123|topsecret/);
  });

  it("redacts our own sealed tokens and JSON bodies", () => {
    const token = "v1." + "A".repeat(80);
    expect(sanitizeMessage(`token ${token}`)).not.toContain(token);
    expect(sanitizeMessage('{"refresh_token":"1//secretvalue","x":1}')).not.toContain("secretvalue");
  });

  it("truncates long messages", () => {
    expect(sanitizeMessage("x".repeat(5000)).length).toBeLessThan(700);
  });
});
