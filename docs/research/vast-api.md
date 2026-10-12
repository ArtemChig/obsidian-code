# Vast.ai REST API, llama.cpp image and RunPod fallback: research notes

Researched 2026-10-12. Every statement has a source. Labels used below:

- **[DOC]**: docs.vast.ai pages, or the OpenAPI spec at `https://docs.vast.ai/api-reference/openapi.yaml`.
- **[CLI]**: the official `vast-ai/vast-cli` source, `vastai/api/*.py`, master at commit `8d0d31c928` (2026-10-09). The root `vast.py` is marked deprecated and points to the `vastai` package.
- **[LIVE]**: a request I actually ran on 2026-10-12, with no API key.
- **[INFERRED]**: a conclusion drawn from the sources, not tested end to end.
- **[UNVERIFIED]**: needs a check once the user supplies the API key.

---------------------------------------------------------------------------------------------------------------------

## 0. TL;DR for the `gpu` agent

| Operation | Method and path (base `https://console.vast.ai`) | Body / query | Success response |
|---|---|---|---|
| Search offers | `POST /api/v0/bundles/` (auth optional) | query JSON (§2) | `{"offers":[...], "truncated":false}` |
| Create instance | `PUT /api/v0/asks/{offer_id}/` | create JSON (§3) | `{"success":true,"new_contract":<instance_id>,"instance_api_key":"..."}` |
| Show one instance | `GET /api/v0/instances/{id}/` (CLI adds `?owner=me`) | n/a | `{"instances":{...}}`: an object, not a list |
| List instances | `GET /api/v1/instances/?select_filters=..&order_by=..&limit=25&after_token=..` | JSON-encoded query params | `{"instances":[...],"next_token":..,"total_instances":..}` |
| Destroy | `DELETE /api/v0/instances/{id}/` | `{}` | `{"success":true}` |
| Stop / start | `PUT /api/v0/instances/{id}/` | `{"state":"stopped"}` / `{"state":"running"}` | `{"success":true}` |
| Label | `PUT /api/v0/instances/{id}/` | `{"label":"obsidian-code"}` | `{"success":true}` |
| Current user / credit | `GET /api/v0/users/current/` | n/a | user object incl. `credit` / `balance` (§5) |
| Register account SSH key | `POST /api/v0/ssh/` | `{"ssh_key":"ssh-ed25519 AAAA... comment"}` | `{"success":true,"key":{"id":..}}` |
| List account SSH keys | `GET /api/v0/ssh/` | n/a | array of `{id,user_id,key,created_at,deleted_at}` |
| Attach key to instance | `POST /api/v0/instances/{id}/ssh/` | `{"ssh_key":"ssh-ed25519 ..."}` | `{"success":true,"msg":...}` |
| Container logs | `PUT /api/v0/instances/request_logs/{id}/` | `{"tail":"1000"}` | `{"success":true,"result_url":"https://s3..."}`; poll that URL |
| Self-destroy (inside the instance) | `DELETE /api/v0/instances/$CONTAINER_ID/` with `Authorization: Bearer $CONTAINER_API_KEY` | `{}` | `{"success":true}` |

- Auth header: `Authorization: Bearer <api_key>` **[DOC][CLI]**.
- Always send the trailing slash. The CLI's `VastClient` adds `/api/v0` when the subpath has no version **[CLI]**.

---------------------------------------------------------------------------------------------------------------------

## 1. Base URL, auth, errors, rate limits

- **Base:** `https://console.vast.ai`, then `/api/v0/...`. Instance listing is `/api/v1/instances/`. The CLI allows a `VAST_URL` override **[CLI `api/client.py`]**.
- **Auth:** `Authorization: Bearer $VAST_API_KEY` **[DOC authentication]**. The CLI also sends `User-Agent: vastai-sdk/<ver>`; the server does not require it.
- **Scoped keys:** the permission categories are `misc` (offer search), `user_read`, `instance_read`, `instance_write`, `billing_read`, `billing_write` and others **[DOC permissions]**. The app needs `misc`, `user_read`, `user_write` (to register an SSH key), `instance_read` and `instance_write`.
- **Error shapes [LIVE]:**
  - No auth on a protected endpoint: **HTTP 403** `{"success":false,"error":"auth_error","msg":"This action requires login."}`
  - Bad key: **HTTP 404** `{"success":false,"error":"auth_error","msg":"Invalid user key"}`. The status really is 404, not 401, so the "Test key" button must treat `error=="auth_error"` with any of 401, 403 or 404 as an invalid key.
  - Generic **[DOC]:** `{"success":false,"error":"invalid_args","msg":"..."}`. Some endpoints return only `msg` or `detail`.
- **Rate limits:**
  - **[DOC]:** limits are per endpoint and per identity (token + IP), enforced as a minimum interval between calls. Hitting one returns **HTTP 429** with the body `API requests too frequent` or `... endpoint threshold=2.0`. The OpenAPI 429 examples show `threshold=2.0` for show-instance, `threshold=3.0` for destroy and `threshold=1.0` for manage and ssh-key.
  - **[DOC]:** "The API does not currently set standard rate-limit headers".
  - **[LIVE]:** `/bundles/` did return `X-RateLimit-Limit: 30.0`, `X-RateLimit-Remaining: 28` and `X-RateLimit-Reset: <epoch>`. Do not depend on these headers.
  - **Recommendation:** poll instance status every 5–10 s. Retry 429/502/503/504 with backoff starting at 2 s, ×1.5 each time. The CLI retries those four codes three times, starting at 0.15 s **[CLI]**. Retry destroy with at least 3 s spacing.

---------------------------------------------------------------------------------------------------------------------

## 2. Search offers: `POST /api/v0/bundles/`

### 2.1 Request format

