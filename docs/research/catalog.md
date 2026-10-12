# Model catalog for Vast clock-in: verified choices and risks

Verified 2026-10-12. The machine-readable catalog is `catalog.json`, next to this file. It is an array of `CatalogModel` (`src/shared/types.ts`), with `verifiedAt = "2026-10-12"`.

**Verification method**, per entry:

1. **Files exist, with exact byte sizes.** Checked against the Hugging Face API, `POST https://huggingface.co/api/models/<repo>/paths-info/main`. The generator script used it to fill `sizeGb`. Tree listings came from `GET /api/models/<repo>/tree/main?recursive=true`.
2. **Architecture, embedded MTP and per-tensor size.** I parsed the **GGUF headers** remotely with HTTP Range requests (no full download). Per-tensor bytes were computed from tensor offsets. This showed:
   - the architecture string (`qwen35`, `qwen4exp`, `glm5-next`);
   - `block_count` and `*.nextn_predict_layers` (embedded MTP);
   - how many bytes of the Flash-Next n-gram embedding table are read lazily from disk.
3. **Not a copy.** For uncensored repos built from another publisher's quant recipe, I compared the LFS sha256 of each shard with the original. This proves the weights differ and the repo is not a re-upload.
4. **Gating.** `gated` and `private` checked via `GET /api/models/<repo>`. Every chosen repo is `gated: false`, so it downloads anonymously.
5. **llama.cpp support.** Checked on ggml-org/llama.cpp master, `src/llama-arch.cpp`, `src/models/*.cpp`, commit history and open issues. The recommended image build is **b11561**.

---------------------------------------------------------------------------------------------------------------------

## 1. Catalog at a glance

| id | profile | variant | repo | download (GB) | ctx | MTP | vision | experimental |
|---|---|---|---|---|---|---|---|---|
| `qwen38-27b-uncensored-hauhau-q5kp` | **light (default)** | uncensored | HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF | 21.15 | 131072 | embedded, n-max 2 | yes | no |
| `qwen38-27b-uncensored-heretic-ara-q5km` | light | uncensored | mradermacher/Qwen3.8-27B-heretic-ara-GGUF | 20.46 | 131072 | embedded | yes | no |
| `qwen38-27b-standard-unsloth-q5kxl` | light | standard | unsloth/Qwen3.8-27B-GGUF | 21.81 | 131072 | embedded | yes | no |
| `qwen38-flash-next-uncensored-huihui-v2-q4kxl` | **standard (default)** | uncensored | huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF | 111.33 | 131072 | none | no | **yes** |
| `qwen38-flash-next-standard-ggml-iq4nl` | standard | standard | ggml-org/Qwen3.8-Flash-Next-GGUF | 106.19 | 131072 | separate head (`-md`) | no | **yes** |
| `qwen38-27b-uncensored-hauhau-q8kp` | standard (fallback) | uncensored | HauhauCS/…-MTP-GGUF | 32.39 | 262144 | embedded | yes | no |
| `qwen38-27b-standard-unsloth-q8` | standard (fallback) | standard | unsloth/Qwen3.8-27B-GGUF | 29.98 | 262144 | embedded | yes | no |
| `glm53-flash-uncensored-huihui-iq4xs` | **max (default)** | uncensored | huihui-ai/Huihui-GLM-5.3-Flash-abliterated-GGUF | 157.99 | 131072 | off (multi-GPU) | yes | **yes** |
| `glm53-flash-standard-unsloth-iq4xs` | max | standard | unsloth/GLM-5.3-Flash-GGUF | 157.99 | 131072 | off | yes | **yes** |
| `test-qwen35-0.8b-q8` | any (smoke test) | standard | unsloth/Qwen3.5-0.8B-GGUF | 0.81 | 32768 | n/a | no | no |
| `test-qwen35-2b-uncensored-hauhau-q4km` | any (smoke test) | uncensored | HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive | 1.27 | 32768 | n/a | no | no |

### Field conventions

These are additive interpretations of `CatalogModel`. The contract itself is unchanged.

