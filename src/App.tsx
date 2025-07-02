import { useState, useEffect } from 'react';
import './App.css';
import { translateEpub } from './translation'; // Import the new function
import Epub from 'epubjs'; // Import Epub.js
// Define the translation modes
type TranslationMode = 'replace' | 'bilingual';

function App() {
  // State for the user inputs
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('openaiApiKey') || '');
  const [epubFile, setEpubFile] = useState<File | null>(null);
  const [chunkSize, setChunkSize] = useState(10);
  const [translationMode, setTranslationMode] = useState<TranslationMode>('replace');
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('openaiBaseUrl') || ''); // New state for base URL
  const [targetLanguage, setTargetLanguage] = useState(() => localStorage.getItem('targetLanguage') || 'Translate this text into English'); // New state for target language
  const [modelName, setModelName] = useState('gpt-4.1-nano'); // New state for model name
  const [status, setStatus] = useState('Ready'); // To display progress
  const [isTranslating, setIsTranslating] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [isDragging, setIsDragging] = useState(false); // New state for drag and drop
  const [isPaused, setIsPaused] = useState(false);
  const [currentProgress, setCurrentProgress] = useState({
    currentFile: '',
    fileIndex: 0,
    totalFiles: 0,
    status: '',
  });
  const [translatedEpubBlob, setTranslatedEpubBlob] = useState<Blob | null>(null);
  const [pauseResolver, setPauseResolver] = useState<(() => void) | null>(null);
  const [currentHtmlContent, setCurrentHtmlContent] = useState<string | null>(null);
  const [originalEpubPreviewReady, setOriginalEpubPreviewReady] = useState(false); // New state to indicate if original EPUB is ready for preview

  // Function to handle previewing the original EPUB
  const handlePreviewEpub = async () => {
    if (!epubFile) {
      setStatus('Error: No EPUB file selected for preview.');
      return;
    }

    setStatus('Loading original EPUB for preview...');
    setOriginalEpubPreviewReady(false); // Hide previous preview
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        if (e.target?.result) {
          const book = Epub(e.target.result as ArrayBuffer);
          const rendition = book.renderTo("original-epub-preview", { 
            width: "100%", 
            height: "100%", 
            spread: "none" 
          });
          setStatus('Original EPUB preview loaded.');
          setOriginalEpubPreviewReady(true); // Show the preview
          await rendition.display();
        }
      };
      reader.readAsArrayBuffer(epubFile);
    } catch (error) {
      setStatus(`Error loading original EPUB for preview: ${error instanceof Error ? error.message : String(error)}`);
      setOriginalEpubPreviewReady(false); // Hide preview on error
    }
  };

  // Modify handleFileChange to clear the preview when a new file is selected
  const handleFileChange = (file: File | null) => { // Modified to accept File directly
    if (file && file.name.endsWith('.epub')) {
      setEpubFile(file);
      setStatus(`File selected: ${file.name}`);
      setOriginalEpubPreviewReady(false); // Clear previous preview
    } else {
      setEpubFile(null);
      setStatus('Error: Please select a valid EPUB file.');
      setOriginalEpubPreviewReady(false); // Clear previous preview
    }
  };

  // Save settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('openaiApiKey', apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem('openaiBaseUrl', baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    localStorage.setItem('targetLanguage', targetLanguage);
  }, [targetLanguage]);

  // Handler for the file input change


  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      handleFileChange(event.dataTransfer.files[0]);
    }
  };

  // Handler for the translation logic
  const handleTranslate = async () => {
    if (!apiKey || !epubFile) {
      setStatus('Error: API key and EPUB file are required.');
      return;
    }
    setIsTranslating(true);
    const controller = new AbortController();
    setAbortController(controller);
    try {
      const newEpubBlob = await translateEpub({
        apiKey,
        epubFile,
        chunkSize,
        translationMode,
        setStatus,
        baseUrl,
        targetLanguage,
        modelName,
        abortSignal: controller,
        onProgress: (progress) => {
          setCurrentProgress({
            currentFile: progress.currentFile,
            fileIndex: progress.fileIndex,
            totalFiles: progress.totalFiles,
            status: progress.status,
          });
          setTranslatedEpubBlob(progress.translatedBlob);
          setCurrentHtmlContent(progress.htmlContent);
        },
        getPausePromise: () => {
          return new Promise<void>((resolve) => {
            setPauseResolver(() => resolve);
            setIsPaused(true);
          });
      },
    });

    // Handle the newEpubBlob after successful translation
    const downloadUrl = URL.createObjectURL(newEpubBlob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `translated-${epubFile?.name || 'epub'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    setStatus('Translation complete!');

  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('Translation cancelled.');
      setTranslatedEpubBlob(null); // Clear on cancellation
      setCurrentHtmlContent(null); // Clear on cancellation
      setIsPaused(false);
      setPauseResolver(null);

    } else {
      setStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setTranslatedEpubBlob(null); // Clear on error
      setCurrentHtmlContent(null); // Clear on error
      setIsPaused(false);
      setPauseResolver(null);
    }
  } finally {
    setIsTranslating(false);
    setAbortController(null);
    setIsPaused(false);
    setPauseResolver(null);
    
    setCurrentProgress({
        currentFile: '',
        fileIndex: 0,
        totalFiles: 0,
        status: '',
      });
  }
  };

  return (
    <>
      <div className="App">
        <header className="App-header">
          <h1>EPUB Translator v 0.1.0-alpha</h1>
          <p>Translate EPUB books using OpenAI</p>
        </header>
        <main className="App-main">

            <div className="settings-column">
              <label htmlFor="api-key">OpenAI API Key</label>
              <input
                id="api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
              <div className="setting-item">
                <label htmlFor="base-url">OpenAI Base URL</label>
                <input
                  id="base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
              <div className="setting-item">
                <label htmlFor="target-language">Target Language Prompt</label>
                <input
                  id="target-language"
                  type="text"
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                  placeholder="Translate this text into English"
                />
              </div>
              <div className="setting-item">
                <label htmlFor="model-name">Model Name</label>
                <input
                  id="model-name"
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="gpt-4.1-nano"
                />
              </div>
              <div className="setting-group">
                <div
                  className={`drag-drop-area ${isDragging ? 'dragging' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('epub-file-input')?.click()}
                >
                  <p>Drag & Drop EPUB file here, or click to select</p>
                  <input
                    id="epub-file-input"
                    type="file"
                    accept=".epub"
                    onChange={(e) => handleFileChange(e.target.files ? e.target.files[0] : null)}
                    style={{ display: 'none' }} // Hide the input, but keep it for click functionality
                  />
                  {epubFile && <p>Selected: {epubFile.name}</p>}
                </div>
                {epubFile && (
                  <button onClick={handlePreviewEpub} disabled={!epubFile}>Preview Original EPUB</button>
                )}
                <div className="setting-item">
                  <label htmlFor="chunk-size">Paragraphs per Request (N)</label>
                  <input
                    id="chunk-size"
                    type="number"
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Number(e.target.value))}
                  />
                </div>
                <div className="setting-item">
                  <label>Translation Mode</label>
                  <div className="radio-group">
                    <label>
                      <input
                        type="radio"
                        name="translation-mode"
                        value="replace"
                        checked={translationMode === 'replace'}
                        onChange={() => setTranslationMode('replace')}
                      />
                      Replacement (Замена)
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="translation-mode"
                        value="bilingual"
                        checked={translationMode === 'bilingual'}
                        onChange={() => setTranslationMode('bilingual')}
                      />
                      Bilingual (Билингв)
                    </label>
                  </div>
                </div>
              </div>
              <div className="actions">
                <button onClick={handleTranslate} disabled={!apiKey || !epubFile || isTranslating || isPaused}>
                  Translate
                </button>
                {isTranslating && !isPaused && (
                  <button onClick={() => setIsPaused(true)}>
                    Pause
                  </button>
                )}
                {isTranslating && isPaused && pauseResolver && (
                  <button onClick={() => {
                    pauseResolver();
                    setPauseResolver(null);
                    setIsPaused(false);
                  }}>
                    Resume
                  </button>
                )}
                <button onClick={() => abortController?.abort()} disabled={!isTranslating || !abortController}>
                  Cancel
                </button>
              </div>
              <div className="status">
                <h2>Status</h2>
                <p>{status}</p>
                {isTranslating && (
                  <p>
                    Translating file {currentProgress.fileIndex} of {currentProgress.totalFiles}:{' '}
                    {currentProgress.currentFile} ({currentProgress.status})
                  </p>
                )}
              </div>
            </div>

            <div className="preview-column">
              {translatedEpubBlob && (
                <div className="translated-epub-download">
                  <h2>Translated EPUB Preview</h2>
                  <p>Download partially translated EPUB:</p>
                  <a
                    href={URL.createObjectURL(translatedEpubBlob)}
                    download={`partially-translated-${epubFile?.name || 'epub'}`}
                  >
                    Download Partial EPUB
                  </a>
                </div>
              )}

              {originalEpubPreviewReady && (
                <div className="original-epub-preview">
                  <h2>Original EPUB Preview</h2>
                  <div id="original-epub-preview" style={{ height: '500px', overflowY: 'scroll', border: '1px solid #ccc' }}></div>
                </div>
              )}

              {currentHtmlContent && (
                <div className="real-time-preview">
                  <h2>Real-time Preview</h2>
                  <div className="preview-content" dangerouslySetInnerHTML={{ __html: currentHtmlContent }} />
                </div>
              )}
            </div>
        </main >
      </div>
    </>
  );
}

export default App;