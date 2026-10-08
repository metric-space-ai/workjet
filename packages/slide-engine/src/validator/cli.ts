// Entry point of dist/slide-engine-validator.mjs: one JSON request on stdin, one JSON object
// on stdout. Exit 0 for every well-formed request, 2 (with a stderr message) otherwise.
import { handleValidatorRequest, VALIDATOR_MAX_INPUT_BYTES } from "./protocol";

async function readInput(limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function fail(message: string) {
  process.stderr.write(`slide-engine-validator: ${message}\n`);
  process.exitCode = 2;
}

async function main() {
  const input = await readInput(VALIDATOR_MAX_INPUT_BYTES);
  if (!input) return fail(`input exceeds ${VALIDATOR_MAX_INPUT_BYTES} bytes`);
  let request: unknown;
  try {
    request = JSON.parse(input.toString("utf8"));
  } catch (error) {
    return fail(`input is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const outcome = handleValidatorRequest(request);
  if (outcome.exitCode === 2) return fail(outcome.error);
  process.stdout.write(`${JSON.stringify(outcome.response)}\n`);
  process.exitCode = 0;
}

await main();
