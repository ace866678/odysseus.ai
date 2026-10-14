// static/js/localModel.js
// Runs SmolLM2 inside the user's browser. No model server or API key is required.
// Model weights are fetched from Hugging Face on first use and cached by Transformers.js.
let _pipelinePromise = null;
const MODEL_ID = 'onnx-community/SmolLM2-360M-Instruct-ONNX';

async function loadPipeline(onStatus) {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    onStatus?.('Loading the SmolLM2 runtime…');
    let transformers;
    try {
      transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
    } catch (importError) {
      throw new Error('Failed to load Transformers.js from jsDelivr. Check your internet connection and CSP settings. ' + importError.message);
    }
    const { pipeline, env } = transformers;
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    try {
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
    } catch (_) {}

    const tryLoad = async (device, dtype, label) => {
      onStatus?.(`${label}…`);
      return await pipeline('text-generation', MODEL_ID, {
        device,
        dtype,
        progress_callback: (event) => {
          if (event?.status === 'progress' && Number.isFinite(event.progress)) {
            onStatus?.(`Downloading SmolLM2: ${Math.round(event.progress)}%`);
          } else if (event?.status === 'done') {
            onStatus?.('SmolLM2 files ready; preparing the model…');
          }
        },
      });
    };

    // Try WebGPU first
    if (navigator.gpu) {
      try {
        return await tryLoad('webgpu', 'q4f16', 'Downloading/loading SmolLM2 via WebGPU (about 273 MB, first run only)');
      } catch (gpuError) {
        console.warn('[Odysseus local model] WebGPU load failed; trying CPU/WASM.', gpuError);
        onStatus?.('WebGPU failed; falling back to CPU mode…');
      }
    } else {
      onStatus?.('WebGPU unavailable; using CPU mode. This may download larger model files and run slowly…');
    }

    // Try WASM
    try {
      return await tryLoad('wasm', 'q8', 'Downloading/loading SmolLM2 via CPU/WASM (about 273 MB, first run only)');
    } catch (wasmError) {
      // Provide more specific error messages
      const msg = wasmError?.message || String(wasmError);
      if (msg.includes('Failed to fetch') || msg.includes('network') || msg.includes('CSP')) {
        throw new Error(
          'Failed to download ONNX runtime files from jsDelivr. ' +
          'This is usually caused by Content Security Policy blocking the connection. ' +
          'Try: (1) Refresh the page (Ctrl+Shift+R), (2) Check browser console for CSP errors, ' +
          '(3) Ensure https://cdn.jsdelivr.net is allowed in connect-src and worker-src. ' +
          'Original error: ' + msg
        );
      }
      if (msg.includes('memory') || msg.includes('OOM') || msg.includes('out of memory')) {
        throw new Error('Not enough memory to load the model. Try closing other tabs or using a server-side model instead. Original error: ' + msg);
      }
      throw new Error('SmolLM2 failed to load on this device: ' + msg);
    }
  })().catch((error) => {
    _pipelinePromise = null;
    throw error;
  });
  return _pipelinePromise;
}

export async function generateResponse(history, onStatus) {
  const model = await loadPipeline(onStatus);
  onStatus?.('SmolLM2 is generating a response on this device…');
  const messages = (Array.isArray(history) ? history : [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-12)
    .map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 6000) }));
  const output = await model(messages, {
    max_new_tokens: 192,
    do_sample: true,
    temperature: 0.7,
    repetition_penalty: 1.08,
  });
  const generated = output?.[0]?.generated_text;
  let answer = '';
  if (Array.isArray(generated)) {
    const assistantMessages = generated.filter((item) => item?.role === 'assistant');
    answer = String(assistantMessages[assistantMessages.length - 1]?.content || '');
  } else if (typeof generated === 'string') {
    answer = generated;
  }
  answer = answer.trim();
  if (!answer) throw new Error('No text was generated. This device may not have enough memory for the model.');
  return answer;
}

export default { generateResponse };
