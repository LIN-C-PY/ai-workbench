export const TARGET_LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Русский', 'Español'];

export function translationPrompt(text, targetLang = '简体中文') {
  return [
    `把下面这段内容翻译成${targetLang}。`,
    '要求：只输出译文，不要任何解释、不要加引号、不要写「译文：」之类的开头。',
    '保留原有的 Markdown 结构、代码块内容、命令行、文件路径、URL 和专有名词（代码和命令不用翻译，注释可以翻译）。',
    '',
    '--- 原文开始 ---',
    text,
    '--- 原文结束 ---'
  ].join('\n');
}

/** 模型有时会加一层壳，这里剥掉 */
export function cleanTranslation(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```(?:\w+)?\s*\n([\s\S]*?)\n?```$/, '$1').trim();
  text = text.replace(/^(译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 2) ||
    (text.startsWith('“') && text.endsWith('”') && text.length > 2)
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** 一句话概括用于日志 */
export function shortPreview(text, len = 40) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > len ? `${flat.slice(0, len)}…` : flat;
}
