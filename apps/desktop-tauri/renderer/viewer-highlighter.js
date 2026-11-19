// Language grammars are bundled with the app and loaded only when a file needs them.
(() => {
  const languageByExtension = {
    py: "python", pyi: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", rs: "rust", go: "go", c: "c", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", rb: "ruby", php: "php", lua: "lua",
    pl: "perl", sh: "bash", zsh: "bash", bash: "bash", ps1: "powershell", sql: "sql", html: "xml", htm: "xml",
    xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", json: "json", jsonc: "json", ipynb: "json",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", md: "markdown", mdx: "markdown", r: "r", dart: "dart",
    ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", scala: "scala", clj: "clojure", cljs: "clojure",
    fs: "fsharp", fsx: "fsharp", jl: "julia", nim: "nim", zig: "zig", vue: "xml", svelte: "xml",
    asm: "x86asm", v: "verilog", vhd: "vhdl", vhdl: "vhdl", groovy: "groovy", gradle: "groovy",
    tf: "hcl", hcl: "hcl", proto: "protobuf", graphql: "graphql", gql: "graphql", dockerfile: "dockerfile"
  };
  const plainExtensions = new Set(["txt", "log", "csv", "tsv", "lock", "pdf", "png", "jpg", "jpeg", "gif"]);
  const pending = new Map();

  function script(path) {
    if (!pending.has(path)) {
      pending.set(path, new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = `./vendor/highlight/${path}`;
        tag.onload = resolve;
        tag.onerror = () => reject(new Error(`Could not load syntax grammar: ${path}`));
        document.head.append(tag);
      }));
    }
    return pending.get(path);
  }

  async function languageFor(path, sample, override) {
    const name = path?.split(/[\\/]/).pop()?.toLowerCase() || "";
    const extension = name.includes(".") ? name.split(".").pop() : "";
    if (!override && plainExtensions.has(extension)) return null;
    await script("highlight.min.js");
    let language = override || languageByExtension[extension] || ({ makefile: "makefile", dockerfile: "dockerfile" })[name] || extension;
    if (language && /^[a-z0-9-]+$/.test(language) && !window.hljs.getLanguage(language)) {
      try { await script(`languages/${language}.min.js`); }
      catch (error) { if (override || languageByExtension[extension]) throw error; language = null; }
    }
    if (language && window.hljs.getLanguage(language)) return language;
    const guess = window.hljs.highlightAuto(sample.slice(0, 8000));
    return guess.relevance >= 5 ? guess.language : null;
  }

  function linesFromMarkup(markup, source) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    const lines = [[]];
    const walk = (node, classes) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parts = node.textContent.split("\n");
        parts.forEach((part, index) => {
          if (index) lines.push([]);
          if (part) lines[lines.length - 1].push({ text: part, classes });
        });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const next = [...classes, ...[...node.classList].filter((name) => name.startsWith("hljs-"))];
        node.childNodes.forEach((child) => walk(child, next));
      }
    };
    template.content.childNodes.forEach((node) => walk(node, []));
    if (lines.map((line) => line.map((token) => token.text).join("")).join("\n") !== source) return null;
    return lines;
  }

  async function highlight(source, path, override) {
    const language = await languageFor(path, source, override);
    if (!language) return { language: null, lines: null };
    const result = window.hljs.highlight(source, { language, ignoreIllegals: true });
    return { language, lines: linesFromMarkup(result.value, source) };
  }

  function paint(code, text, tokens, active) {
    code.replaceChildren();
    let position = 0;
    let activeMark = null;
    const addText = (parent, value, classes) => {
      if (!value) return;
      if (!classes?.length) { parent.append(document.createTextNode(value)); return; }
      const span = document.createElement("span");
      span.className = classes.join(" ");
      span.textContent = value;
      parent.append(span);
    };
    for (const token of tokens || [{ text, classes: [] }]) {
      const end = position + token.text.length;
      if (active && position < active.start + active.length && end > active.start) {
        const before = Math.max(position, active.start);
        const after = Math.min(end, active.start + active.length);
        addText(code, token.text.slice(0, before - position), token.classes);
        if (!activeMark) { activeMark = document.createElement("mark"); code.append(activeMark); }
        addText(activeMark, token.text.slice(before - position, after - position), token.classes);
        addText(code, token.text.slice(after - position), token.classes);
      } else addText(code, token.text, token.classes);
      position = end;
    }
    if (!text) code.textContent = " ";
  }

  window.wincmuxViewerHighlighter = { highlight, paint };
})();
