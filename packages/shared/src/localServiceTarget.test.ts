import { describe, expect, it } from "@effect/vitest";
import { isLocalServiceOrigin } from "./localServiceTarget.ts";

describe("local service origin boundary", () => {
  it("accepts literal IPv4 and IPv6 loopback endpoints", () => {
    expect(isLocalServiceOrigin("http://127.0.0.1:3773")).toBe(true);
    expect(isLocalServiceOrigin("http://[::1]:3773/")).toBe(true);
  });
  it.each([
    "https://127.0.0.1:3773",
    "http://localhost:3773",
    "http://192.168.1.1:3773",
    "http://127.0.0.1.evil.example",
    "http://user:password@127.0.0.1:3773",
    "http://127.0.0.1:3773/path",
    "http://127.0.0.1:3773/?token=x",
    "http://127.0.0.1:3773/#fragment",
    "not a URL",
  ])("rejects non-local or decorated origin %s", (origin) => {
    expect(isLocalServiceOrigin(origin)).toBe(false);
  });
});