The body is a flat JSON object. Each filter is `{"<op>": value}`. Allowed ops are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in` and `notin` **[DOC search-offers]**. Control keys:

| Key | Meaning |
|---|---|
| `order` | `[["dph_total","asc"]]`. A list of `[field, "asc"|"desc"]`. The CLI default is `[["score","desc"]]` |
| `limit` | Max offers to return. **[LIVE]** never returned more than 64 rows per query, even with `limit: 500` (`truncated:false`). Narrow the filters instead of raising the limit |
| `type` | `"on-demand"` (CLI spelling) or `"ondemand"` (DOC spelling). Both returned the same 51 offers **[LIVE]**. `"bid"` means interruptible; `"reserved"` also exists. Leaving it out also worked. **Use `"on-demand"`** |
| `allocated_storage` | Disk GB used **for pricing**. `dph_total` includes `storage_cost`(/GB/month) × this value / 720. **Set it to the same `disk` you will request at create time** |

The CLI adds these default filters unless `--no-default` is given **[CLI `api/offers.py`]**: `{"verified":{"eq":true},"external":{"eq":false},"rentable":{"eq":true},"rented":{"eq":false}}`.

### 2.2 Field names, units and gotchas

| Field (filter + response) | Unit / type | Notes |
|---|---|---|
| `gpu_name` | string | **REST requires spaces**: `"RTX 5090"`. `"RTX_5090"` returned **0 offers [LIVE]**. The CLI converts `_` to space before sending **[CLI `api/query.py`]**, and the DOC examples showing `RTX_4090` are CLI syntax |
| `num_gpus` | int | GPUs in the offer |
| `gpu_ram` | **MB** per GPU | 5090 = `32607`; RTX PRO 6000 (all three) = `97887`; H200 NVL = `143771` **[LIVE]**. The CLI multiplies GB by 1000 (`offers_mult`) **[CLI]**. OpenAPI quirk note: "`gpu_ram` in CLI = GB; in REST API = MB" |
| `gpu_total_ram` | MB | Sum across all GPUs in the offer |
| `cpu_ram` | **MB** | The CLI multiplies by 1000 **[CLI]**. Live values look like the instance's share of host RAM, for example 85931 for a 1/3 share **[LIVE]** |
| `disk_space` | GB | Disk available for this offer |
| `inet_down`, `inet_up` | **Mbps** (megabits) | DOC says "MB/s", but live values reach 14680, which only makes sense as Mbps. The CLI help also says Mbps **[INFERRED]** |
| `inet_down_cost`, `inet_up_cost` | **$/GB** | Live range is 0.0026–0.039 $/GB, i.e. $2.6–$39 per TB. **Matters**: one Flash-Next download (~106 GB) costs $0.28–$4.10. Filter `inet_down_cost lte 0.01` and add it to the cost estimate |
| `reliability` / `reliability2` | 0..1 | Both present in responses with identical values. `reliability` worked as a filter **[LIVE]**. The CLI comments out its `reliability`→`reliability2` alias. **Filter on `reliability`** |
| `verified` | bool filter | Works as a filter, **but is absent from responses**. Responses carry `verification: "verified"` instead **[LIVE]** |
| `rentable`, `rented` | bool | |
| `external` | bool filter | Responses show `null` |
| `datacenter` | bool filter | **Absent from responses.** `{"datacenter":{"eq":true}}` returned exactly the same 8 offers as `{"hosting_type":{"eq":1}}` **[LIVE]**. **Datacenter flag in responses: `hosting_type == 1`** (0 = community host) |
| `direct_port_count` | int | Must be ≥ 1 for direct SSH. DOC hello-world uses `{"gte":1}`. Use ≥ 4 (machine tester logic wants > 3) |
| `cuda_max_good` | float, e.g. `13.2` | Max CUDA the host driver supports. Alias `cuda_vers`. **Filter `gte 12.8`** for the recommended image (§7) |
| `compute_cap` | int ×100 | Blackwell 5090 and RTX PRO 6000 report `1200` (sm_120) **[LIVE]** |
| `driver_version` | string `"580.159.04"` | Live hosts ran 580–595 |
| `dph_base` | $/h | GPU-only price |
| `dph_total` | $/h | GPU + storage for `allocated_storage`. **Excludes bandwidth.** Alias `dph`. **Sort on this** |
| `storage_cost` | $/GB/month | Typical live value 0.2 |
| `min_bid` | $/h | Interruptible floor (not used) |
| `geolocation` | string `"Poland, PL"` | Filter with ISO-2 codes: `{"geolocation":{"in":["US","CA"]}}` worked **[LIVE]** |
| `duration` | seconds | How long the offer stays available. `end_date` is the epoch it ends. Filter `duration gte 86400` to avoid expiring hosts |
| `static_ip`, `public_ipaddr` | | |
| `score`, `dlperf`, `dlperf_per_dphtotal`, `flops_per_dphtotal` | | Sort options |
| `id` (= `ask_contract_id`) | int | **The offer id used in `PUT /asks/{id}/`** |

### 2.3 Exact `gpu_name` values seen live (2026-10-12)

| Profile | `gpu_name` values | Live offers |
|---|---|---|
| light | `"RTX 5090"` | 51 single-GPU offers. Cheapest with profile filters: **$0.52/h** |
| standard / max | `"RTX PRO 6000 WS"`, `"RTX PRO 6000 S"`, `"RTX PRO 6000 Max-Q"` (Workstation, Server, Max-Q) | 1×: **$1.19/h** cheapest, median ~$1.36/h. 2×: **$2.64/h** cheapest |
| (info) | `"H200"` (8× boxes only), `"H200 NVL"` (1–4×, from $4.07/h) | Over budget, not used |

Other names seen: `H100 SXM`, `H100 PCIE`, `H100 NVL`, `A100 SXM4`, `A100 PCIE`, `RTX 6000Ada`, `RTX PRO 5000`, `RTX 4090`, `L40S`, `RTX A6000`.

### 2.4 Live request and trimmed response (unauthenticated) [LIVE 2026-10-12T11:14Z]

Request: RTX PRO 6000, `standard` profile filters.

```bash
curl -s -X POST https://console.vast.ai/api/v0/bundles/ -H 'Content-Type: application/json' -d '{
 "verified":{"eq":true},"external":{"eq":false},"rentable":{"eq":true},"rented":{"eq":false},
 "gpu_name":{"in":["RTX PRO 6000 WS","RTX PRO 6000 S","RTX PRO 6000 Max-Q"]},
 "num_gpus":{"eq":1},"gpu_ram":{"gte":90000},"cpu_ram":{"gte":64000},"disk_space":{"gte":200},
 "inet_down":{"gte":500},"reliability":{"gte":0.98},"direct_port_count":{"gte":4},"cuda_max_good":{"gte":12.8},
 "dph_total":{"lte":2.5},"order":[["dph_total","asc"]],"type":"on-demand","limit":5,"allocated_storage":200}'