- **`files[0]` is what goes to `-m`.** For split GGUFs, `files` lists the parts in order; llama.cpp loads the remaining `-0000N-of-0000M` parts automatically from the same directory. **Extra non-split files may follow the split parts.** Example: the ggml-org Flash-Next entry lists its MTP draft head as `files[2]`. They are downloaded but not passed to `-m`.
- **`{modelDir}` placeholder in `llamaArgs`.** The bootstrap must replace it with the local directory the repo files were downloaded into, e.g. `/root/oc/models/<catalogId>`. `hf download --local-dir` keeps repo-relative sub-paths such as `unsloth-UD-Q4_K_XL/…`, so the local path of every file is `{modelDir}/<file path as listed>`.
- **`sizeGb`** is the total download in decimal GB: all `files` plus `mmproj`. Use it for disk checks and download progress.
- **`minTotalVramGb`** is the total VRAM across all GPUs the entry needs at the catalog `contextLength`.
- **`llamaArgs`** are appended after the bootstrap's base args: `-m <files[0]> --host 127.0.0.1 --port 8080 --api-key … --alias <id> -ngl 99 -c <contextLength> --jinja --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 [--mmproj <mmproj>]`.
- **`experimental: true`** means upstream llama.cpp supports the architecture, but support is young and has open crash issues (§5). The UI should show a badge. The GPU pipeline should **fall back** to the profile's non-experimental model if the server does not reach `/health` = 200 (§6).

---------------------------------------------------------------------------------------------------------------------

## 2. light: 1× RTX 5090 (32 GB; Vast `gpu_ram` 32607 MiB = 31.8 GiB) → Qwen3.8-27B

### 2.1 Model facts

`Qwen/Qwen3.8-27B` `config.json`:
- `Qwen3_5ForConditionalGeneration`, `model_type: qwen3_5`, 64 layers.
- 48 Gated-DeltaNet (linear) layers and 16 full-attention layers. Full attention uses 4 KV heads × head_dim 256.
- `mtp_num_hidden_layers: 1`, max position 262144, vision tower included.

