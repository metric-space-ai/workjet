// @effect-diagnostics nodeBuiltinImport:off -- Allowlisted disposable host cleanup boundary.
import * as Path from "node:path";
import type { ComputerFacts } from "@workjet/contracts";
export const OWNED_COMPUTER_DIRECTORIES = ["runtime", "worktrees", "caches"] as const;
export function computerCleanupPaths(
  facts: Pick<ComputerFacts, "homeDirectory" | "workDirectory">,
): readonly string[] {
  const home = facts.homeDirectory;
  if (!Path.posix.isAbsolute(home) || home === "/" || Path.posix.normalize(home) !== home)
    throw new Error("Unsafe detected home directory");
  const root = Path.posix.join(home, ".workjet", "computer-work");
  if (facts.workDirectory !== root)
    throw new Error("Work directory is outside the cleanup allowlist");
  return OWNED_COMPUTER_DIRECTORIES.map((name) => Path.posix.join(root, name));
}
const quote = (text: string) => "'" + text.replace(/'/gu, "'\"'\"'") + "'";
/** Open directory descriptors anchor deletion; neither a symlink nor ancestor replacement can escape the allowlist. */
export function computerCleanupScript(
  facts: Pick<ComputerFacts, "homeDirectory" | "workDirectory">,
): string {
  const paths = computerCleanupPaths(facts);
  return (
    "python3 - " +
    [facts.homeDirectory, ...paths].map(quote).join(" ") +
    " <<'WORKJET_CLEANUP'\n" +
    `import os,sys,stat
def remove_contents(descriptor, device, prefix):
    for name in os.listdir(descriptor):
        entry=os.stat(name,dir_fd=descriptor,follow_symlinks=False)
        if entry.st_dev != device or os.path.join(prefix,name) in mount_points: raise ValueError("mount boundary")
        if stat.S_ISDIR(entry.st_mode):
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            try: remove_contents(child,device,os.path.join(prefix,name))
            finally: os.close(child)
            os.rmdir(name,dir_fd=descriptor)
        else: os.unlink(name,dir_fd=descriptor)
expected_home=sys.argv[1]
mount_points=set()
if os.path.exists("/proc/self/mountinfo"):
    with open("/proc/self/mountinfo") as mounts:
        for line in mounts:
            mount_points.add(line.split()[4].replace(chr(92)+"040"," ").replace(chr(92)+"011",chr(9)).replace(chr(92)+"134",chr(92)))
for path in sys.argv[2:]:
    descriptors=[]
    try:
        if os.environ.get("HOME") != expected_home: raise ValueError("home changed")
        if path in mount_points or os.path.ismount(path): raise ValueError("mount boundary")
        descriptor=os.open("/", os.O_RDONLY|os.O_DIRECTORY)
        descriptors.append(descriptor)
        parts=path.split(os.sep)[1:]
        for part in parts[:-1]:
            descriptor=os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=descriptor)
            descriptors.append(descriptor)
        try: entry=os.stat(parts[-1],dir_fd=descriptor,follow_symlinks=False)
        except FileNotFoundError: status="absent"
        else:
            if not stat.S_ISDIR(entry.st_mode): status="refused"
            else:
                if entry.st_dev != os.fstat(descriptor).st_dev: raise ValueError("mount boundary")
                child=os.open(parts[-1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
                try: remove_contents(child,os.fstat(child).st_dev,path)
                finally: os.close(child)
                os.rmdir(parts[-1],dir_fd=descriptor)
                status="removed"
    except FileNotFoundError: status="absent"
    except (ValueError,NotADirectoryError): status="refused"
    except OSError: status="failed"
    finally:
        for descriptor in reversed(descriptors): os.close(descriptor)
    print(status+"\\t"+path)
` +
    "\nWORKJET_CLEANUP\n"
  );
}