```

Response, trimmed to 2 offers and selected keys. The real objects have about 80 keys; full key list in §2.5:

```json
{
 "offers": [
  {
   "id": 40420026, "ask_contract_id": 40420026, "machine_id": 139244, "host_id": 448477,
   "gpu_name": "RTX PRO 6000 WS", "num_gpus": 1, "gpu_ram": 97887, "gpu_total_ram": 97887,
   "cpu_ram": 127387, "cpu_cores_effective": 16.0, "disk_space": 2658.5,
   "inet_down": 1509.9, "inet_up": 648.2, "inet_down_cost": 0.0026041666666666665,
   "reliability": 0.9919226, "reliability2": 0.9919226, "verification": "verified",
   "rentable": true, "rented": false, "hosting_type": 0, "direct_port_count": 256,
   "cuda_max_good": 13.2, "compute_cap": 1200, "driver_version": "595.84",
   "dph_base": 1.1333333333333333, "storage_cost": 0.19999999999999998, "dph_total": 1.1888888888888889,
   "min_bid": 1.0, "geolocation": "South Korea, KR", "public_ipaddr": "218.54.79.129",
   "static_ip": false, "duration": 5109475.733211756, "end_date": 1796913129.0
  },
  {
   "id": 54241108, "ask_contract_id": 54241108, "machine_id": 132178, "host_id": 553966,
   "gpu_name": "RTX PRO 6000 Max-Q", "num_gpus": 1, "gpu_ram": 97887, "gpu_total_ram": 97887,
   "cpu_ram": 184231, "cpu_cores_effective": 54.857142857142854, "disk_space": 600.4285714285714,
   "inet_down": 4079.0, "inet_up": 3167.6, "inet_down_cost": 0.0026041666666666665,
   "reliability": 0.9865244, "reliability2": 0.9865244, "verification": "verified",
   "rentable": true, "rented": false, "hosting_type": 0, "direct_port_count": 142,
   "cuda_max_good": 13.1, "compute_cap": 1200, "driver_version": "590.48.01",
   "dph_base": 1.2, "storage_cost": 0.19999999999999998, "dph_total": 1.2555555555555555,
   "min_bid": 0.6666666666666666, "geolocation": "Poland, PL", "public_ipaddr": "89.25.223.118",
   "static_ip": true, "duration": 2678194.48226285, "end_date": 1794481847.749051
  }
 ],
 "truncated": false
}
```

Request: RTX 5090, `light` profile filters. Same filters except `"gpu_name":{"eq":"RTX 5090"}`, `cpu_ram gte 32000`, `disk_space gte 100`, `dph_total lte 1.0`, `allocated_storage 100`. Trimmed response:

```json
{
 "offers": [
  {
   "id": 54138583, "machine_id": 136897, "gpu_name": "RTX 5090", "num_gpus": 1, "gpu_ram": 32607,
   "cpu_ram": 63394, "disk_space": 1575.0, "inet_down": 834.9, "inet_down_cost": 0.0026041666666666665,
   "reliability": 0.9890166, "verification": "verified", "hosting_type": 0, "direct_port_count": 98,
   "cuda_max_good": 13.0, "compute_cap": 1200, "driver_version": "580.178.04",
   "dph_base": 0.4933333333333333, "dph_total": 0.5211111111111111, "geolocation": "South Korea, KR"
  },
  {
   "id": 53483881, "machine_id": 39913, "gpu_name": "RTX 5090", "num_gpus": 1, "gpu_ram": 32607,
   "cpu_ram": 64139, "disk_space": 492.0, "inet_down": 796.8, "inet_down_cost": 0.0026041666666666665,
   "reliability": 0.9992493, "verification": "verified", "hosting_type": 0, "direct_port_count": 98,
   "cuda_max_good": 13.0, "compute_cap": 1200, "driver_version": "580.173.02",
   "dph_base": 0.5333333333333333, "dph_total": 0.5611111111111111, "geolocation": "South Korea, KR"
  }
 ],
 "truncated": false
}
```

The 2× RTX PRO 6000 query (`num_gpus eq 2`, `cpu_ram gte 128000`, `disk_space gte 400`, `reliability gte 0.97`, `allocated_storage 400`) returned 5 offers. Cheapest: `id 54377895`, `RTX PRO 6000 WS` ×2, `gpu_total_ram 195774`, `dph_total 2.644`, British Columbia, CA.

### 2.5 Full key list of an offer object [LIVE]

`ask_contract_id, avail_vol_ask_id, avail_vol_dph, avail_vol_size, bundle_id, bundled_results, bw_nvlink, cluster_id, compute_cap, cpu_arch, cpu_cores, cpu_cores_effective, cpu_ghz, cpu_name, cpu_ram, credit_discount_max, cuda_max_good, direct_port_count, discount_rate, discounted_dph_total, discounted_hourly, disk_bw, disk_name, disk_space, dlperf, dlperf_per_dphtotal, dph_base, dph_total, dph_total_adj, driver_vers, driver_version, duration, end_date, expected_reliability, external, flops_per_dphtotal, geolocation, geolocode, gpu_arch, gpu_display_active, gpu_frac, gpu_ids, gpu_lanes, gpu_max_power, gpu_max_temp, gpu_mem_bw, gpu_name, gpu_ram, gpu_total_ram, has_avx, host_id, hosting_type, hostname, id, inet_down, inet_down_cost, inet_up, inet_up_cost, instance{...}, internet_down_cost_per_tb, internet_up_cost_per_tb, is_bid, is_vm_deverified, logo, machine_id, min_bid, mobo_name, num_gpus, nw_disk_*, os_version, pci_gen, pcie_bw, public_ipaddr, reliability, reliability2, reliability_mult, rentable, rented, resource_type, rn, score, search{gpuCostPerHour,diskHour,totalHour,...}, sla_*, start_date, static_ip, storage_cost, storage_total_cost, target_reliability, time_remaining, time_remaining_isbid, total_flops, vericode, verification, vms_enabled, vram_costperhour, webpage`

### 2.6 Mapping to `GpuOffer` (src/shared/types.ts)

`offerId=id`, `gpuName=gpu_name`, `numGpus=num_gpus`, `gpuRamGb=gpu_ram/1024` (MiB; 97887 → 95.6), `cpuRamGb=cpu_ram/1024`, `diskGb=disk_space`, `inetDownMbps=inet_down`, `reliability=reliability`, `pricePerHour=dph_total`, `location=geolocation`, `datacenter=(hosting_type===1)`, `verified=(verification==="verified")`.

For profile filters, convert GB to MB as ×1000, the way the CLI does. This is conservative because the true unit is MiB (32 GB × 1000 = 32000 < 32607).

Other endpoints seen in the CLI:
- `PUT /api/v0/search/asks/` with `{"select_cols":["*"],"q":{...}}` **[CLI `search_offers_new`]**. LIVE it returned 400: `select_cols.0: String should match pattern '^[a-zA-Z0-9_]+$'`. **Do not use it.**
- `GET /api/v0/bundles/?q=<urlencoded JSON>` also works **[LIVE]**. POST is simpler.

---------------------------------------------------------------------------------------------------------------------

## 3. Create instance from an offer: `PUT /api/v0/asks/{offer_id}/`

Source: **[DOC create-instance / creating-instances-with-api]**, plus `build_create_instance_payload()` in **[CLI `api/instances.py`]**.

### 3.1 Body fields

| Field | Type | Notes |
|---|---|---|
| `client_id` | `"me"` | The CLI always sends it. Harmless |
| `image` | string | e.g. `"ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561"`. Any registry. Private registries use `image_login: "-u user -p token registry"` |
| `disk` | number GB | Static and cannot change later **[DOC docker-environment]**. Match `allocated_storage` |
| `label` | string ≤ 1024 | Use `"obsidian-code"` for orphan detection |
| `runtype` | string | See §3.2. **Recommended `"ssh_direc ssh_proxy"`** |
| `onstart` | string | Shell script run by Vast's entrypoint. **Max ≈ 4048 chars** (OpenAPI "Key Quirks": "`onstart` field is limited to 4048 characters -- gzip+base64 for longer scripts") |
| `env` | **JSON object** | `{"KEY":"value", "-p 8080:8080":"1"}`. Ports use a `-p` key with value `"1"` **[DOC][CLI parse_env]**. The OpenAPI schema calls it a Docker-flag *string*, but the guide and the CLI send an **object**. **Send an object** |
| `args` / `args_str` | | Only for `runtype: "args"` (keeps the image ENTRYPOINT). Not used |
| `price` | number | Bid price, interruptible only. **Omit** for on-demand |
| `cancel_unavail` | bool | Defaults to **true** for on-demand with target_state running: fail rather than create a stopped instance. Send `true` explicitly |
| `target_state` | `"running"`/`"stopped"` | Default running |
| `python_utf8`, `lang_utf8`, `use_jupyter_lab`, `jupyter_dir`, `force`, `user`, `template_hash_id`, `volume_info`, `vm`, `extra` | | Not needed |

### 3.2 `runtype`

| Value | Effect |
|---|---|
| `ssh` / `ssh_proxy` | SSH through a Vast proxy host (`sshN.vast.ai:port`). No ports opened on the instance |
| `ssh_direct` | Direct SSH. Provisions internal port 22 → a random external port **[DOC]** |
| `ssh_direc ssh_proxy` | **What the official CLI sends for `--ssh --direct`**; covered by a test **[CLI `resolve_runtype` + tests/api/test_create_instance_payload.py]**. Gives both direct and proxy SSH. The instance's `image_runtype` echoes it, e.g. `"ssh ssh_direc ssh_proxy"` **[DOC v1 example]** |
| `jupyter_*` | Also includes SSH. Not needed |
| `args` | Keeps the image ENTRYPOINT. No SSH |

**Entrypoint behaviour [DOC]:** SSH and Jupyter runtypes **replace the image ENTRYPOINT** with Vast's own setup entrypoint, which then runs your `onstart`.
- **[DOC FAQ]:** "For SSH instances: Place startup commands in `/root/onstart.sh`. This script runs automatically on container startup."
- **[INFERRED]:** the `onstart` field is materialised as that file, so it runs again after every stop/start or reboot. Make the bootstrap idempotent.
- **[INFERRED]:** run long-lived work with `nohup … &`. Whether Vast's entrypoint waits for onstart to finish is undocumented.
- **[INFERRED]:** image `ENV` (PATH, LD_LIBRARY_PATH) is preserved, because Docker keeps image ENV when the entrypoint is overridden.

Requirements on the image for SSH mode:
- **[DOC]:** "your docker image must be compatible with a typical ssh daemon setup". Vast "will install Jupyter and SSH at runtime".
- **[INFERRED]:** Vast's own hello-world uses `pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime`, which ships no sshd, so Vast installs openssh itself on Debian/Ubuntu images that have `apt`. The recommended llama.cpp image is Ubuntu 24.04 with bash and apt.
- **[UNVERIFIED]:** SSH has not been tested on that exact image. **Plan B** if SSH does not come up: use `vastai/base-image:@vastai-automatic-tag`, or `nvidia/cuda:12.8.1-runtime-ubuntu24.04`, and download the prebuilt release tarball in onstart. Releases ship `llama-bNNNNN-bin-ubuntu-cuda-12.8-x64.tar.gz` (~172 MB) plus `cudart-llama-bNNNNN-bin-ubuntu-cuda-12.8-x64.tar.gz` (~594 MB), verified on release b11565.
- Vast auto-starts tmux for interactive SSH logins. Run `touch ~/.no_auto_tmux` in onstart to disable it **[DOC]**. ssh2 `exec` channels are non-interactive and should not be affected **[INFERRED]**.

### 3.3 Environment variables

- **[DOC]:** env vars set via `env` are visible to `onstart`, but **not inside SSH sessions** unless exported, e.g. `env >> /etc/environment`. In onstart, write the needed vars to `/root/oc/env` (mode 600) and have SSH-run scripts source it.
- **Predefined in every instance [DOC docker-environment]:**
  - `CONTAINER_API_KEY`: a per-instance key.
  - `CONTAINER_ID`: the instance id.
  - `VAST_CONTAINERLABEL`: e.g. `C.38250`.
  - `PUBLIC_IPADDR`
  - `SSH_PUBLIC_KEY`
  - `GPU_COUNT`
  - `DATA_DIRECTORY`
  - `VAST_TCP_PORT_<internal>`: the external port mapped to each `-p` port, e.g. `VAST_TCP_PORT_22`.
- Max 64 open ports per instance. Ports ≥ 70000 request identity mappings.

### 3.4 Example request and response

```bash
curl -s -X PUT "https://console.vast.ai/api/v0/asks/40420026/" \
  -H "Authorization: Bearer $VAST_API_KEY" -H "Content-Type: application/json" -d '{
  "client_id": "me",
  "image": "ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561",
  "disk": 200,
  "label": "obsidian-code",
  "runtype": "ssh_direc ssh_proxy",
  "cancel_unavail": true,
  "env": {
    "OC_MODEL_ID": "qwen38-flash-next-uncensored-huihui-v2-q4kxl",
    "OC_API_KEY": "<random 32 bytes hex>",
    "OC_IDLE_MIN": "20", "OC_HEARTBEAT_MIN": "10", "OC_MAX_HOURS": "6",
    "OC_BOOTSTRAP_GZB64": "<gzip+base64 of bootstrap.sh>"
  },
  "onstart": "mkdir -p /root/oc; touch ~/.no_auto_tmux; echo \"$OC_BOOTSTRAP_GZB64\" | base64 -d | gunzip > /root/oc/bootstrap.sh; nohup bash /root/oc/bootstrap.sh >> /root/oc/bootstrap.log 2>&1 &"
}'
```

Response:

```json
{ "success": true, "new_contract": 12345678, "instance_api_key": "d15a..." }
```

- **The instance id is `new_contract`**, not `id`. `instance_api_key` is the same key injected as `CONTAINER_API_KEY` **[DOC api hello-world][CLI `CreateInstanceResponse`]**.
- Errors **[DOC]**: 400 `{"success":false,"error":"invalid_args"|"invalid_price"|"no_ssh_key_for_vm","msg":...,"ask_id":...}`, 403 when the offer is not your own (host self-rent), 404 when the offer is gone. Offers vanish between search and create, so try the next offer **[DOC]**.

### 3.5 Passing a long bootstrap

The onstart limit is about 4048 chars, so keep `onstart` as a short stub and ship the script another way:
- (a) Put the script in an `env` value as gzip+base64, as in the example above. **[UNVERIFIED]:** Vast's max env value size is unknown. A 10–20 KB value is far below Linux's 128 KB per-string limit.
- (b) Or upload it after SSH is up with `scp`/`sftp` to `/root/oc/bootstrap.sh`.

**Recommended:** (a), with (b) as fallback. The stub should **arm the self-destroy watchdog first** (§6), so a broken bootstrap or a dead app can never leave a billing instance behind.

---------------------------------------------------------------------------------------------------------------------

## 4. Instance status, listing, stop/start/label/destroy, logs

### 4.1 Show one instance: `GET /api/v0/instances/{id}/`

The CLI adds `?owner=me`. The response is wrapped as **`{"instances": {...single object...}}`**; it is not a list **[DOC][CLI `show_instance`]**. A destroyed or unknown id gives `"instances": null` (the CLI checks for this) or a 404.

Key fields **[DOC Instance schema + v1 schema]**:

| Field | Meaning |
|---|---|
| `actual_status` | Container status: `null` (provisioning), `"created"`, `"loading"` (pulling image), `"running"`, `"stopped"`, `"frozen"`, `"exited"`, `"rebooting"`, `"unknown"`, `"offline"` **[CLI SKILL.md]**. **Poll trap [DOC]:** `exited`, `unknown` or `offline` will never become `running`, so destroy and try another offer |
| `intended_status` | What you asked for (`"running"`/`"stopped"`) |
| `cur_state` / `next_state` | Contract state (`"running"`, `"stopped"`, ...) |
| `status_msg` | e.g. `"success, running <image>/ssh"`. The CLI destroys the instance if it contains `"Error"` |
| `label` | |
| `ssh_host`, `ssh_port`, `ssh_idx` | **Proxy** SSH: host like `ssh2281.vast.ai` and its port |
| `public_ipaddr` | Instance public IP, for direct SSH and ports |
| `ports` | Only when running: `{"22/tcp":[{"HostIp":"0.0.0.0","HostPort":"20000"}], "8080/tcp":[...]}`. The v0 schema doc wrongly says `int[]`; the v1 schema and the CLI code use the dict form |
| `direct_port_start`, `direct_port_end` | |
| `dph_total`, `dph_base`, `storage_cost` | $/h |
| `start_date` | Epoch seconds. `duration` = now − start_date, computed client-side by the CLI |
| `gpu_name`, `num_gpus`, `gpu_util`, `gpu_temp`, `geolocation`, `image_uuid`, `image_runtype`, `extra_env` (list of `[k,v]` pairs), `onstart`, `machine_id`, `host_id`, `uptime_mins`, `is_bid` | |

**SSH endpoint resolution**, exactly as the CLI's `_ssh_url` does it **[CLI vast.py `_ssh_url`]**:

```
user = "root"
if ports["22/tcp"] exists: host = public_ipaddr; port = int(ports["22/tcp"][0]["HostPort"])    # direct
else:                      host = ssh_host;      port = ssh_port (+1 if "jupyter" in image_runtype) # proxy
```

Prefer direct. Fall back to proxy if direct refuses for about 60 s. SSH is key-only, with password auth disabled **[DOC ssh]**.

### 4.2 List instances: `GET /api/v1/instances/`

The CLI uses this endpoint **[DOC][CLI `show_instances`]**. Query params are JSON-encoded strings:
- `select_filters={"label":{"eq":"obsidian-code"}}`. Filterable columns are those stored on the contract, such as `actual_status`, `gpu_name`, `id` and `label`. Computed columns like `dph_total` and `num_gpus` give a 400.
- `order_by=[{"col":"id","dir":"asc"}]`
- `limit=25` (max 25)
- `after_token=<next_token>`
- `select_cols=["*"]`

Response: `{"success":true,"instances":[...],"instances_found":N,"total_instances":N,"label_counts":{...},"next_token":null|"..."}`. Page until `next_token` is null.

Example: `GET /api/v1/instances/?select_filters=%7B%22label%22%3A%7B%22eq%22%3A%22obsidian-code%22%7D%7D&limit=25`.

### 4.3 Stop, start, label, reboot

- Stop: `PUT /api/v0/instances/{id}/` with `{"state":"stopped"}`.
- Start: same path with `{"state":"running"}`.
- Label: same path with `{"label":"..."}`.
- All three return `{"success":true}` **[DOC manage-instance][CLI]**. Bulk forms are `PUT /api/v0/instances/` with `{"ids":[...],"state":...}`.
- Reboot: `PUT /api/v0/instances/reboot/{id}/` with `{}`.
- Stopped instances still bill storage, and a restart can wait forever for the GPU ("Scheduling") **[DOC]**. **The app must never stop; always destroy.**

### 4.4 Destroy: `DELETE /api/v0/instances/{id}/`

- Body `{}`. Returns `{"success":true}`, or 404 `{"success":false,"error":"not_found"}` **[DOC][CLI]**.
- Bulk: `DELETE /api/v0/instances/` with `{"instance_ids":[...]}`.
- **Verify** with a GET afterwards: it should return 404 or `instances: null`, or the id should be absent from the v1 list. Treat 404 on DELETE as success-already-gone.

### 4.5 Logs: `PUT /api/v0/instances/request_logs/{id}/`

- Body: `{"tail":"1000"}`, optionally `"filter":"<grep>"`, and `"daemon_logs":"true"` for host daemon logs.
- Response: `{"success":true,"result_url":"https://s3.amazonaws.com/vast.ai/instance_logs/<hash>.log"}`.
- GET `result_url` until it returns 200. The CLI tries 30 times at 0.3 s intervals **[DOC show-logs][CLI `logs`]**.
- This is the container stdout/stderr, so onstart output shows up here when SSH is broken.
- Also available: `PUT /api/v0/instances/command/{id}/` with `{"command":"..."}`, which runs a *constrained* remote command and returns a `result_url` **[DOC execute]**.

### 4.6 Billing granularity and charges

- **Per second** **[DOC billing]**: "charged the base active rental cost for every second your instance is in the active/connected state". Ten minutes of use costs ten minutes.
- **GPU charges begin at `running`.** "Loading" (image pull) is **not charged** **[DOC]**. Storage is charged from creation, in every state except offline. Bandwidth is charged per byte at `inet_*_cost` **[DOC]**.
- Model download happens after `running`, so **download time is billed GPU time**. Prefer high `inet_down`.
- Balance at or below $0: instances are stopped, then destroyed if no card is on file **[DOC]**.

---------------------------------------------------------------------------------------------------------------------

## 5. Current user / credit: `GET /api/v0/users/current/`

- **[DOC show-user]:** returns `id`, `email`, `balance`, `ssh_key`, `key_id`, `sid`.
- **[DOC authentication]:** the example shows `{"id":123456,"email":"...","credit":25.00,"ssh_key":"ssh-rsa ..."}`.
- **[CLI]:** the `show user` table has a `credit` column formatted `{:0.2f}`, plus `can_pay`, `has_billing` and others. The CLI deletes `api_key` from the blob before printing.
- **Use `credit` for the balance shown in the UI.** If it is absent, fall back to `balance`. **[UNVERIFIED]** which of the two is authoritative and whether `balance` is the negative of debt. Check with the real key and log both.

---------------------------------------------------------------------------------------------------------------------

## 6. SSH keys and self-destroy from inside the instance

### 6.1 Account key

- `POST /api/v0/ssh/` with `{"ssh_key":"ssh-ed25519 AAAAC3... obsidian-code"}` → `{"success":true,"key":{"id":123,"user_id":..,"public_key":"..",...}}`.
- List: `GET /api/v0/ssh/`. Delete: `DELETE /api/v0/ssh/{id}/`. Update: `PUT /api/v0/ssh/{id}/` with `{"id":..,"ssh_key":..}` **[DOC][CLI `api/keys.py`]**.
- Format: a standard OpenSSH single-line public key. ed25519 is the documented default (`ssh-keygen -t ed25519`) **[DOC ssh]**.
- **Conflict in the docs:**
  - OpenAPI says a new key is "automatically added to all your current instances".
  - The SSH guide says account keys "only apply to new instances".
  - OpenAPI quirks: "SSH keys must be registered BEFORE creating an instance (VM: no recovery; Docker: can add post-create)".
- **Recommendation:** at startup, check `GET /ssh/` for the app key and `POST` it if missing, before any create.

### 6.2 Per-instance attach

- `POST /api/v0/instances/{id}/ssh/` with `{"ssh_key":"ssh-ed25519 ..."}` → `{"success":true}` **[DOC attach-ssh-key][CLI]**.
- Detach: `DELETE /api/v0/instances/{id}/ssh/{ssh_key_id}/`. List: `GET /api/v0/instances/{id}/ssh/`.
- Call attach once after create as belt-and-braces. **[UNVERIFIED]** whether attaching an already-present key errors; ignore errors here.

### 6.3 Self-destroy

**[DOC api hello-world]:** "The `instance_api_key` is a restricted key injected into the container as `CONTAINER_API_KEY`, it can only start, stop, or destroy that specific instance." **[DOC docker-environment]** shows `vastai destroy instance $CONTAINER_ID` run from inside. The CLI destroy is `DELETE /api/v0/instances/{id}/` with the Bearer key **[CLI]**, so the script-side equivalent is:

```bash
# Inside the instance (bootstrap watchdog). Variables come from the container env (persist them to /root/oc/env in onstart).
ID="${CONTAINER_ID:-${VAST_CONTAINERLABEL#C.}}"
for i in 1 2 3 4 5 6; do
  curl -fsS -X DELETE -H "Authorization: Bearer ${CONTAINER_API_KEY}" -H "Content-Type: application/json" \
       -d '{}' "https://console.vast.ai/api/v0/instances/${ID}/" && break
  sleep $((i * 5))