llama.cpp maps it to arch **`qwen35`**, supported since 2026-02 (PR #19468), with MTP.

### 2.2 Candidates checked

| Repo | Result |
|---|---|
| `heretic-org/Qwen3.8-27B-heretic-ara` | **safetensors only, no GGUF** (tree: 6 shards + `model-auxiliary.safetensors`). GGUF conversions exist: **`mradermacher/Qwen3.8-27B-heretic-ara-GGUF`** (static quants Q2_K…Q8_0, mmproj f16/Q8_0) → included. Also `mradermacher/…-i1-GGUF`, `CorVous/…`, `MoeTheGreat/…-Q6_K-GGUF` |
| `HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF` | Exists, apache-2.0, not gated, 2.2 M downloads. Quants: Q2_K_P…Q8_K_P, IQ2_M, IQ3_XS/M, IQ4_XS, mmproj BF16, plus a "FastMTP-32K" sidecar. **No Balanced variant exists for Qwen3.8** (HauhauCS only has Balanced for Qwen3.6-27B) |
| `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` | Exists, many quants (Q4_K 16.81, Q5_K 19.54, Q6_K 22.43, Q8_0 29.05 GB …), `mmproj-model-bf16.gguf`. Viable alternative; not added to keep the picker short |
| `unsloth/Qwen3.8-27B-GGUF` | Standard. UD-Q5_K_XL 20.88, UD-Q6_K 21.98, Q8_0 29.05 GB, `mmproj-BF16.gguf` 0.93 GB, separate `MTP/mtp-Qwen3.8-27B-Q4_0.gguf` (not needed; see below) |
| `ggml-org/Qwen3.8-27B-GGUF` | Standard alternative: Q4_K_M 18.97, Q8_0 28.60, mtp-*.gguf, dflash-*.gguf |
| `orcarouter/Qwen3.8-27B-Uncensored-GGUF` | **`gated: "auto"`**: anonymous downloads get HTTP 401. Excluded unless the user adds an HF token |

**Embedded MTP verified in every chosen file.** Each GGUF header shows `qwen35.block_count = 65`, `qwen35.nextn_predict_layers = 1` and 4 `blk.64.nextn.*` tensors. That holds for HauhauCS Q5_K_P/Q8_K_P, mradermacher heretic Q5_K_M, unsloth UD-Q5_K_XL/Q8_0, huihui Q5_K and llmfan46 Q5_K_M. So **`--spec-type draft-mtp` works with no extra file.** HauhauCS reports embedded MTP at depth 2 gives **2.23× document / 1.60× reasoning TG** on an RTX PRO 6000. That is why `--spec-draft-n-max 2` is used.

The HauhauCS "FastMTP" sidecar needs a **patched llama.cpp build** (their `.patch` against commit `4df29be4`), so it is **not used**. Their model card also uses `--no-mmap`, which no longer exists upstream (§5).

### 2.3 Why Q5 class, and the VRAM budget

KV cache for 16 full-attention layers: 2 × 4 × 256 = 32768 elements per token. At q8_0 (34 B per 32 elements) that is 34,816 B/token, so **131072 ctx = 4.25 GiB** (f16 would be 8.0 GiB).

| Item | Q5_K_P (chosen) | Q6_K_P (rejected) |
|---|---|---|
| weights | 18.83 GiB | 24.14 GiB |
| KV 131072 q8_0 | 4.25 | 4.25 |
| MTP draft KV (1 attn layer) | ~0.27 | ~0.27 |
| recurrent state (48 GDN layers × 48 heads × 128² × fp32) | ~0.15 per slot | ~0.15 |
| mmproj BF16 | 0.87 | 0.87 |
| compute buffers (248k vocab) | ~1.5–2.5 | ~1.5–2.5 |
| **total** | **≈ 26–27 GiB of 31.8** | ≈ 31–32 GiB: no headroom |

Q6_K_P only fits at about 64k ctx, or with `--no-mmproj-offload`. Q5_K_P / Q5_K_M / UD-Q5_K_XL are the right class for 128k. These numbers are **estimates**: run `llama-server --fit` diagnostics or check the startup log on the first live run.

---------------------------------------------------------------------------------------------------------------------

## 3. standard: 1× RTX PRO 6000 (97887 MiB = 95.6 GiB) → Qwen3.8-Flash-Next, with a Qwen3.8-27B Q8 fallback

### 3.1 Model facts

`Qwen/Qwen3.8-Flash-Next` `config.json` and model card:
- `Qwen4ExpForConditionalGeneration`, `model_type: qwen4_exp`.
- 125B MoE (512 experts, top-10), 6B active, 48 layers in a 3:1 Gated-DeltaNet : Qwen-Sparse-Attention layout.
- **51B-parameter n-gram embedding** (`ngram_size 3`, PLE at layer 2) and 1 MTP layer.
- 262144 native context. Vision included.

### 3.2 llama.cpp support: YES, upstream

- Arch **`qwen4exp`**, added in **PR #27742 (2026-08-27)**. 28 follow-up commits since, including:
  - **MTP (#29761, 2026-10-01)**
  - sparse-FA CUDA (#28770)
  - `-sm tensor` (#28569)
  - recurrent rollback (#28123)
- The n-gram table is the tensor `per_layer_token_embd.weight [160, 320001536]`. It is loaded with `TENSOR_READ_LAZY`, and the new **`--lazy-mode`** flag defaults to `auto`, meaning lazy for tensors larger than 4 GiB. Rows are read from disk on demand through **mmap**.
- **No special flag is needed**, but you **must not disable mmap**. That rules out `--load-mode none`; `--no-mmap` no longer exists. Unsloth's guide likewise says to "offload the PLE/N-gram layers to SSD and use mmap".

Measured split of the chosen files (offset-derived tensor bytes):

| File set | total | n-gram PLE (lazy, stays on disk / page cache) | **VRAM-resident weights** |
|---|---|---|---|
| huihui v2 `unsloth-UD-Q4_K_XL` (4 shards) | 111.32 GB | 28.84 GB (IQ4_NL) | **82.48 GB = 76.8 GiB** |
| ggml-org `IQ4_NL` (2 shards) | 102.04 GB | 28.82 GB (Q4_0) | **73.22 GB = 68.2 GiB** (+ MTP head 4.13 GB) |
| unsloth `UD-IQ4_XS` | 93.67 GB | 28.84 GB | 64.83 GB (lower quality; not chosen) |
| unsloth `UD-Q5_K_XL` | 158.29 GB | ~54 GB (Q8_0) | ~104 GB: **does not fit** |

KV at 131072 ctx is small: 12 attention layers × 2 × 2 KV heads × 256 at q8_0 ≈ 1.6 GiB, plus a QSA indexer cache of a few hundred MiB (#30005). **Estimated total: about 82–84 GiB (huihui) or 77–79 GiB (ggml-org) of 95.6 GiB.**

Host RAM: the PLE table (~29 GB) lives in page cache, so ask for `cpu_ram ≥ 64 GB`. Every RTX PRO 6000 offer seen had ≥ 96 GB. Disk: ≥ 200 GB, which covers the model, the 3.6 GB image and an optional fallback download.

### 3.3 Repos checked

| Repo | Result |
|---|---|
| `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF` (v1) | Exists. `BF16/`, `Q8_0/`, `unsloth-UD-IQ4_XS/`, `unsloth-UD-Q4_K_XL/`, `swift-IQ2_XS/`, `swift-IQ3_XXS/`, mmproj ×3. Shards 2–4 of UD-Q4_K_XL **differ by sha256** from unsloth's (real abliterated weights); shard 1 is identical, being metadata only |
| `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF` (**chosen**) | Created 2026-10-11. `unsloth-UD-IQ4_XS/`, `unsloth-UD-Q4_K_XL/`, `mmproj-Qwen3.8-Flash-Next-BF16.gguf`. Shards differ from both unsloth and v1. huihui: "none of the experts have been ablated. Suitable for novel writing and programming". **Risk:** very new (298 downloads). v1 is the fallback, with the same paths under `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF` |
| `orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF` | **`gated: "auto"` → HTTP 401 anonymously.** Q4_K_S 111.77, Q4_K_M 119.15 GB, has an MTP draft. Excluded unless an HF token is configured |
| `unsloth/Qwen3.8-Flash-Next-GGUF` | Standard. UD-Q4_K_XL (4 shards, 111.33 GB), UD-IQ4_XS, …, `MTP/mtp-…-{Q4_K_M,Q8_0,BF16}.gguf` and `MTP/mtp-…-shared-*.gguf`. **Its MTP heads hit `GGML_ASSERT(buffer)` at startup (llama.cpp #29811, open; reproduced on CUDA, ROCm and Vulkan)**, so they are not used |
| `ggml-org/Qwen3.8-Flash-Next-GGUF` (**chosen for standard**) | IQ4_NL (2 shards, 102.05 GB), Q8_0 (162.6 GB), `mtp-Qwen3.8-Flash-Next-{Q4_0,Q8_0,BF16}.gguf`, mmproj Q8_0. Several #29811 commenters confirm **ggml-org MTP heads work** |

MTP and vision choices:
- **Uncensored (huihui):** no MTP. The repo has no head, and borrowing one from another repo does not fit the single-`repo` contract. A future improvement is a cross-repo draft download (ggml-org head).
- **Standard (ggml-org):** `-md {modelDir}/mtp-Qwen3.8-Flash-Next-Q8_0.gguf --spec-type draft-mtp --spec-draft-n-max 3 --parallel 1`.
- **No mmproj on either Flash-Next entry:**
  - qwen4exp + MTP aborts on image input (#30307 open; fix PR #30316 not merged).
  - The QSA indexer OOMs at long context once an image is in the KV cache (#30032).
  - Vision can be enabled later, with the files `mmproj-Qwen3.8-Flash-Next-BF16.gguf` (huihui v2) and `mmproj-Qwen3.8-Flash-Next-Q8_0.gguf` (ggml-org).
- **`--parallel 1`** on Flash-Next, because of the multi-sequence recurrent-state issues (#28019) and MTP slot contamination (#28286).

### 3.4 Fallback on the same profile

`qwen38-27b-uncensored-hauhau-q8kp` (Q8_K_P, 31.46 GB + mmproj) and `qwen38-27b-standard-unsloth-q8` (Q8_0, 29.05 GB + mmproj), at **262144 ctx**:
- 29.3 GiB weights + 8.5 GiB KV q8 + ~0.5 GiB MTP KV + 0.87 GiB mmproj + ~2.5 GiB compute ≈ **42 GiB**. Plenty of room.
- Rock-solid arch (qwen35), MTP plus vision both work. #30257, merged 2026-10-10, fixed MTP with image input, tested on Qwen3.5-4B-MTP.

---------------------------------------------------------------------------------------------------------------------

## 4. max: 2× RTX PRO 6000 (2 × 95.6 GiB = 191.2 GiB) → GLM-5.3-Flash

### 4.1 Model facts

`zai-org/GLM-5.3-Flash` `config.json`:
- `Glm5NextForConditionalGeneration`, 320B total / 18B active, 45 layers.
- 34 KDA linear-attention layers and 11 DeepSeek-sparse-attention layers using MLA (`kv_lora_rank 512`, indexer top-k 2048).
- 288 routed experts (top-8) plus 1 shared, 1 NextN layer, `max_position_embeddings 1048576`, vision tower.

### 4.2 llama.cpp support: YES, upstream, but very new

- Arch **`glm5-next`**, from **PR #27773, merged 2026-09-30**.
- MTP added in **#29928 (2026-10-07)**.
- Sparse-FA CUDA in #27970.
- Open issues of note:
  - #28282: illegal memory access at `-ub 2048` on sm_120. **Do not raise ubatch.**
  - #29950: VRAM increase after a commit.
  - #30204: MTP + mmproj image failure.
  - #27428: MTP roughly halves prompt processing on multi-GPU layer split; reports in #29811 also say MTP is slower than no MTP on dual GPUs.
- **Therefore: no MTP for GLM on the 2-GPU profile, and keep vision.** Every GLM entry is marked `experimental`.

### 4.3 Quant choice

| Option | total | per-GPU weights (layer split) | verdict |
|---|---|---|---|
| unsloth / huihui **UD-IQ4_XS** (5 shards) | 156.81 GB = 146.0 GiB (+1.16 GB mmproj) | ~73 GiB | **chosen**: ~45 GiB of headroom across both GPUs |
| ggml-org Q4_K (2 shards) | 181.36 GB = 168.9 GiB | ~84.5 GiB | tight but possible; no embedded NextN (separate mtp file) |
| unsloth/huihui UD-Q4_K_XL | 199.71 GB = 186.0 GiB | ~93 GiB | **does not fit** with KV and compute buffers |
| BoldingBuilds/orcarouter_GLM-5.3-Flash-Uncensored-GGUF IQ3_XXS | 134.30 GB | ~62.5 GiB | alternative uncensored build; not gated; lower quality |

- **Header check:** unsloth and huihui UD-IQ4_XS both show `glm5-next.block_count = 46` and `nextn_predict_layers = 1`, so MTP could be enabled later on a single big-memory GPU. huihui shards 2–5 differ by sha256 from unsloth's.
- **KV is cheap.** MLA stores about 512 latent values per token per sparse layer (11 layers), roughly 0.8 GB at 131072 ctx with q8_0. Add the KDA recurrent state (~0.14 GB per slot) and the indexer cache. Context could be raised to 262144 or more. Native is 1M; 131072 was chosen conservatively.
- **[UNVERIFIED]:** behaviour of `--cache-type-k/v q8_0` on the MLA cache. If startup fails, drop the `-ctk/-ctv` flags for this family.
- `-sm layer` (the default) splits layers across both GPUs. Leave `-np` at the server default (auto = 4 slots, unified KV), since MTP is off.

---------------------------------------------------------------------------------------------------------------------

## 5. Cross-cutting llama.cpp facts and gotchas (b11561)

- **`--no-mmap` is gone.** Loading is now `--load-mode auto|none|mmap|mlock|mmap+mlock|dio`. Model cards that still show `--no-mmap` (HauhauCS) would make llama-server exit on an unknown argument. **Never pass it.**
- `--jinja` is on by default in llama-server; passing it is harmless.
- `--fit` is on by default and only touches *unset* parameters.
- `--parallel` defaults to auto: 4 slots with unified KV, where `-c` is the shared pool.
- `--spec-type draft-mtp` alone uses the embedded NextN layer. `-md <file>` loads a separate MTP head. The old `--draft-max/--draft-n` flags now **error**; use `--spec-draft-n-max`.
- `--ctx-checkpoints` (alias `--swa-checkpoints`) defaults to 32 per slot. It is needed for prompt-cache reuse on these hybrid/recurrent models. The default is fine. Checkpoints live in host RAM, budgeted by `--cache-ram` (default 8192 MiB).
- **Thinking controls,** passed per request in `chat_template_kwargs`:
  - Qwen3.8: `enable_thinking`, `preserve_thinking`, `reasoning_effort` (`xhigh`|`medium`|`low`).
  - GLM-5.3: `reasoning_effort` (`low`|`high`|`max`, default max) and `clear_thinking` (template default false; set true for chat).
  - Server-wide defaults: `--reasoning on|off`, `--reasoning-effort`, `--chat-template-kwargs '{...}'`.
- **Sampling (model cards):**
  - Qwen3.8 thinking: `temperature 1.0, top_p 0.95, top_k 20, min_p 0, presence_penalty 0`.
  - Qwen3.8 non-thinking: `0.7 / 0.8 / 20 / 0 / 1.5`.
  - GLM-5.3: `temperature 1.0, top_p 0.95` (agentic evals used top_p 1.0).

---------------------------------------------------------------------------------------------------------------------

## 6. Recommendations to the `gpu` agent

1. **Default model per profile.**
   - light → `qwen38-27b-uncensored-hauhau-q5kp`
   - standard → `qwen38-flash-next-uncensored-huihui-v2-q4kxl` (experimental)
   - max → `glm53-flash-uncensored-huihui-iq4xs` (experimental)
   - The Uncensored ↔ Standard toggle swaps to the same family's `standard` variant.
2. **Experimental fallback.** If an experimental model's llama-server exits, or `/health` is not 200 within the load timeout, do not destroy the instance immediately. Switch on the same instance to the profile's non-experimental model: `qwen38-27b-uncensored-hauhau-q8kp`, or `qwen38-27b-standard-unsloth-q8` when the toggle is Standard. Destroy only if that also fails. For **max** there is no non-experimental model: on failure, destroy and surface the error.
3. **Smoke test the whole clock-in pipeline first** with `test-qwen35-0.8b-q8` (0.81 GB) on the cheapest `light` offer (~$0.52/h). Test the self-destroy curl at the same time.
4. **Download:**
   ```
   hf download <repo> <files...> [<mmproj>] --local-dir /root/oc/models/<id> --max-workers 16
   ```
   Pass explicit filenames. Track progress by summing file sizes under the directory against `sizeGb`. The curl fallback is in `vast-api.md` §7.5.
5. **Pinned image:** `ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561`, binary `/app/llama-server`. Bump the pin deliberately after re-checking §5 and the open issues.

---------------------------------------------------------------------------------------------------------------------

## 7. Risk register

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| Flash-Next fails to load or crashes (young arch, many open issues) | medium | lost download time (~15 min, ~$0.30–0.40) | experimental flag + same-instance fallback to 27B Q8 |
| huihui Flash-Next **v2** is 1 day old; quality unknown | medium | worse answers | v1 repo has identical paths: `huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF` |
| GLM-5.3 on 2 GPUs has no stable fallback | medium | max profile unusable | surface error; user can choose standard |
| Lazy PLE reads hit slow disk | low–medium | slower decode on Flash-Next | Vast offers report `disk_bw`. Optionally filter `disk_bw gte 1000` (MB/s) for standard |
| q8_0 KV on GLM MLA cache misbehaves | low | load failure | drop `-ctk/-ctv` for `glm-5.3-flash` |
| Repos re-uploaded or renamed later | low | 404 on download | `verifiedAt`; the `.live` test re-verifies via `paths-info` |
| orcarouter repos (gated) | n/a | 401 | excluded; would need an HF token setting |
| VRAM estimates are calculations, not measurements | medium | OOM at load | fit headroom ≥ 5 GiB everywhere; on OOM retry with `-c` halved before falling back |
