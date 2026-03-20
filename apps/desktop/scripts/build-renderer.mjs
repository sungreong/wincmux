import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd(), "..", "..");
const srcDir = path.resolve("src/renderer");
const outDir = path.resolve("dist/renderer");
fs.mkdirSync(outDir, { recursive: true });

for (const file of [
  "index.html",
  "styles.css",
  "renderer.shared.js",
  "renderer.layout.js",
  "renderer.panes.js",
  "renderer.quickcmd.js",
  "renderer.hidden.js",
  "renderer.js"
]) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

const vendorDir = path.join(outDir, "vendor");
fs.mkdirSync(vendorDir, { recursive: true });

const vendorFiles = [
  {
    from: path.join(projectRoot, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
    to: path.join(vendorDir, "xterm.js")
  },
  {
    from: path.join(projectRoot, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
    to: path.join(vendorDir, "xterm.css")
  },
  {
    from: path.join(projectRoot, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
    to: path.join(vendorDir, "addon-fit.js")
  },
  {
    from: path.join(projectRoot, "node_modules", "@xterm", "addon-unicode11", "lib", "addon-unicode11.js"),
    to: path.join(vendorDir, "addon-unicode11.js")
  }
];

for (const file of vendorFiles) {
  if (!fs.existsSync(file.from)) {
    throw new Error(`Missing vendor file: ${file.from}`);
  }
  fs.copyFileSync(file.from, file.to);
}
