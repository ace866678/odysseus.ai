#!/usr/bin/env python3
"""Run a real SmolLM2 inference pass on the selected compute device."""

from __future__ import annotations

import argparse
import os
import platform
from pathlib import Path

MODEL_ID = os.environ.get("ODYSSEUS_INFERENCE_MODEL", "HuggingFaceTB/SmolLM2-135M-Instruct")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "cuda"), required=True)
    args = parser.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit(
                "CUDA was requested but PyTorch cannot see an NVIDIA GPU. "
                "Check the runner's NVIDIA driver, CUDA-enabled PyTorch, and GPU labels."
            )
        device = torch.device("cuda")
        device_name = torch.cuda.get_device_name(0)
        dtype = torch.float16
    else:
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        device = torch.device("cpu")
        device_name = platform.processor() or platform.machine() or "CPU"
        dtype = torch.float32

    print(f"Model: {MODEL_ID}")
    print(f"Requested device: {args.device}")
    print(f"Actual device: {device}")
    print(f"Hardware: {device_name}")
    print(f"PyTorch: {torch.__version__}")
    if args.device == "cuda":
        print(f"CUDA runtime reported by PyTorch: {torch.version.cuda}")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
    ).to(device)
    model.eval()

    messages = [{"role": "user", "content": "Reply with OK."}]
    try:
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    except (AttributeError, TypeError, ValueError):
        prompt = "User: Reply with OK.\nAssistant:"

    encoded = tokenizer(prompt, return_tensors="pt")
    encoded = {name: tensor.to(device) for name, tensor in encoded.items()}

    with torch.inference_mode():
        generated = model.generate(
            **encoded,
            max_new_tokens=24,
            do_sample=False,
            use_cache=True,
            pad_token_id=tokenizer.eos_token_id,
        )

    input_length = encoded["input_ids"].shape[1]
    new_tokens = generated[0, input_length:].detach().cpu()
    response = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    if not response:
        raise SystemExit("Inference completed but generated an empty response.")

    result = (
        "## Odysseus AI model inference\n\n"
        f"- **Model:** `{MODEL_ID}`\n"
        f"- **Requested device:** `{args.device}`\n"
        f"- **Actual device:** `{device}`\n"
        f"- **Hardware:** {device_name}\n"
        f"- **PyTorch:** `{torch.__version__}`\n"
        f"- **Prompt:** Reply with OK.\n"
        f"- **Model response:** {response}\n"
    )
    print("\n" + result)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as summary:
            summary.write(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