done
```

Notes:
- **[UNVERIFIED]:** this curl has not been run, because no instance exists yet. Test it during the first live clock-in on the tiny model.
- If `CONTAINER_API_KEY` is missing, the docs give a regeneration recipe from `~/.ssh/authorized_keys` and `VAST_CONTAINERLABEL` that writes `~/.vast_api_key` **[DOC]**.

---------------------------------------------------------------------------------------------------------------------

## 7. llama.cpp server image (part B)

### 7.1 Tags

Tags were listed anonymously from GHCR: `GET https://ghcr.io/token?scope=repository:ggml-org/llama.cpp:pull`, then `/v2/ggml-org/llama.cpp/tags/list` [LIVE]. That returned 12,432 tags. The latest build is **b11561** (image label `org.opencontainers.image.version=b11561`, revision `e937b17a2`, built 2026-10-12).

| Family | Floating tags | Pinned tags | CUDA |
|---|---|---|---|
| full (all binaries + python + pip + git + curl) | `full-cuda` = `full-cuda12` (same digest `sha256:507f8b21…`), `full-cuda13` | `full-cuda12-b11561`, `full-cuda13-b11561`; semver `full-cuda-v0.5.0`, `full-cuda13-v0.5.0` | 12.8.1 / 13.4.1 |
| server (llama-server only, has curl, no python) | `server-cuda`, `server-cuda12`, `server-cuda13` | `server-cuda12-b11561` … | same |
| light (llama-cli only) | `light-cuda`, `light-cuda12`, `light-cuda13` | … | same |

