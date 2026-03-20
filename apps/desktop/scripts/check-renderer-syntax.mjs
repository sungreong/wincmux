import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const rendererDir = path.resolve("src/renderer");
const orderedFiles = [
  "renderer.shared.js",
  "renderer.layout.js",
  "renderer.panes.js",
  "renderer.quickcmd.js",
  "renderer.hidden.js",
  "renderer.js"
];
const MAX_RENDERER_LINES = 800;

function readFile(name) {
  const fullPath = path.join(rendererDir, name);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing renderer file: ${name}`);
  }
  return fs.readFileSync(fullPath, "utf8");
}

let hasFailure = false;
const sources = new Map();

for (const name of orderedFiles) {
  const source = readFile(name);
  sources.set(name, source);
  const lineCount = source.split(/\r?\n/).length;
  if (lineCount > MAX_RENDERER_LINES) {
    console.warn(`[warn] line count: ${name} -> ${lineCount} (limit=${MAX_RENDERER_LINES})`);
  } else {
    console.log(`[ok] line count: ${name} (${lineCount})`);
  }
  try {
    new vm.Script(source, { filename: name });
    console.log(`[ok] syntax: ${name}`);
  } catch (err) {
    hasFailure = true;
    console.error(`[fail] syntax: ${name}`);
    console.error(err instanceof Error ? err.message : String(err));
  }
}

try {
  const combinedSource = orderedFiles.map((name) => sources.get(name) ?? "").join("\n;\n");
  new vm.Script(combinedSource, { filename: "renderer.global-scope.check.js" });
  console.log("[ok] combined global scope parse");
} catch (err) {
  hasFailure = true;
  console.error("[fail] combined global scope parse");
  console.error(err instanceof Error ? err.message : String(err));
}

const criticalGlobalConsts = [
  "QUICK_PARAM_HINTS"
];

for (const constName of criticalGlobalConsts) {
  const hits = [];
  const pattern = new RegExp(`\\bconst\\s+${constName}\\b`, "g");
  for (const [name, source] of sources.entries()) {
    if (pattern.test(source)) {
      hits.push(name);
    }
  }
  if (hits.length > 1) {
    hasFailure = true;
    console.error(`[fail] duplicate critical const: ${constName}`);
    console.error(`  found in: ${hits.join(", ")}`);
  } else if (hits.length === 1) {
    console.log(`[ok] unique critical const: ${constName}`);
  } else {
    hasFailure = true;
    console.error(`[fail] missing critical const: ${constName}`);
  }
}

if (hasFailure) {
  process.exitCode = 1;
} else {
  console.log("Renderer syntax checks passed.");
}
