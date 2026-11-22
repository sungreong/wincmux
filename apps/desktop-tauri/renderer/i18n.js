"use strict";
(() => {
  const catalog = window.wincmuxTranslations;
  const english = new Map();
  const korean = new Map();
  const patterns = [];
  for (const [en, ko] of Object.entries(catalog)) {
    english.set(en, en);
    if (!korean.has(ko)) korean.set(ko, en);
    if (/\{\w+\}/.test(en)) {
      const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const compile = text => new RegExp(`^${escape(text).replace(/\\\{(\w+)\\\}/g, (_, name) => `(?<${name}>${/^(count|page|pages|total|start|end|hidden)$/.test(name) ? "[0-9]+" : ".*?"})`)}$`);
      patterns.push({ en, ko, enRe: compile(en), koRe: compile(ko) });
    }
  }
  const textOriginal = new WeakMap();
  const textRendered = new WeakMap();
  const attrState = new WeakMap();
  const storageKey = "wincmux.ui.language";
  const saved = localStorage.getItem(storageKey);
  let language = saved === "en" || saved === "ko" ? saved : (navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");
  const ignored = "script, style, pre, code, .xterm, [data-i18n-ignore]";

  function translate(source, target = language) {
    if (typeof source !== "string") return source;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(source);
    const value = match[2];
    const direct = target === "ko" ? catalog[value] : korean.get(value);
    if (direct !== undefined) return match[1] + direct + match[3];
    if (target === "ko" && korean.has(value) || target === "en" && english.has(value)) return source;
    for (const pattern of patterns) {
      const found = (target === "ko" ? pattern.enRe : pattern.koRe).exec(value);
      if (found) return match[1] + (target === "ko" ? pattern.ko : pattern.en).replace(/\{(\w+)\}/g, (_, name) => found.groups[name]) + match[3];
    }
    return source;
  }

  const nativeConfirm = window.confirm.bind(window);
  window.confirm = message => nativeConfirm(translate(String(message)));

  function translateText(node) {
    const current = node.nodeValue;
    const previous = textRendered.get(node);
    const original = previous === current ? textOriginal.get(node) : current;
    const next = translate(original);
    textOriginal.set(node, original);
    textRendered.set(node, next);
    if (next !== current) node.nodeValue = next;
  }

  function translateAttribute(element, name) {
    const current = element.getAttribute(name);
    if (current == null) return;
    let state = attrState.get(element);
    if (!state) { state = new Map(); attrState.set(element, state); }
    const previous = state.get(name);
    const original = previous?.rendered === current ? previous.original : current;
    const next = translate(original);
    state.set(name, { original, rendered: next });
    if (next !== current) element.setAttribute(name, next);
  }

  function apply(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement?.closest(ignored)) translateText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(ignored)) return;
    for (const name of ["title", "aria-label", "placeholder"]) translateAttribute(node, name);
    for (const child of node.childNodes) apply(child);
  }

  function setLanguage(next, persist = true) {
    if (next !== "ko" && next !== "en") return;
    language = next;
    document.documentElement.lang = next;
    document.querySelectorAll("[data-ui-language]").forEach(select => { select.value = next; });
    apply(document.documentElement);
    window.dispatchEvent(new CustomEvent("wincmux:languagechange", { detail: next }));
    if (persist) {
      localStorage.setItem(storageKey, next);
      channel?.postMessage(next);
    }
  }

  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("wincmux-ui-language") : null;
  if (channel) channel.onmessage = event => setLanguage(event.data, false);
  window.addEventListener("storage", event => { if (event.key === storageKey) setLanguage(event.newValue, false); });
  document.querySelectorAll("[data-ui-language]").forEach(select => {
    select.addEventListener("change", () => setLanguage(select.value));
  });
  setLanguage(language, false);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest(ignored)) continue;
      if (record.type === "attributes") translateAttribute(record.target, record.attributeName);
      else for (const node of record.addedNodes) apply(node);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder"] });
  window.wincmuxI18n = { get language() { return language; }, t: translate, setLanguage };
})();