Other backends also published: `-vulkan`, `-rocm`, `-intel`, `-musa`, `-openvino`, `-s390x`.

### 7.2 Build facts

From `.devops/cuda.Dockerfile` and `.github/workflows/docker.yml` on master, plus the image config blob:
- Base images: `nvidia/cuda:12.8.1-runtime-ubuntu24.04` for `cuda`/`cuda12`, `13.4.1` for `cuda13`. The workflow matrix shows `"tag":"cuda cuda12","cuda_version":"12.8.1"` and `"tag":"cuda13","cuda_version":"13.4.1"`.
- Built with `CUDA_DOCKER_ARCH=default`, so ggml's default arch list applies (`ggml/src/ggml-cuda/CMakeLists.txt`). For CUDA ≥ 12.8 it appends **`120a-real`**, and for ≥ 12.9 also `121a-real`. **Both images therefore carry native sm_120 SASS for Blackwell (RTX 5090 / RTX PRO 6000, compute_cap 1200).**
- `GGML_BACKEND_DL=ON` and `GGML_CPU_ALL_VARIANTS=ON`. Libraries are copied into `/app`.
- **Full image contents**, from the image history: Ubuntu 24.04 (bash), `curl`, `ffmpeg`, `libgomp1`, `git`, `python3`, `python3-pip`, `python3-wheel`, and `pip install --break-system-packages -r requirements.txt`. That includes transformers, so huggingface_hub is probably present but may be old. Also `cuda-compat-12-8`. Pip installs need `--break-system-packages` (PEP 668).
- ENTRYPOINT `/app/tools.sh`, WORKDIR `/app`, ENV `PATH=/usr/local/cuda/bin:...`, `LD_LIBRARY_PATH=/usr/local/cuda/lib64`, `NVIDIA_REQUIRE_CUDA=cuda>=12.8 ...`.
- `server` images set `LLAMA_ARG_HOST=0.0.0.0`, `LLAMA_ARG_PORT=8080`. **The full image does not**, but we pass `--host`/`--port` anyway.
- Compressed sizes (amd64): full-cuda12 **3.58 GB**, full-cuda13 3.29 GB, server-cuda12 2.59 GB.

