import type { DesktopDiscoveredSshHost } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sshAliasCandidates } from "./sshAliasCandidates";

const host = (
  alias: string,
  hostname = alias,
  source: DesktopDiscoveredSshHost["source"] = "ssh-config",
): DesktopDiscoveredSshHost => ({ alias, hostname, username: null, port: null, source });
const format = (target: DesktopDiscoveredSshHost) => target.alias;
const none = { keys: new Set<string>(), hostnames: new Set<string>() };

describe("SSH alias candidates (N6)", () => {
  it("drops git hosts, CTOX fleet hosts and known_hosts-only entries", () => {
    const result = sshAliasCandidates(
      [
        host("github.com"),
        host("gh", "github.com"),
        host("gitlab.com"),
        host("bitbucket.org"),
        host("azure", "ssh.dev.azure.com"),
        host("ctox-fleet-rbx6", "217.182.134.181"),
        host("ts-gpu3", "100.64.0.3"),
        host("seen.example.com", "seen.example.com", "known-hosts"),
      ],
      none,
      format,
    );
    expect(result.map((entry) => entry.alias)).toEqual(["ts-gpu3"]);
  });

  it("hides computers that are already set up, by alias, target or address", () => {
    const result = sshAliasCandidates(
      [host("ts-gpu3", "100.64.0.3"), host("lan-gpu3", "192.168.1.3"), host("nas", "10.0.0.28")],
      { keys: new Set(["nas"]), hostnames: new Set(["100.64.0.3"]) },
      format,
    );
    expect(result.map((entry) => entry.alias)).toEqual(["lan-gpu3"]);
  });

  it("lists computers already in known_hosts first, then alphabetically", () => {
    const result = sshAliasCandidates(
      [
        host("alpha", "10.0.0.1"),
        host("zulu", "10.0.0.9"),
        host("mike", "10.0.0.5"),
        host("10.0.0.9", "10.0.0.9", "known-hosts"),
      ],
      none,
      format,
    );
    expect(result.map((entry) => entry.alias)).toEqual(["zulu", "alpha", "mike"]);
  });
});
