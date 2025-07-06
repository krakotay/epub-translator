import * as cheerio from 'cheerio';
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const SYSTEM_PROMPT = "You are a book translator.";

type TranslationMode = 'replace' | 'bilingual';

interface TranslateEpubParams {
  apiKey: string;
  epubFile: File;
  chunkSize: number;
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

// Define the Zod schema for the translation response
const TranslationResponse = z.object({
  translation_paragraphs: z.array(z.string()),
});

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
  const openai = new OpenaiClient.OpenAI({ apiKey, dangerouslyAllowBrowser: true, baseURL: baseUrl || undefined });
  try {
    setStatus('Unpacking EPUB...');

    // Динамический импорт jszip
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

    const spine = $opf('spine > itemref').map((_, el) => {
      const idref = $opf(el).attr('idref');
      return manifest.get(idref || '');
    }).get().filter(Boolean) as string[];



    for (const filePath of spine) {
      setStatus(`Processing: ${filePath}`);
      const fileContent = await zip.file(filePath)?.async('string');

      const $content = cheerio.load(fileContent, { xmlMode: true });
      const paragraphs = $content('p').toArray();
      if (paragraphs.length === 0) continue;

      const chunks = [];
      for (let i = 0; i < paragraphs.length; i += chunkSize) {
        chunks.push(paragraphs.slice(i, i + chunkSize));
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setStatus(`Translating chunk ${i + 1}/${chunks.length} of ${filePath}...`);
        const originalTexts = chunk.map(p => $content(p).text()).join('\n\n').replace(/&#xa0;/g, ' ');

        const userContent = `\`\`\`\n${originalTexts}\n\n\`\`\`\n\n${targetLanguage}`;
        const completion = await openai.chat.completions.parse({
          model: modelName,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent }
          ],
          response_format: zodResponseFormat(TranslationResponse, "translation_paragraphs"),
        }, { signal: abortSignal?.signal }
        );

        const translatedParagraphs = completion.choices[0].message.parsed?.translation_paragraphs || [];

        chunk.forEach((p, j) => {
          const translatedHtml = translatedParagraphs[j] || '';
          if (translationMode === 'replace') {
            $content(p).html(translatedHtml);
          } else { // bilingual
            $content(p).after(`<p class="translated-bilingual">${translatedHtml}</p>`);
          }
        });
      }
      zip.file(filePath, $content.html({ xmlMode: true }));

      // Call onProgress after each file is processed
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
    throw error; // Re-throw the error so App.tsx can catch it
  }
};