### 7.3 Recommendation

**`ghcr.io/ggml-org/llama.cpp:full-cuda12-b11561`**, pinned. Binary path: **`/app/llama-server`**. The Dockerfile copies `build/bin/*` to `/app/full`, which is then copied to `/app`.

Why `cuda12` and not `cuda13`:
- `NVIDIA_REQUIRE_CUDA=cuda>=12.8` is satisfied by any driver ≥ 570. Every Blackwell host has that, and all live hosts showed `cuda_max_good` 13.0–13.4.
- The cuda13 image requires `cuda>=13.4`. GeForce brands are not in its brand exceptions, so on a host whose driver tops out at CUDA 13.0–13.3 the NVIDIA container runtime may refuse to start it **[INFERRED from the image ENV]**.
- **Offer filter:** `cuda_max_good gte 12.8`.

The image pull (3.6 GB) happens during Vast's "loading" state, which is not billed.

Pinning: bump the pin deliberately. qwen4exp and glm5-next changed almost daily in Sep–Oct 2026. A floating tag could silently change behaviour, or break mid-month.

### 7.4 `llama-server` flags we plan to use

All verified in `common/arg.cpp` on master, which is the same revision family as b11561.

| Flag | Valid? | Notes |
|---|---|---|
| `--host 127.0.0.1` | yes (`LLAMA_ARG_HOST`) | Bind localhost only. The app reaches it through the SSH tunnel |
| `--port 8080` | yes | |
| `--api-key KEY` | yes (`LLAMA_API_KEY`) | Comma-separated list allowed |
| `-ngl 99` (`--gpu-layers`/`--n-gpu-layers`) | yes | Also accepts `auto`/`all`. Default `auto` |
| `-c N` (`--ctx-size`) | yes | 0 = model default |
| `--jinja` | yes | **Default is already enabled** (`use_jinja = true`); passing it is harmless |
| `--flash-attn on` (`-fa`) | yes | Values `on|off|auto`, default auto |
| `--cache-type-k q8_0`, `--cache-type-v q8_0` (`-ctk/-ctv`) | yes | |
| `--ctx-checkpoints N` (`-ctxcp`, alias `--swa-checkpoints`) | yes | Default **32** per slot. Needed for prompt-cache reuse on the hybrid/recurrent models (qwen35, qwen4exp, glm5-next). Keep the default or pass 32 |
| `--spec-type draft-mtp` | yes | Valid types: `none, draft-simple, draft-eagle3, draft-mtp, draft-dflash, draft-dspark, ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache`. MTP uses the main model's embedded NextN layer, or a separate head given with `-md/--spec-draft-model` |
| `--spec-draft-n-max N` | yes | Default 3. **The old `--draft-max/--draft-n` were removed and now error** |
| `--n-cpu-moe N` (`-ncmoe`), `--cpu-moe` | yes | Not needed for the chosen quants |
| `--mmproj FILE` (`-mm`) | yes | `--no-mmproj-offload` keeps it on CPU |
| `--alias NAME` (`-a`) | yes | Comma-separated aliases. Pass the catalog id so `/v1/models` reports it |
| `--parallel N` (`-np`) | yes | Default auto (-1). **Use `-np 1` with draft-mtp** (§8) |
| `--reasoning on|off|auto`, `--reasoning-effort`, `--reasoning-preserve`, `--reasoning-format`, `--chat-template-kwargs` | yes | Optional |
| `--fit on|off` | yes | **Default on**: adjusts *unset* args to fit device memory. We set `-ngl`/`-c` explicitly |
| `--lazy-mode on|auto|off` | yes | Default `auto`: reads tensors > 4 GiB, such as Flash-Next's n-gram PLE table, from disk on demand. **Requires mmap** |
| `--load-mode auto|none|mmap|mlock|mmap+mlock|dio` | yes | Default auto = mmap |
| **`--no-mmap`** | **NO**, not in current arg.cpp | Some model cards (HauhauCS) still show it. **Never pass it; llama-server exits on unknown args** |
| `-ub 2048` | valid, but **don't** with GLM-5.3 | Illegal memory access on sm_120 (#28282) |

