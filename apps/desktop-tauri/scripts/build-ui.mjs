import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project = new URL("../", import.meta.url);
const renderer = new URL("renderer/", project);
const output = new URL("ui-dist/", project);
const dependencies = new URL("../../node_modules/", project);

await cp(renderer, output, { recursive: true });
await mkdir(new URL("vendor/", output), { recursive: true });
const highlightAssets = new URL("@highlightjs/cdn-assets/", dependencies);
await mkdir(new URL("vendor/highlight/", output), { recursive: true });
await cp(new URL("highlight.min.js", highlightAssets), new URL("vendor/highlight/highlight.min.js", output));
await cp(new URL("languages/", highlightAssets), new URL("vendor/highlight/languages/", output), { recursive: true });
const languages = (await readdir(new URL("languages/", highlightAssets)))
  .filter((name) => name.endsWith(".min.js"))
  .map((name) => name.slice(0, -7))
  .sort();
await writeFile(new URL("vendor/highlight/languages-list.js", output), `window.wincmuxHighlightLanguages=${JSON.stringify(languages)};\n`);
await cp(new URL("styles/github-dark.min.css", highlightAssets), new URL("vendor/highlight/github-dark.min.css", output));
await cp(new URL("LICENSE", highlightAssets), new URL("vendor/highlight/LICENSE", output));
for (const [from, to] of [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-unicode11/lib/addon-unicode11.js", "addon-unicode11.js"]
]) {
  await cp(new URL(from, dependencies), new URL(`vendor/${to}`, output));
}
console.log(`Prepared ${fileURLToPath(output)}`);
