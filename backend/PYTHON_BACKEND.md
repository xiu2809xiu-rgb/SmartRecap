# Python backend (active local integration)

The merged React UI now uses this FastAPI backend by default. The JavaScript/AWS backend from `main` remains in `backend/src` for reference/deployment work, but Vite proxies `/api` to FastAPI on port 8000.

## Run on Windows

From the repository root, use two terminals:

```powershell
backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

```powershell
npm run dev
```

Open the Vite URL, choose **Continue as guest**, then upload a supported file.

## Processing behavior

- Cram mode extracts native text first and uses RapidOCR for scanned pages, with PaddleOCR as a quality fallback.
- Deep revision uses PaddleOCR first, but only for genuinely scanned/low-text PDF pages and embedded images.
- Expensive OCR is capped at 24 evenly sampled pages/images with a two-minute per-file budget; text-native PDFs remain fast.
- OCR uses native extraction first, then RapidOCR/PaddleOCR only for scanned pages.
- Gemini 2.5 Flash converts extracted text into polished, source-cited notes and filters cover-page/UI/OCR noise.
- Azure `gpt-5.6-sol` answers notebook chat questions; the personal OpenAI provider is a secondary chat fallback.
- Azure Content Understanding remains optional and requires its own `*.services.ai.azure.com` endpoint/key; an Azure OpenAI endpoint is not a Content Understanding endpoint.
- The local compatibility store is in memory, so materials reset when FastAPI restarts.

`backend/.env` is ignored by Git. Never commit its API key.
