import process from "node:process";
import { initializeNewSelfHostedAuthDatabase, SelfHostedSchemaError } from "../src/self-hosted/schema";

const pathInput = readDatabasePath(process.argv.slice(2));
if (pathInput === null) {
  process.stderr.write("Usage: bun run self-hosted:init -- --database <new-local-file.sqlite>\n");
  process.exitCode = 2;
} else {
  try {
    await initializeNewSelfHostedAuthDatabase(pathInput);
    // Machine-readable: local tooling can confirm the explicit initialization completed.
    process.stdout.write('{"status":"initialized"}\n');
  } catch (error) {
    const code = error instanceof SelfHostedSchemaError ? error.code : "schema_incomplete";
    process.stderr.write(`Self-hosted account schema initialization failed: ${code}\n`);
    process.exitCode = 1;
  }
}

function readDatabasePath(args: readonly string[]): string | null {
  if (args.length !== 2 || args[0] !== "--database") return null;
  const path = args[1]?.trim();
  return path ? path : null;
}