Planned base command line:

```
/app/llama-server -m <files[0]> --host 127.0.0.1 --port 8080 --api-key $KEY --alias <catalogId> \
  -ngl 99 -c <ctx> --jinja --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
  [--mmproj <mmproj>] <catalog llamaArgs> --log-file /root/oc/server.log
```

Health checks:
- `GET /health` (no auth) returns 503 while loading and 200 when ready.
- `GET /v1/models` with `Authorization: Bearer $KEY`.

### 7.5 Downloading models: `hf download` with Xet

- **huggingface_hub 2.2.0** (PyPI, released 2026-10-08) **already depends on `hf-xet>=1.6.0,<2`** on x86_64/arm64. So `pip install --break-system-packages -U "huggingface_hub>=2.2"` is enough. `huggingface_hub[hf_xet]` is the explicit form. hf-xet 1.7.0 was released 2026-10-06.
- All chosen repos are **Xet-backed** [LIVE]: tree entries carry `xetHash`, and `resolve/` 302-redirects to `us.aws.cdn.hf.co/xet-bridge-us/...` with an `X-Xet-Hash` header.
- I installed 2.2.0 locally and checked it [LIVE]:
  - `hf download --help`: syntax `hf download REPO_ID [FILENAMES]... [--include GLOB]... [--exclude GLOB] [--local-dir DIR] [--revision REV] [--token T] [--max-workers 8] [--dry-run] [--quiet|--json]`.
  - `hf download unsloth/Qwen3.8-Flash-Next-GGUF --include "UD-Q4_K_XL/*" --local-dir X --dry-run` listed the 4 shards (111.3 G).
  - A real download of a 205 MB file into `--local-dir` worked. It **keeps repo-relative subfolders** (e.g. `X/UD-Q4_K_XL/...gguf`) and creates `X/.cache/huggingface/`.
- Recommended command: `hf download <repo> <file1> <file2> ... --local-dir /root/oc/models/<catalogId> --max-workers 16`. Pass explicit filenames from the catalog rather than globs. Downloads resume automatically.
- Progress: the `--format agent/human/json` outputs are not designed for byte progress. For `status.json` progress, poll the on-disk size of `/root/oc/models/<id>` (including `.cache/huggingface/download/*.incomplete`) against the catalog `sizeGb`.
- Unauthenticated works for all chosen repos (`gated: false`). It prints a warning recommending `HF_TOKEN` for higher rate limits. An optional HF token setting would help.
- **Fallback without Python:**
  ```
  curl -fL --retry 5 -C - -o <file> "https://huggingface.co/<repo>/resolve/main/<path>"
  ```
  This follows the redirect to the Xet bridge CDN and supports Range/resume. Run one curl per file in parallel with `&` + `wait`.

---------------------------------------------------------------------------------------------------------------------

## 8. Known llama.cpp issues that change our defaults

Open issues on ggml-org/llama.cpp as of 2026-10-12:

