# Running real CPU/GPU model inference with GitHub Actions

This repository provides a manually triggered workflow at **Actions → CPU/GPU Model Inference → Run workflow**.

## CPU mode

Choose `cpu`. GitHub provisions a temporary hosted Ubuntu runner, installs CPU-only PyTorch and Transformers, downloads `HuggingFaceTB/SmolLM2-135M-Instruct`, and generates a response to `Reply with OK.`. The job summary reports the actual device, hardware details, and generated response.

The repository is public, so standard GitHub-hosted runners are generally free for this workflow. The runner is temporary and is discarded when the job ends.

## GPU mode

Choose `gpu` only after a **real NVIDIA GPU runner** is registered and online for this repository with all of these labels:

- `self-hosted`
- `linux`
- `x64`
- `gpu`

The machine needs a working NVIDIA driver, a compatible CUDA-enabled PyTorch installation path, and internet access to download the model. The job calls `nvidia-smi` and checks `torch.cuda.is_available()`; it fails rather than pretending the CPU is a GPU if CUDA is unavailable.

GitHub's ordinary hosted Ubuntu runners do not expose an NVIDIA GPU. GitHub-hosted GPU larger runners are a paid feature for eligible organization plans. A self-hosted runner uses compute on the machine you register; it is not free cloud GPU hardware provided by GitHub.

**Security note:** self-hosted runners execute repository workflow code. Do not register a valuable personal/work computer as a runner for a public repository unless you understand the risks and have isolated it appropriately. Do not put credentials or production secrets on the runner.

## Both mode

Choose `both` to run the CPU job and the GPU job. The CPU job can finish independently; the GPU job remains queued if no matching GPU runner is online. Start with `cpu` when you have not configured a GPU runner.

## Important limitation

This workflow performs a real, finite inference run for testing. It does **not** turn GitHub Actions into an always-on model server, and it does not route messages from the deployed Odysseus AI website through GitHub. GitHub Actions jobs end after completing their work. Serving live chat traffic requires inference in the browser or a separately hosted, persistent model API.
