// static/js/localModel.js
// Runs SmolLM2 inside the user's browser. No model server or API key is required.
// Model weights are fetched from Hugging Face on first use and cached by Transformers.js.
let _pipelinePromise = null;
const MODEL_ID = 'onnx-community/SmolLM2-360M-Instruct-ONNX';

async function loadPipeline(onStatus) {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    onStatus?.('Loading the SmolLM2 runtime…');
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    try {
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;
    } catch (_) {}

    if (navigator.gpu) {
      try {
        onStatus?.('Downloading/loading SmolLM2 (about 273 MB, first run only)…');
        return await pipeline('text-generation', MODEL_ID, {
          device: 'webgpu',
          dtype: 'q4f16',
          progress_callback: (event) => {
            if (event?.status === 'progress' && Number.isFinite(event.progress)) {
              onStatus?.('Downloading SmolLM2: ' + Math.round(event.progress) + '%');
            } else if (event?.status === 'done') {
              onStatus?.('SmolLM2 files ready; preparing the model…');
            }
          },
        });
      } catch (gpuError) {
        console.warn('[Odysseus local model] WebGPU load failed; trying CPU/WASM.', gpuError);
      }
    }

    onStatus?.('WebGPU unavailable; trying CPU mode. This may download larger model files and run slowly…');
    return await pipeline('text-generation', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event) => {
        if (event?.status === 'progress' && Number.isFinite(event.progress)) {
          onStatus?.('Downloading SmolLM2: ' + Math.round(event.progress) + '%');
        } else if (event?.status === 'done') {
          onStatus?.('SmolLM2 files ready; preparing the model…');
        }
      },
    });
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
