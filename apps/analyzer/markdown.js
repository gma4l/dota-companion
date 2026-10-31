"use strict";
/**
 * Мини-разметка для ответов модели: заголовки, списки, жирный, код.
 * Без внешних зависимостей и без innerHTML из неэкранированного текста.
 */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  const html = [];
  let list = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      closeList();
      continue;
    }

    let m;
    if ((m = line.match(/^\s*#{1,4}\s+(.*)$/))) {
      closeList();
      html.push(`<h4>${inlineMd(m[1])}</h4>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inlineMd(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inlineMd(m[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inlineMd(line)}</p>`);
  }

  closeList();
  return html.join("");
}
