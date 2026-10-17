/**
 * 极简 Markdown 渲染（无依赖）。返回 { html, codes }，
 * codes 是代码块原文数组，配合 enhanceCodeBlocks 使用。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(text) {
  let out = text;
  // 行内代码优先，先占位避免被其它规则破坏
  const inlineCodes = [];
  out = out.replace(/`([^`]+)`/g, (m, code) => {
    inlineCodes.push(code);
    return `\u0001IC${inlineCodes.length - 1}\u0001`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, href) => {
    const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  out = out.replace(/\u0001IC(\d+)\u0001/g, (m, i) => `<code>${escapeHtml(inlineCodes[Number(i)])}</code>`);
  return out;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(source) {
  const codes = [];
  let text = String(source ?? '');

  // 未闭合的代码围栏补一个结尾，避免流式输出时闪烁
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) text += '\n```';

  text = text.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) => {
    codes.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  const lines = escapeHtml(text).split('\n');
  const out = [];
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[{indent,text}]}
  let quote = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    const items = list.items
      .map((it) => {
        const body = inline(it.text);
        return it.nested ? `<li>${body}</li>` : `<li>${body}</li>`;
      })
      .join('');
    out.push(`<${tag}>${items}</${tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map((q) => inline(q)).join('<br />')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const codeMatch = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      flushAll();
      const idx = Number(codeMatch[1]);
      const block = codes[idx];
      out.push(
        `<div class="code-block" data-code-index="${idx}"><div class="code-head"><span>${escapeHtml(block.lang || 'text')}</span><button type="button" data-copy="${idx}">复制</button></div><pre><code>${escapeHtml(block.code)}</code></pre></div>`
      );
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushAll();
      out.push('<hr />');
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      const thead = `<thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const quoteMatch = line.match(/^&gt;\s?(.*)$/) || line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushPara();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }
    if (quote.length) flushQuote();

    const listMatch = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (listMatch) {
      flushPara();
      const type = /\d/.test(listMatch[2]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push({ indent: listMatch[1].length, text: listMatch[3], nested: listMatch[1].length >= 2 });
      continue;
    }
    if (list) flushList();

    para.push(line);
  }
  flushAll();

  return { html: out.join('\n'), codes };
}

/** 给渲染好的区域里的代码块绑定复制按钮。 */
export function enhanceCodeBlocks(container, codes) {
  container.querySelectorAll('[data-copy]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.copy);
      const code = codes?.[idx]?.code ?? '';
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = '已复制';
        setTimeout(() => {
          btn.textContent = '复制';
        }, 1200);
      } catch {
        btn.textContent = '复制失败';
      }
    });
  });
}

export function markdownToHtml(source) {
  const { html } = renderMarkdown(source);
  return html;
}
