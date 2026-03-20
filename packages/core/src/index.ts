import path from "node:path";
import os from "node:os";
import { CoreEngine } from "./engine";

export { CoreEngine } from "./engine";

export function defaultPaths(): { dbPath: string; pipeName: string } {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return {
    dbPath: path.join(appData, "WinCMux", "wincmux.db"),
    pipeName: "\\\\.\\pipe\\wincmux-rpc"
  };
}

if (require.main === module) {
  const { dbPath, pipeName } = defaultPaths();
  const engine = new CoreEngine({ dbPath, pipeName });
  engine
    .start()
    .then(() => {
      console.log(`[wincmux-core] listening on ${pipeName}`);
    })
    .catch((err) => {
      console.error("[wincmux-core] failed to start", err);
      process.exit(1);
    });

  const shutdown = () => {
    engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
