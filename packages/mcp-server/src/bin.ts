#!/usr/bin/env node
/**
 * Executable entry for the `oss-scout-mcp` binary. The shebang lives here
 * (this is the esbuild bundle entry); importing the package (`index.ts`)
 * stays side-effect-free (#148).
 */
import { runServer } from "./index.js";

runServer().catch((err) => {
  process.stderr.write(
    `oss-scout-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