| Issue | Impact | Our mitigation |
|---|---|---|
| #28286 draft-mtp + `--parallel > 1` → cross-slot content contamination | Wrong answers under concurrent subagents | `--parallel 1` whenever draft-mtp is on |
| #28433 MTP draft context sized from total n_ctx | Possible server kill with multi-slot | Same: `-np 1` |
| #29811 Unsloth Flash-Next MTP heads (shared and non-shared) → `GGML_ASSERT(buffer)` at startup; ggml-org's MTP heads work | Flash-Next + unsloth MTP can't start | Use ggml-org's `mtp-Qwen3.8-Flash-Next-Q8_0.gguf`, or no MTP |
| #30307 qwen4exp + MTP aborts on **image** input (fix PR #30316 still open) | Server crash on images | Flash-Next entries ship **without** mmproj |
| #30032 qwen4exp QSA indexer OOM once images are in a long KV | Crash at long ctx with images | Same (no mmproj for Flash-Next) |
| #30204 GLM-5.3 + mmproj + draft-mtp: image requests fail | | No MTP on GLM |
| #27428 draft-mtp roughly halves prompt processing on multi-GPU layer split | Slower `max` profile | No MTP on 2-GPU GLM |
| #28282 GLM-5.3 CUDA illegal memory access at `-ub 2048` on sm_120 | Crash on long prefill | Never set `-ub 2048` (default 512) |

#30257, merged 2026-10-10 and so included in b11561, fixed MTP + image input in general. Its test used Qwen3.5-4B-MTP. So qwen35 models (Qwen3.8-27B) keep mmproj **and** MTP.

---------------------------------------------------------------------------------------------------------------------

## 9. Recommended `GpuProfile` defaults

Live prices from 2026-10-12. Vast filters are built from these values.

| id | gpuNames | numGpus | minGpuRamGb | minCpuRamGb | minDiskGb | minInetDownMbps | minReliability | maxPricePerHour | datacenterOnly | defaultModelId |
|---|---|---|---|---|---|---|---|---|---|---|
| light | `["RTX 5090"]` | 1 | 30 | 32 | 80 | 500 | 0.98 | 1.00 | false | `qwen38-27b-uncensored-hauhau-q5kp` |
| standard | `["RTX PRO 6000 WS","RTX PRO 6000 S","RTX PRO 6000 Max-Q"]` | 1 | 90 | 64 | 200 | 1000 | 0.98 | 2.50 | false | `qwen38-flash-next-uncensored-huihui-v2-q4kxl` (experimental; auto-fallback `qwen38-27b-uncensored-hauhau-q8kp`) |
| max | same 3 names | 2 | 90 | 128 | 250 | 1000 | 0.97 | 4.00 | false | `glm53-flash-uncensored-huihui-iq4xs` (experimental) |

Always add these filters: `verified eq true`, `rentable eq true`, `rented eq false`, `external eq false`, `direct_port_count gte 4`, `cuda_max_good gte 12.8`, `inet_down_cost lte 0.01`, `duration gte 86400`, `allocated_storage = disk`, `order [["dph_total","asc"]]`.

Budget sanity check, assuming 60–90 h/month:

| Profile | Rate | Cost/month |
|---|---|---|
| light | $0.52/h | $31–47 |
| standard | $1.19/h | $71–107 |
| max | $2.64/h | $158–238. The top end exceeds the $200 budget, so the budget guard matters |

Add per-clock-in download time: at ~1 Gbps, 21 GB takes ~3 min, 106–111 GB ~15 min and 158 GB ~22 min. Add bandwidth: GB × `inet_down_cost`.

---------------------------------------------------------------------------------------------------------------------

## 10. RunPod REST API: possible fallback provider (part D)

Sources: `https://docs.runpod.io/llms.txt`, the v1 OpenAPI `https://rest.runpod.io/v1/openapi.json`, the v2 OpenAPI `https://api.runpod.io/v2/openapi.json`, and the "Migrate from API v1" page. All were fetched 2026-10-12.

**REST v1 (`https://rest.runpod.io/v1`) is deprecated and will be retired on 2026-11-15. Build against v2.**

- **Base and auth:** `https://api.runpod.io/v2/...` with `Authorization: Bearer <RUNPOD_API_KEY>`.
- **Errors:** RFC 9457 objects, `{"title","status","detail"}`. List responses are wrapped, e.g. `{"pods":[...]}`.
- **Create pod:** `POST /v2/pods`. The body is nested. Required: `name`. Main fields:
  - `image`, `disk` (container GB, ephemeral), `env{}`, `ports` (`["22/tcp","8080/http"]`), `entrypoint[]`/`cmd[]`/`args`
  - `gpu{ id, count, minCudaVersion, allowedCudaVersions[], minRamPerGpu, minVcpuCountPerGpu }`
  - `cloud` (`SECURE` default | `COMMUNITY`)
  - `dataCenterIds[]`
  - `mounts{ persistent{size,path} | network[...] }`
  - `startSsh` (injects `PUBLIC_KEY`), `templateId`
  - Response 201 is the Pod object: `id`, `status` (`PROVISIONING|STARTING|RUNNING|EXITED|ERROR|TERMINATED`), `cost` ($/h), `ssh{proxy{...},direct{...}}`, `runtime{uptime,gpus,ports}`, `dataCenterId`, `cudaVersion`, ...
- **GPU ids** (from the v1 enum; v2 lists them at `GET /v2/catalog/gpus`):
  - `"NVIDIA GeForce RTX 5090"`
  - `"NVIDIA RTX PRO 6000 Blackwell Workstation Edition"`
  - `"NVIDIA RTX PRO 6000 Blackwell Server Edition"`
  - `"NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition"`
  - `"NVIDIA H200"`, `"NVIDIA H200 NVL"`
- **Get / list:** `GET /v2/pods/{id}`, `GET /v2/pods`.
- **Lifecycle:** `POST /v2/pods/{id}/action` with `{"action":"start"|"stop"|"restart"|"terminate"}`. These replace the v1 `/pods/{podId}/start|stop|restart`.
- **Terminate:** `DELETE /v2/pods/{id}` (v1 returned 204), or the action `terminate`.
- **Logs:** `GET /v2/pods/{id}/logs` streams Server-Sent Events.
- **Network volumes:** `POST /v2/network-volumes` with `{name, size (GB, max 4000), dataCenter, type: STANDARD|HIGH_PERFORMANCE}`. Also `GET /v2/network-volumes[/{id}]`, `PATCH` and `DELETE /v2/network-volumes/{id}`. Attach at pod create via `mounts.network`.
  - This is the main advantage over Vast: a network volume in one data center can keep the 100–160 GB model files between clock-ins, which removes the per-session download. It costs a monthly storage fee and ties placement to that data center.
- **SSH keys:** `GET` / `PUT /v2/account/ssh-keys` lists or replaces the account's keys, which apply to new pods.
- **Inside the pod:** `RUNPOD_POD_ID`, `RUNPOD_API_KEY` ("Pod-scoped API key"), `RUNPOD_PUBLIC_IP` and `RUNPOD_TCP_PORT_22`. A self-terminate watchdog can call `DELETE https://api.runpod.io/v2/pods/$RUNPOD_POD_ID` with that key. **[UNVERIFIED]** whether the pod-scoped key may terminate its own pod.
- **Billing:** `GET /v2/billing/pods`. A per-second vs per-minute granularity statement was not verified.
