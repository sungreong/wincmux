// Small, safe Markdown preview. All source text is inserted through text nodes.
(() => {
  const element = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  function inline(parent, value) {
    const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(document.createTextNode(value.slice(cursor, match.index)));
      if (match[1]) {
        const code = element("code");
        code.textContent = match[1];
        parent.append(code);
      } else if (match[2]) {
        const link = element("a");
        link.href = match[3];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[2];
        parent.append(link);
      } else {
        const emphasis = element(match[4] ? "strong" : "em");
        emphasis.textContent = match[4] || match[5];
        parent.append(emphasis);
      }
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(value.slice(cursor)));
  }

  const isBlock = (line) => /^(?: {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+\.\s|(?:---+|\*\*\*+|___+)\s*$))/.test(line);
  const cells = (line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

  function render(body, source) {
    const documentView = element("article", "workspace-viewer-markdown");
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      const fence = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/.exec(line);
      if (fence) {
        const content = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) content.push(lines[index++]);
        if (index < lines.length) index += 1;
        const pre = element("pre");
        const code = element("code");
        code.textContent = content.join("\n");
        pre.append(code);
        documentView.append(pre);
        continue;
      }
      const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        const title = element(`h${heading[1].length}`);
        inline(title, heading[2].replace(/\s+#+\s*$/, ""));
        documentView.append(title);
        index += 1;
        continue;
      }
      if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        documentView.append(element("hr"));
        index += 1;
        continue;
      }
      if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
        const table = element("table");
        const head = element("thead");
        const headRow = element("tr");
        for (const cell of cells(line)) { const th = element("th"); inline(th, cell); headRow.append(th); }
        head.append(headRow);
        table.append(head);
        index += 2;
        const tableBody = element("tbody");
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          const row = element("tr");
          for (const cell of cells(lines[index++])) { const td = element("td"); inline(td, cell); row.append(td); }
          tableBody.append(row);
        }
        table.append(tableBody);
        documentView.append(table);
        continue;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        const block = element("blockquote");
        const content = [];
        while (index < lines.length) {
          const next = /^\s*>\s?(.*)$/.exec(lines[index]);
          if (!next) break;
          content.push(next[1]);
          index += 1;
        }
        inline(block, content.join(" "));
        documentView.append(block);
        continue;
      }
      const list = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
      if (list) {
        const ordered = /\d/.test(list[1]);
        const group = element(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const next = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(lines[index]);
          if (!next || /\d/.test(next[1]) !== ordered) break;
          const item = element("li");
          inline(item, next[2]);
          group.append(item);
          index += 1;
        }
        documentView.append(group);
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !isBlock(lines[index]))) paragraph.push(lines[index++].trim());
      const p = element("p");
      inline(p, paragraph.join(" "));
      documentView.append(p);
    }
    body.append(documentView);
  }

  window.wincmuxViewerMarkdown = { render };
})();
