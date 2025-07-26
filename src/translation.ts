// translation.ts
import * as cheerio from 'cheerio';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Element as DomElement } from 'domhandler';

const SYSTEM_PROMPT = 'You are a book translator.';

// Главный лимит по символам в одном чанке
const MAX_CHARS_PER_CHUNK = 20000;
// Какие блоки считаем «текстовыми»
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';

export type TranslationMode = 'replace' | 'bilingual';

interface TranslateEpubParams {
  apiKey: string;
  epubFile: File;
  chunkSize: number; // 0 = без лимита по числу абзацев, режем только по символам
  translationMode: TranslationMode;
  setStatus: (status: string) => void;
  baseUrl?: string;
  targetLanguage: string;
  modelName: string;
  abortSignal?: AbortController;
  onProgress?: (progress: {
    currentFile: string;
    fileIndex: number;
    totalFiles: number;
    status: string;
    translatedBlob: Blob | null;
    htmlContent: string | null;
  }) => void;
}

// Схема ответа
const TranslationResponse = z.object({
  translation_paragraphs: z.array(z.string()),
});

// ---------- helpers ----------

// имя тега
function tagName(node: DomElement): string {
  // domhandler Element.name
  // @ts-ignore
  return (node && (node as any).name ? String((node as any).name).toLowerCase() : '').toLowerCase();
}

// выбрать «листовые» блочные узлы (не контейнеры с дочерними блоками)
function selectLeafBlocks($: cheerio.CheerioAPI): DomElement[] {
  const all = $(BLOCK_SELECTOR).toArray() as DomElement[];
  const leaves = all.filter((el) => {
    const cls = $(el).attr('class') || '';
    if (/\btranslated-bilingual\b/.test(cls)) return false; // не трогаем уже вставленные
    // если внутри есть другие блок‑элементы — это контейнер, пропускаем
    return $(el).find(BLOCK_SELECTOR).length === 0;
  });
  return leaves;
}

