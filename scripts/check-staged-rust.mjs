import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

// Staged Rust files can belong to crates with different language/style editions.
// Fail closed if the owning manifest does not declare a supported edition.
function rustEdition(file) {
  let directory = NodePath.dirname(NodePath.resolve(file));
  for (;;) {
    const manifest = NodePath.join(directory, "Cargo.toml");
    if (NodeFS.existsSync(manifest)) {
      const text = NodeFS.readFileSync(manifest, "utf8");
      const packageSection = text.match(/(?:^|\n)\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1];
      const edition = packageSection?.match(
        /^edition\s*=\s*"(2015|2018|2021|2024)"\s*(?:#.*)?$/m,
      )?.[1];
      if (edition === undefined) {
        throw new Error(
          "Staged Rust format check requires an explicit package edition in " + manifest,
        );
      }
      return edition;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) throw new Error("No owning Cargo.toml for staged Rust file " + file);
    directory = parent;
  }
}

const groups = new Map();
for (const file of process.argv.slice(2)) {
  const edition = rustEdition(file);
  const files = groups.get(edition) ?? [];
  files.push(NodePath.resolve(file));
  groups.set(edition, files);
}
for (const [edition, files] of groups) {
  // Avoid recursively checking unstaged sibling modules from a staged lib.rs.
  const result = NodeChildProcess.spawnSync(
    "rustfmt",
    ["--edition", edition, "--config", "skip_children=true", "--check", ...files],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
