# SmolLM2 model assets

Model source: `onnx-community/SmolLM2-360M-Instruct-ONNX` on Hugging Face.

The actual ONNX weights are packaged as a GitHub Release asset because this repository is a public fork and GitHub rejects new Git LFS uploads to it. Git also rejects ordinary files above 100 MiB.

- Release: https://github.com/ace866678/odysseus.ai/releases/tag/smollm2-360m-onnx-v1
- Expected archive: `smollm2-360m-onnx.zip`
- Included variants: `onnx/model_q4f16.onnx` for WebGPU and `onnx/model_quantized.onnx` for the WASM fallback.
- The browser chat currently downloads model files from Hugging Face and caches them in the browser; the release archive is a repository-hosted copy, not yet the active runtime source.

The download/package workflow is `.github/workflows/download-smollm2.yml`.
