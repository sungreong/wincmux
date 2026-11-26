(() => {
  const html = (container, source) => {
    const frame = document.createElement("iframe");
    frame.className = "viewer-media-frame";
    frame.title = "HTML 미리보기";
    frame.setAttribute("sandbox", "");
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:">${source}`;
    container.append(frame);
  };
  const pdf = (container, dataUrl) => {
    const frame = document.createElement("iframe");
    frame.className = "viewer-media-frame";
    frame.title = "PDF 미리보기";
    const encoded = dataUrl.split(",", 2)[1];
    const decoded = atob(encoded);
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    frame.src = url;
    const observer = new MutationObserver(() => {
      if (!frame.isConnected) { URL.revokeObjectURL(url); observer.disconnect(); }
    });
    observer.observe(container, { childList: true });
    container.append(frame);
  };
  const image = (container, dataUrl, alt) => {
    const element = document.createElement("img");
    element.src = dataUrl;
    element.alt = alt;
    container.append(element);
  };
  window.wincmuxViewerMedia = { html, pdf, image };
})();