// нормализовать текст, чтобы собирать чанки по символам честно
function normalizeText(s: string): string {
  return s.replace(/\u00A0|&nbsp;|&#xa0;/g, ' ').replace(/\s+\n/g, '\n').trim();
}

// вычистить блочные теги на случай, если модель всё же прислала HTML
function stripBlockTags(html: string): string {
  return html
    .replace(/<\/?(p|div|h[1-6]|li|blockquote|ul|ol)>/gi, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

// вставка «билингв»: аккуратно, учитывая тип узла
function insertBilingual($: cheerio.CheerioAPI, node: DomElement, translated: string) {
  const t = tagName(node);
  const safe = stripBlockTags(translated);
  if (t === 'li') {
    // внутри li, чтобы не ломать структуру списка/нумерацию
    $(node).append(`<div class="translated-bilingual">${safe}</div>`);
  } else if (t === 'blockquote') {
    // внутрь цитаты, чтобы сохранить вертикальную линию/оформление
    $(node).append(`<p class="translated-bilingual">${safe}</p>`);
  } else if (/^h[1-6]$/.test(t)) {
    // после заголовка отдельным блоком
    $(node).after(`<div class="translated-bilingual">${safe}</div>`);
  } else {
    // обычный параграф — соседний <p>
    $(node).after(`<p class="translated-bilingual">${safe}</p>`);
  }
}

// замена содержимого узла переводом (safe)
function replaceBlock($: cheerio.CheerioAPI, node: DomElement, translated: string) {
  const safe = stripBlockTags(translated);
  $(node).html(safe);
}

// ---------- main ----------

export const translateEpub = async ({
  apiKey,
  epubFile,
  chunkSize,
  translationMode,
  setStatus,
  baseUrl,
  targetLanguage,
  modelName,
  abortSignal,
  onProgress,
}: TranslateEpubParams): Promise<Blob> => {
  setStatus('Initializing...');
  const OpenaiClient = await import('openai');
  const openai = new OpenaiClient.OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true,
    baseURL: baseUrl || undefined,
  });

  try {
    setStatus('Unpacking EPUB...');
    const JSZip = await import('jszip');
    const zip = await JSZip.loadAsync(epubFile);

    const containerFile = await zip.file('META-INF/container.xml')?.async('string');
    if (!containerFile) throw new Error('META-INF/container.xml not found.');
    const $container = cheerio.load(containerFile, { xmlMode: true });
    const opfFilePath = $container('rootfile').attr('full-path');
    if (!opfFilePath) throw new Error('OPF file path not found in container.xml.');

    const opfFile = await zip.file(opfFilePath)?.async('string');
    if (!opfFile) throw new Error(`OPF file not found: ${opfFilePath}`);
    const $opf = cheerio.load(opfFile, { xmlMode: true });

    const manifest = new Map<string, string>();
    const opfDir = opfFilePath.includes('/') ? opfFilePath.substring(0, opfFilePath.lastIndexOf('/')) : '';

    $opf('manifest > item').each((_, el) => {
      const id = $opf(el).attr('id');
      const href = $opf(el).attr('href');
      if (id && href) {
        const fullPath = opfDir ? `${opfDir}/${href}` : href;
        manifest.set(id, fullPath);
      }
    });

    const spine = $opf('spine > itemref')
      .map((_, el) => {
        const idref = $opf(el).attr('idref');
        return manifest.get(idref || '');
      })
      .get()
      .filter(Boolean) as string[];

    for (const filePath of spine) {
      setStatus(`Processing: ${filePath}`);
      const fileContent = await zip.file(filePath)?.async('string');
      if (!fileContent) continue;

      const $content = cheerio.load(fileContent, { xmlMode: true });

      // 1) берём только листовые блок‑элементы
      const leafNodes = selectLeafBlocks($content);
      if (leafNodes.length === 0) continue;

      // 2) текст каждого блока
      const leafTexts = leafNodes.map((n) => normalizeText($content(n).text()));

      // 3) отбрасываем совсем пустые
      const filtered: { node: DomElement; text: string }[] = [];
      for (let i = 0; i < leafNodes.length; i++) {
        if (leafTexts[i].length > 0) filtered.push({ node: leafNodes[i], text: leafTexts[i] });
      }
      if (filtered.length === 0) continue;

      // 4) чанкование: главный лимит — по символам; лимит по числу абзацев — только если > 0
      type Chunk = { nodes: DomElement[]; texts: string[]; charCount: number };
      const MAX_PARAS_PER_CHUNK =
        Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : Number.POSITIVE_INFINITY;

      const chunks: Chunk[] = [];
      let cur: Chunk = { nodes: [], texts: [], charCount: 0 };

      for (let i = 0; i < filtered.length; i++) {
        const { node, text } = filtered[i];
        const willExceedByChars =
          cur.charCount > 0 && cur.charCount + text.length + 2 > MAX_CHARS_PER_CHUNK;
        const willExceedByCount = cur.nodes.length >= MAX_PARAS_PER_CHUNK;

        if ((willExceedByChars || willExceedByCount) && cur.nodes.length > 0) {
          console.log('PUSH CHUNK', { filePath, charCount: cur.charCount, paraCount: cur.nodes.length });
          chunks.push(cur);
          cur = { nodes: [], texts: [], charCount: 0 };
        }

        cur.nodes.push(node);
        cur.texts.push(text);
        cur.charCount += text.length + 2;

        if (cur.charCount >= MAX_CHARS_PER_CHUNK) {
          console.log('PUSH CHUNK (oversize)', { filePath, charCount: cur.charCount, paraCount: cur.nodes.length });
          chunks.push(cur);
          cur = { nodes: [], texts: [], charCount: 0 };
        }
      }
      if (cur.nodes.length > 0) {
        console.log('PUSH CHUNK (tail)', { filePath, charCount: cur.charCount, paraCount: cur.nodes.length });
        chunks.push(cur);
      }

      // 5) перевод чанков с контекстом (пред/след)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setStatus(`Translating chunk ${i + 1}/${chunks.length} of ${filePath}...`);

        const originalTexts = chunk.texts.join('\n\n');
        const prevTexts = i > 0 ? chunks[i - 1].texts.join('\n\n') : '';
        const nextTexts = i < chunks.length - 1 ? chunks[i + 1].texts.join('\n\n') : '';
        const contextTexts = [prevTexts, nextTexts].filter(Boolean).join('\n\n');

        const contextContent = contextTexts
          ? `This is context:\n\`\`\`\n${contextTexts}\n\`\`\`\n\nTranslate following text`
          : '';

        console.log('TRANSLATE CHUNK', {
          filePath,
          i,
          of: chunks.length,
          charCount: originalTexts.length,
          paraCount: chunk.texts.length,
        });

        // Жёстко просим простой текст без HTML
        const userContent =
          `Return JSON that matches the schema and make sure "translation_paragraphs" has exactly ${chunk.texts.length} items (one per input paragraph, keep order). ` +
          `Each item MUST be plain text without any HTML tags. ` +
          `\n\`\`\`\n${originalTexts}\n\`\`\`\n\n${targetLanguage}\n\n`;

        const messages: Array<{ role: 'system' | 'user'; content: string }> = [
          { role: 'system', content: SYSTEM_PROMPT },
        ];
        if (contextContent) messages.push({ role: 'user', content: contextContent });
        messages.push({ role: 'user', content: userContent });

        const completion = await openai.chat.completions.parse(
          {
            model: modelName,
            messages,
            response_format: zodResponseFormat(TranslationResponse, 'translation_paragraphs'),
          },
          { signal: abortSignal?.signal }
        );

        const translatedParagraphs =
          completion.choices[0].message.parsed?.translation_paragraphs || [];

        // 6) применяем перевод
        chunk.nodes.forEach((node, j) => {
          const t = translatedParagraphs[j] ?? '';
          if (translationMode === 'replace') {
            replaceBlock($content, node, t);
          } else {
            insertBilingual($content, node, t);
          }
        });
      }

      // 7) сохраняем файл обратно
      zip.file(filePath, $content.html({ xmlMode: true }) || '');

      // прогресс
      if (onProgress) {
        const currentEpubBlob = await zip.generateAsync({ type: 'blob' });
        onProgress({
          currentFile: filePath,
          fileIndex: spine.indexOf(filePath) + 1,
          totalFiles: spine.length,
          status: `Processed ${filePath}`,
          translatedBlob: currentEpubBlob,
          htmlContent: $content('body').html(),
        });
      }
    }

    const newEpubBlob = await zip.generateAsync({ type: 'blob' });
    return newEpubBlob;
  } catch (error) {
    console.error('Error during translation:', error);
    throw error;
  }
};
