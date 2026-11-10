import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project = new URL("../", import.meta.url);
const renderer = new URL("renderer/", project);
const output = new URL("ui-dist/", project);
const dependencies = new URL("../../node_modules/", project);

await cp(renderer, output, { recursive: true });
await mkdir(new URL("vendor/", output), { recursive: true });
for (const [from, to] of [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-unicode11/lib/addon-unicode11.js", "addon-unicode11.js"]
]) {
  await cp(new URL(from, dependencies), new URL(`vendor/${to}`, output));
}
console.log(`Prepared ${fileURLToPath(output)}`);
