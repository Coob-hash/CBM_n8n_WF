# Baidu Unlimited OCR service

The Compose project runs the official `vllm/vllm-openai:unlimited-ocr` image and this adapter. WF1 posts a base64 PDF to `POST /ocr`; the adapter renders every page, sends it to the model's OpenAI-compatible API and returns ordered page-level Markdown.

The request follows Baidu/vLLM's required serving recipe: the prompt begins with `<image>`, special tokens remain enabled, and the per-request no-repeat window uses `ngram_size=35` and `window_size=128` for each page. This 12 GB GPU deployment uses a 16,384-token server context because pages are processed separately; the request caps OCR output at 8,192 tokens.

Detected figure regions become explicit figure records with `needs_review` uncertainty. Unlimited OCR grounds figures but does not provide the detailed image annotations previously requested from Mistral, so the adapter does not invent descriptions.

The first start downloads the public `baidu/Unlimited-OCR` weights into the `unlimited_ocr_cache` Docker volume. The model server requires an NVIDIA GPU; the official vLLM recipe specifies at least 8 GB VRAM.

Health endpoints:

- `unlimited-ocr:8000/health`: model server
- `unlimited-ocr-adapter:8002/health`: adapter and model readiness

Official references:

- <https://github.com/baidu/Unlimited-OCR>
- <https://recipes.vllm.ai/baidu/Unlimited-OCR>
