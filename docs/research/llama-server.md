# llama-server wire behaviour: local probe results

Captured **2026-10-12** against the user's local server at `http://127.0.0.1:8080`:

| | |
|---|---|
| Build | `b11517-8a1a9b512` (`/props.build_info`; also `system_fingerprint` in every chunk) |
| Model alias | `qwen3.6-35b-a3b-uncensored` (`C:\llama.cpp\models\Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`, Q4_K_M, 34.7B params, MoE A3B, hybrid attention/recurrent) |
| Context | `n_ctx` 131072 (one unified KV pool shared by 4 slots), `n_ctx_train` 262144 |
| Slots | 4 (`total_slots`), `--kv-unified` + `--cache-idle-slots` + `--cache-ram` (8 GiB host-RAM prompt cache), all defaults |
| Chat format | `peg-native`, Jinja template from the GGUF (saved: `samples/chat_template.jinja`) |
| Reasoning | server default `reasoning_format: auto` gives `delta.reasoning_content`, and `--reasoning-preserve` (default **on**) |
| Vision | yes (`modalities.vision: true`; mmproj loaded). Video yes, audio no |
| Auth | none (no `--api-key`) |
| Extras | `/slots` on, `/metrics` off (501), `POST /props` off, web UI on, Anthropic `/v1/messages` **yes** |

How the samples were captured: `docs/research/probe_llama.py` (stdlib Python, run with `python -I`). It sends one request at a time,
checks `GET /slots` first, uses `max_tokens ≤ 400`, and pins `id_slot` to the idle slot with the smallest cache so it doesn't evict the other app's slot (see §6.4).
Raw request/response/SSE files are in `docs/research/samples/` (index in §9). Every claim below comes from a captured sample unless
it is marked **(source/docs, not captured)**.

---

## TL;DR: facts the LLM client must get right

1. **SSE framing** is plain `data: {json}\n\n` lines, then `data: [DONE]`. The first chunk is always
   `delta: {"role":"assistant","content":null}`. Without `return_progress`, that first chunk only arrives after the whole prompt
   is prefilled (TTFB = prefill time, often several seconds).
2. **Reasoning** arrives in `delta.reasoning_content` by default. Content never contains `<think>` unless the request sets
   `"reasoning_format":"none"`. In that case content starts with `<think>\n` (the server re-injects the template's generation-prompt
   opener) and has `</think>` then `\n\n` before the answer.
3. **Thinking off:** send `chat_template_kwargs: {enable_thinking: false}`. You get no reasoning deltas at all, and the template pre-fills
   `<think>\n\n</think>\n\n`.
4. **Native tool calls work, including parallel calls.** The first delta for a call carries `index`, `id` (32 random alphanumerics, not `call_…`),
   `type:"function"`, `function.name` and `arguments:"{"`. Later deltas carry only `index` and an `arguments` fragment.
   `finish_reason: "tool_calls"`. The model's XML tool syntax is converted server-side to JSON arguments with schema-typed
   values (ints, bools, arrays, objects).
5. **Text before tool calls is possible** (`content: "Reading now.\n"` followed by `tool_calls`). Tool calls come after reasoning, with nothing in between.
6. **Truncation:** if `max_tokens` cuts a tool call, you get `finish_reason: "length"` with **partial, invalid JSON** arguments.
7. **The usage chunk** (only with `stream_options.include_usage`) has `choices: []` plus `usage` plus `timings`. Without
   include_usage, `timings` rides on the `finish_reason` chunk and there is no `usage` at all.
8. **History rules enforced by the template:** a single system message, first (`developer` is mapped to system, and a second one is HTTP 500);
   at least one real user message; tool-call arguments in history must be **valid JSON strings** (otherwise HTTP 500); unknown roles
   are HTTP 500.
9. **The prompt cache is fragile on this hybrid model.** Reuse only works when the new prompt *extends exactly* what the slot holds (prompt plus
   generated tokens), or by falling back to a checkpoint near the end of an earlier prompt. Send `reasoning_content` back verbatim
   on assistant messages: measured `cache_n` 532/577 when kept vs 387/492 when stripped, and the model **stopped thinking** after we stripped it.
10. **Speed** (this PC): decode 17–25 tok/s. Prefill depends heavily on batch size: ~20–60 tok/s for tiny prompts, ~50–140 tok/s
    for 300–500 tokens, ~415–590 tok/s for ~2k tokens. A cache hit gives TTFT of about 0.14 s.
11. **The `model` field is ignored** (any name works on this single-model server). The response echoes the real alias.
12. **Aborting the HTTP stream** stops generation server-side within 0.5 s.

---

## 1. Discovery endpoints

### `GET /health`: `samples/health.txt`
```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
{"status":"ok"}
```
While the model is loading the server answers **503** with
`{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}` **(source/docs, not captured)**. Treat any non-200
as "starting/offline".

### `GET /v1/models`: `samples/v1_models.json`
Returns **both** an Ollama-style `models[]` array and an OpenAI `data[]` array:
```json
{"models":[{"name":"qwen3.6-35b-a3b-uncensored","model":"qwen3.6-35b-a3b-uncensored","capabilities":["completion","multimodal"], ...}],
 "object":"list",
 "data":[{"id":"qwen3.6-35b-a3b-uncensored","aliases":["qwen3.6-35b-a3b-uncensored"],"tags":[],"object":"model",
          "architecture":{"input_modalities":["text","image","video"],"output_modalities":["text"]},
          "created":1791803373,"owned_by":"llamacpp",
          "meta":{"vocab_type":2,"n_vocab":248320,"n_ctx":131072,"n_ctx_train":262144,"n_embd":2048,
                  "n_params":34660610688,"size":21155768832,"ftype":"Q4_K - Medium"}}]}
```
Mapping to `ModelInfo`: `id = data[0].id`; `contextLength = data[0].meta.n_ctx` (fallback: `/props.default_generation_settings.n_ctx`);
`supportsVision = architecture.input_modalities.includes('image')` (or `/props.modalities.vision`);
`supportsTools = /props.chat_template_caps.supports_tools`. `owned_by === "llamacpp"` identifies a llama.cpp server.

### `GET /props`: `samples/props.json` (abridged)
```json
{"default_generation_settings":{"params":{"temperature":0.6,"top_k":20,"top_p":0.95,"min_p":0.0,"presence_penalty":0.0,
   "max_tokens":-1,"n_predict":-1,"chat_format":"Content-only","reasoning_format":"none", ...},"n_ctx":131072},
 "total_slots":4,"model_alias":"qwen3.6-35b-a3b-uncensored","model_path":"C:\\llama.cpp\\models\\…Q4_K_M.gguf",
 "modalities":{"vision":true,"video":true,"audio":false},"media_marker":"<__media_…__>",
 "endpoint_slots":true,"endpoint_props":false,"endpoint_metrics":false,"ui":true,
 "chat_template":"…7.7k chars…",
 "chat_template_caps":{"supports_object_arguments":true,"supports_parallel_tool_calls":true,"supports_preserve_reasoning":true,
   "supports_reasoning_effort":false,"supports_string_content":true,"supports_system_role":true,"supports_tool_calls":true,
   "supports_tools":true,"supports_typed_content":true},
 "bos_token":"<|endoftext|>","eos_token":"<|im_end|>","build_info":"b11517-8a1a9b512","is_sleeping":false,"cors_proxy_enabled":false}
```
Notes: `default_generation_settings.params.reasoning_format/chat_format` show the *no-request* defaults. The per-request values
that are actually used appear in `/slots` (`chat_format: "peg-native"`, `reasoning_format: "deepseek"`,
`generation_prompt: "<|im_start|>assistant\n<think>\n"`). `is_sleeping: true` (with `--sleep-idle-seconds`) means the next request
reloads the model, so expect a long first response.

### `GET /slots`: `samples/slots.json`
An array with one object per slot:
```json
{"id":0,"n_ctx":131072,"speculative":false,"is_processing":false,"id_task":186462,
 "n_prompt_tokens":113466,"n_prompt_tokens_processed":0,"n_prompt_tokens_cache":0,
 "params":{ …sampling params of the last task…, "chat_format":"peg-native","reasoning_format":"deepseek",
            "generation_prompt":"<|im_start|>assistant\n<think>\n", "max_tokens":32768, ...},
 "next_token":[{"has_next_token":false,"has_new_line":false,"n_remain":-1,"n_decoded":0}]}
```
`is_processing` tells you whether the server is busy. While a task is running, `next_token[0].n_decoded` counts the tokens generated so far.
No prompt text is exposed. The user's other app (slot 0) had a 113k-token cache when probing started and used temperature 1.0,
presence_penalty 1.5, and max_tokens 32768.

Other endpoints seen: `POST /tokenize {"content": "...", "with_pieces": true}`, `POST /apply-template {messages, tools?, chat_template_kwargs?}`
which returns `{"prompt": "..."}` (renders the exact prompt, very useful for debugging cache misses), and
`POST /v1/messages/count_tokens` which returns `{"input_tokens":16}`. `/metrics` returns 501 with
`{"error":{"code":501,"message":"This server does not support metrics endpoint. Start it with `--metrics`","type":"not_supported_error"}}`.

---

## 2. Streaming chat completions

### 2.1 Framing (all streams)
* Response headers: `Content-Type: text/event-stream`, `Transfer-Encoding: chunked`, `Connection: close`, `X-Accel-Buffering: no`,
  `Server: llama.cpp`.
* Each event is one line, `data: {json}`, followed by a blank line. The stream ends with `data: [DONE]`, then the connection closes. No
  `event:` lines were observed. **(source/docs, not captured):** `--sse-ping-interval` defaults to 30 s, so a keep-alive can appear
  during very long prefills. Ignore any line that isn't `data:`.
* Every chunk carries `id` (constant `chatcmpl-<32 alnum>`), `created`, `model` (real alias), `system_fingerprint`, and
  `object: "chat.completion.chunk"`. `choices[0].index` is always 0.
* UTF-8 multi-byte characters (`°`, `✅`, emoji) appear in deltas. Decode the byte stream with a streaming UTF-8 decoder.

### 2.2 Default settings (thinking on): `samples/chat_default_stream.*`
Request: `{"messages":[system,user "What is 17*3? Answer with the number only."],"max_tokens":400,"stream":true,"stream_options":{"include_usage":true}}`
```
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}], …}
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"Here"}}], …}
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"'s"}}], …}
   … 290 reasoning deltas (≈1 token each) …
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"\n"}}], …}
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"5"}}], …}
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"1"}}], …}
data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}], …}
data: {"choices":[],"usage":{"completion_tokens":293,"prompt_tokens":35,"total_tokens":328,"prompt_tokens_details":{"cached_tokens":0}},
       "timings":{"cache_n":0,"prompt_n":35,"prompt_ms":993.214,"prompt_per_token_ms":28.38,"prompt_per_second":35.24,
                  "predicted_n":293,"predicted_ms":15747.07,"predicted_per_token_ms":53.93,"predicted_per_second":18.54}, …}
data: [DONE]
```
* The reasoning ends with `"\n"`. Content then starts directly (no leading `\n\n`, no tags). Each delta holds a single field: either
  `reasoning_content` or `content` or `tool_calls`. They never appear together in one chunk.
* Qwen3.6 thinks **a lot** even for trivial prompts: 109–293 reasoning tokens, which is 6–16 s at about 19 tok/s.
* `usage.prompt_tokens` **includes** cached tokens (`prompt_tokens_details.cached_tokens` is the cached portion), so it equals the
  context size used before generation.

### 2.3 `chat_template_kwargs: {"enable_thinking": false}`: `samples/chat_nothink_stream.*`
```
data: {…"delta":{"role":"assistant","content":null}}
data: {…"delta":{"content":"5"}}
data: {…"delta":{"content":"1"}}
data: {…"finish_reason":"stop","delta":{}}
data: {"choices":[],"usage":{"completion_tokens":3,"prompt_tokens":37,…},"timings":{…}}
data: [DONE]
```
No `reasoning_content` keys at all. The rendered generation prompt ends in `<think>\n\n</think>\n\n` (verified with `/apply-template`).

### 2.4 Per-request `reasoning_format` (accepted on this build): `samples/chat_reasoning_format_*.{sse.txt,summary.json}`
| request `reasoning_format` | where thinking appears | content |
|---|---|---|
| *(omitted)* | `delta.reasoning_content` | answer only |
| `"auto"` | `delta.reasoning_content` | answer only |
| `"deepseek"` | `delta.reasoning_content` | answer only |
| `"deepseek-legacy"` | `delta.reasoning_content` (streaming; tags not duplicated into content) | answer only |
| `"none"` | not separated | `"<think>\nThinking"` … `"</think>"`, `"\n\n"`, `"4"`, `"2"` |

With `"none"`, the **first content delta merges the injected opener with the first token** (`"<think>\nThinking"`). `</think>` arrived
as its own delta here, but a client must still handle tags split across deltas.

### 2.5 No `stream_options.include_usage`: `samples/chat_nothink_no_include_usage.sse.txt`
There is no usage chunk. `timings` is attached to the **finish_reason chunk**:
```
data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}], …,"timings":{"cache_n":0,"prompt_n":15,…}}
data: [DONE]
```

### 2.6 `return_progress: true` (+ `timings_per_token: true`): `samples/stream_return_progress.sse.txt`
The first byte arrives in **0.165 s** instead of after the prefill. The role chunk is **repeated** with progress objects:
```
data: {"choices":[{…"delta":{"role":"assistant","content":null}}],"timings":{…zeros…},"prompt_progress":{"total":1989,"cache":0,"processed":0,"time_ms":0}}
data: {"choices":[{…"delta":{"role":"assistant","content":null}}],"timings":{…},"prompt_progress":{"total":1989,"cache":0,"processed":1985,"time_ms":3259}}
data: {"choices":[{…"delta":{"role":"assistant","content":null}}],"timings":{…},"prompt_progress":{"total":1989,"cache":0,"processed":1989,"time_ms":3381}}
data: {"choices":[{…"delta":{"role":"assistant","content":null}}]}
data: {"choices":[{…"delta":{"content":"delta"}}],"timings":{…"predicted_n":1…}}
data: {"choices":[{"finish_reason":"stop",…"delta":{}}]}
data: {"choices":[],"usage":{…},"timings":{…}}
data: [DONE]
```
Progress is reported per ubatch: 0 → 1985 → 1989 here, where the last 4 tokens are processed separately, and that is where the
context checkpoint is taken (§6). This is the right signal for a "Processing prompt 62%" UI and for a liveness timeout during long prefills.

### 2.7 Non-streaming shape (tools + thinking): `samples/nonstream_tools_think.response.txt`
```json
{"choices":[{"finish_reason":"tool_calls","index":0,"message":{"role":"assistant","content":"",
   "reasoning_content":"Thinking Process:\n1. …✅\n",
   "tool_calls":[{"type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Rome\"}"},"id":"9VsgaiJlzBNFZmyi2IfgMGUKYaMMVxhR"}]}}],
 "created":1791803892,"model":"qwen3.6-35b-a3b-uncensored","system_fingerprint":"b11517-8a1a9b512","object":"chat.completion",
 "usage":{"completion_tokens":119,"prompt_tokens":355,"total_tokens":474,"prompt_tokens_details":{"cached_tokens":0}},
 "id":"chatcmpl-…","timings":{…}}
```
`content` is `""` (not `null`) when only tool calls are returned.

---

## 3. Tool calling

Tools used: `get_weather(city: string)` and `get_time(timezone: string)` (see `TOOLS` in `probe_llama.py`).

### 3.1 Parallel calls, thinking off: `samples/tools_parallel_nothink.sse.txt`
User: *"What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"*
```
{"delta":{"role":"assistant","content":null}}
{"delta":{"tool_calls":[{"index":0,"id":"t3kBa1xWSIhz2S58UnDtgwUTgDG3i3OC","type":"function","function":{"name":"get_weather","arguments":"{"}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"city\":\""}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Paris"}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\""}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}
{"delta":{"tool_calls":[{"index":1,"id":"IosNpNEkL0A0BfwzrZnFqKIGXKCQaO2w","type":"function","function":{"name":"get_time","arguments":"{"}}]}}
{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"timezone\":\""}}]}}
{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"Asia"}}]}}   … "/T" "ok" "yo" "\"" "}"
{"finish_reason":"tool_calls","delta":{}}
{"choices":[],"usage":{"completion_tokens":55,"prompt_tokens":393,…}}
[DONE]
```
* **Parallel tool calls happen** with or without thinking (`tools_parallel_think.*`: 140 reasoning tokens, then the same two calls).
* There is exactly one tool call per delta. `id`, `type` and `name` appear only in the first delta of each call. `arguments` is a stream of JSON
  fragments, and string values are streamed token by token. Calls are sequential: index 1 starts only after index 0 is complete.
* With thinking on, the last reasoning delta is `"\n"` and the very next delta is the first `tool_calls` delta. No content comes in between.
* Ids are 32 random alphanumerics. The template ignores ids (results are matched **by order**), but echo them back anyway.

### 3.2 Content before the calls, typed params: `samples/tools_typed_params.*`
Schema with `string`/`integer`/`boolean`/`array`/`object` params. Deltas: `content:"Reading"`, `" now"`, `"."`, `"\n"`, then
`tool_calls…`. The final arguments were
`{"path":"C:\\tmp\\test.txt","offset":10,"limit":20,"verbose":true,"tags":["x", "y"],"options":{"encoding": "utf-8"}}`,
so the server coerces XML parameter text into proper JSON types from the schema. Formatting inside nested values is
inconsistent (`["x", "y"]` with spaces), so always `JSON.parse`; never compare argument strings. (Here the model hallucinated
the path. That is model quality, not a wire issue.)

Multi-line string values (`samples/tools_multiline_string_param_nonstream.response.txt`):
`{"path":"hello.py","content":"def greet(name):\n    return f\"Hi {name}\"\n"}`. Indentation, quotes and a trailing newline were
preserved.

### 3.3 `parallel_tool_calls: false`: `samples/tools_parallel_tool_calls_false.*`
Only **one** call is emitted (`get_weather`), with `finish_reason:"tool_calls"`. Honoured.

### 3.4 `tool_choice: "required"`: `samples/tools_tool_choice_required.*`
**Not enforced** with this chat format. The model answered "Hello! How can I help you…" in content, degenerated into an emoji loop,
and hit `finish_reason:"length"` at 80 tokens with no tool call. Don't rely on `tool_choice` to force a call. (The loop also shows
why a presence penalty helps. See §8.6.)

### 3.5 Truncated tool call: `samples/tools_truncated_by_max_tokens.sse.txt`
With `max_tokens: 14`:
```
{"delta":{"tool_calls":[{"index":0,"id":"XSBAv9…","type":"function","function":{"name":"read_file","arguments":"{"}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\""}}]}}
{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"C"}}]}}
{"finish_reason":"length","delta":{}}
```
The accumulated arguments are `{"path":"C`, which is **invalid JSON**. The client must not execute this call. Server default
`n_predict` is −1 (unlimited up to context), so the agent loop should not send a small `max_tokens`.

### 3.6 Tool calls as text (no `tools` field): `samples/tools_as_text_*`
If the request has no `tools`, the server does no tool parsing. Whatever the model writes stays in `content`:
* Qwen3.6 native (XML / "qwen3_coder") form:
  `"<tool_call>\n<function=get_weather>\n<parameter=city>\nOslo\n</parameter>\n</function>\n</tool_call>"`
* Hermes JSON form (when the system prompt asks for it):
  `"<tool_call>\n{\"name\": \"get_weather\", \"arguments\": {\"city\": \"Oslo\"}}\n</tool_call>"`

`finish_reason` is `"stop"` in both cases. Note that **the Qwen3.5/3.6 family uses the XML form, not the Hermes JSON form** that the spec's
fallback mentions. The fallback parser must handle both (§8.5). The template's tool preamble (in `samples/chat_template.jinja`)
tells the model: *"If you choose to call a function ONLY reply in the following format with NO suffix: `<tool_call><function=…><parameter=…>`…"*.

### 3.7 Sending results back: `samples/tools_followup_nothink.*`
```json
[{"role":"system","content":"You are a helpful assistant. …"},
 {"role":"user","content":"What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"},
 {"role":"assistant","content":null,"tool_calls":[
    {"id":"t3kBa1xWSIhz2S58UnDtgwUTgDG3i3OC","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}},
    {"id":"IosNpNEkL0A0BfwzrZnFqKIGXKCQaO2w","type":"function","function":{"name":"get_time","arguments":"{\"timezone\":\"Asia/Tokyo\"}"}}]},
 {"role":"tool","tool_call_id":"t3kBa1xWSIhz2S58UnDtgwUTgDG3i3OC","content":"18°C, light rain"},
 {"role":"tool","tool_call_id":"IosNpNEkL0A0BfwzrZnFqKIGXKCQaO2w","content":"2026-10-13 07:42 JST"}]
```
Follow-up: `content: "The weather in Paris is currently 18°C with light rain. The time in Tokyo is 07:42 JST."`, `finish_reason:"stop"`.

Server-side rendering (`/apply-template`, `samples/apply_template_renders.json`):
```
<|im_start|>assistant\n<think>\n\n</think>\n\n<tool_call>\n<function=get_weather>\n<parameter=city>\nParis\n</parameter>\n</function>\n</tool_call>
<tool_call>\n<function=get_time>\n…</tool_call><|im_end|>\n<|im_start|>user\n<tool_response>\n18°C, light rain\n</tool_response>
<tool_response>\n2026-10-13 07:42 JST\n</tool_response><|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n
```
Consecutive tool messages are merged into **one user turn** of `<tool_response>` blocks. `tool_call_id` and the tool name are **not**
rendered, so **order is the only link** between a call and its result.

### 3.8 Template-enforced constraints (each one captured as an error)
| Violation | Result |
|---|---|
| system message not first, **or two system messages** (`samples/error_system_not_first.*`, `apply_template_role_checks.json`) | 500 `Jinja Exception: System message must be at the beginning.` |
| no user message, e.g. only system (`error_no_user_message.*`, `error_invalid_role.*`) | 500 `Jinja Exception: No user query found in messages.` |
| unknown role (`"robot"`) next to a user msg (`apply_template_role_checks.json`) | 500 `Jinja Exception: Unexpected message role.` |
| `"developer"` role | mapped to `system` by llama.cpp. Fine as the first message, but the "must be at the beginning" error anywhere else |
| trailing assistant message (prefill) | accepted. The reply continues it (`<think>\n\n</think>\n\nSure, ` is rendered as the generation start) |
| `messages: []` (`error_empty_messages.*`) | 500 `Jinja Exception: No messages provided.` |
| assistant `tool_calls[].function.arguments` not valid JSON (`error_tool_bad_arguments_json.*`) | **500** `Failed to parse tool call arguments as JSON: …` |
| image in a system message | template `raise_exception('System message cannot contain images.')` (from template source) |
| `logprobs` with `tools` and `stream` (`tools_multiline_string_param.sse.txt`) | 400 `logprobs is not supported with tools + stream` |

---

## 4. Images

* `samples/image_data_url.*`: a user message with `[{"type":"text",…},{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}]`
  using a 16×16 red PNG is **accepted**, and the model answers "Red".
* `samples/image_in_tool_result.*`: a **tool message** whose `content` is an array of text and `image_url` parts is also accepted,
  and the model answers "Red". So the `Read` tool can return screenshots or images as tool-result images.
* Token cost (`samples/image_token_cost.json`) is about **(W/32)×(H/32)** tokens: 512×512 is about 256 tokens and 1024×768 is about 768 tokens. Each took ~5 s
  to prefill cold. **Downscale to ≤1024 px on the long side** before sending (≤1568 is still OK on Vast).
* A broken data URL (`data:image/png;base64,AAAA`) gives **400** `{"error":{"code":400,"message":"Failed to load image or audio file","type":"invalid_request_error"}}`.
* Images are re-sent with each request (data URLs in history). The prompt cache still matches them because llama.cpp hashes the image
  chunks **(source/docs)**.

---

## 5. Errors

| Case | Status | Body |
|---|---|---|
| Bad `model` name (`error_bad_model.*`, `error_bad_model_stream.*`) | **200** | Ignored. Normal completion, and `model` echoes the real alias. |
| Malformed JSON body (`error_bad_json.*`) | 400 | `{"error":{"code":400,"message":"[json.exception.parse_error.101] parse error at line 1, column 29: …","type":"invalid_request_error"}}` |
| Template errors (§3.8) | 500 | `{"error":{"code":500,"message":"\n------------\nWhile executing CallExpression … Jinja Exception: …","type":"server_error"}}` |
| Bad tool-call args in history | 500 | `{"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: …","type":"server_error"}}` |
| Bad image | 400 | `{"error":{"code":400,"message":"Failed to load image or audio file","type":"invalid_request_error"}}` |
| Unknown path (`/v1/nope`) | 404 | `{"error":{"message":"File Not Found","type":"not_found_error","code":404}}` |
| `/metrics` disabled | 501 | `{"error":{"code":501,…,"type":"not_supported_error"}}` |
| **Context overflow** (not sent, per instructions) | 400 | **(source/docs, not captured)** `{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":N,"n_ctx":131072}}` |
| Model loading | 503 | **(source/docs)** `{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}` |

* **Errors before the first token come back as a plain JSON HTTP error even when `stream: true`.** This was captured for a template error
  with `stream:true`: HTTP 500 with `Content-Type: application/json`, not SSE (`error_template_stream.*`). A failure mid-stream
  would arrive as `data: {"error":{…}}` **(source/docs)**. Handle both.
* Context-overflow estimate: tokenizer ratio measured with `/tokenize`: **3.56 chars/token** for English markdown (SPEC.md, 26,657 chars
  is 7,482 tokens) and **3.82 chars/token** for TypeScript (contracts.ts). The overflow check uses the slot's `n_ctx` (131072). The
  KV pool is unified across 4 slots, so two large concurrent sessions compete for the same 131k tokens. Generation that runs
  into the context end stops with `finish_reason:"length"` (context shift is disabled by default).

---

## 6. Performance and prompt-cache behaviour

### 6.1 Measurements (RTX 3070 Ti 8 GB with MoE experts on the CPU, so prefill strongly depends on batch size)
| Sample | prompt tokens | cached | prefill | TTFT | decode |
|---|---|---|---|---|---|
| `perf_A_cold` (≈300-token prompt, thinking off) | 365 | 0 | 5237 ms (**69.7 tok/s**) | **5.32 s** | 191 tok @ **20.5 tok/s** |
| `perf_B_same_prompt` (identical request, same slot) | 365 | **361** | 4 tok, 132 ms | **0.136 s** | 198 tok @ 18.6 tok/s |
| `perf_large_prompt_cold` | 2004 | 0 | 4822 ms (**416 tok/s**) | 4.90 s | 18.3 tok/s |
| `stream_return_progress` (cold) | 1989 | 0 | 3384 ms (**588 tok/s**) | 3.55 s | 21.1 tok/s |
| tiny prompts (`chat_*`) | 15–64 | 0 | 0.4–2.1 s (20–60 tok/s) | 0.5–2.4 s | 18–25 tok/s |
| tool prompts (`tools_*`, 2 tools) | 355–393 | 0 | 2.9–8.6 s (45–130 tok/s) | 3–9.5 s | 17–24 tok/s |
| tool follow-up, appended 45 tokens | 577 | 532 | 1.50 s for 45 tokens | 1.52 s | 20.9 tok/s |
| image 1024×768 | 790 | 0 | 4.88 s | 5.0 s | |

Rules of thumb for this PC:
* A cache miss costs about **3–8 s for anything up to ~2k tokens**, then about 1.7–2.4 ms per extra token (≈60 s for 30k tokens and
  4+ minutes for 100k).
* Each agent step costs at least **~1–1.5 s** of prefill for the appended tool result, plus decode at ~20 tok/s.
* Thinking adds 100–300 tokens even for trivial steps, which is 5–15 s per step.
* Tool schemas are expensive: the Qwen tool preamble is **187 tokens**, plus about **75 tokens per small tool** (`samples/tokenizer_estimates.json`).

### 6.2 Cache experiments (all on one pinned slot)
| Experiment | Result |
|---|---|
| B: identical prompt again | `cache_n 361/365`, so a checkpoint sits **4 tokens before the end of the previous prompt** |
| C: previous prompt + exact assistant reply + new user msg (thinking off) | `cache_n 562/585`, a full extension |
| D: same long prefix, but the last user sentence differs (divergence about 10 tokens before the end) | `cache_n 11/362`, **almost a full re-prefill**. There was no checkpoint before the divergence point. |
| loop_1: first tool request (thinking on) | `cache_n 387/391`, **restored from the host-RAM prompt cache** written by another slot |
| loop_2: follow-up with `reasoning_content` **kept** on the assistant msg | `cache_n 532/577`, only the 45 new tokens processed. The model thought again (reasoning present). |
| loop_3: same follow-up with reasoning **stripped** | `cache_n 387/492`, fell back to loop_1's end-of-prompt checkpoint and re-prefilled 105 tokens. **The model produced no reasoning at all** (it imitated the empty think block in history). |

Why this happens: Qwen3.6-35B-A3B is a **hybrid** model (recurrent plus attention layers). llama.cpp cannot truncate a recurrent state
to an arbitrary position. It can only (a) continue from the exact end of what the slot holds, or (b) restore a **context checkpoint**.
Checkpoints observed here sit at the end of each processed prompt minus ~4 tokens. Server flags: `--ctx-checkpoints 32` per slot and
`--checkpoint-min-step 8192` minimum spacing (`samples/llama-server-help-b11517.txt`). Any edit to earlier messages therefore
re-prefills from the last checkpoint before the edit, and that checkpoint may be the start of the conversation.

### 6.3 Reasoning preservation (`--reasoning-preserve`, default on): `samples/apply_template_reasoning_history.json`
The server sets the template's `preserve_thinking=true`, so **every** assistant message in history is rendered as
`<|im_start|>assistant\n<think>\n{reasoning_content}\n</think>\n\n{content}`. This applies to old turns too, not just the current one:
* `reasoning_content` given → rendered with it (and `<think>…</think>` inside `content` is also extracted and rendered the same way).
* `reasoning_content` missing → rendered as an **empty** `<think>\n\n</think>\n\n` block. This changes the prompt compared with
  what was generated, so the cache diverges at that message.
* `chat_template_kwargs: {"preserve_thinking": false}` restores stock Qwen behaviour: old turns render without any think block, and only
  messages after the last user message keep theirs.

Consequence: with this server, sending `reasoning_content` back **verbatim on every assistant message** is what keeps the cache valid.
Stripping old thinking at every new user turn forces a re-prefill of the whole previous turn, tool outputs included. That is 5–60 s on this PC,
and possibly from 0 if no checkpoint is left before the first stripped message. See §8.4 for the recommendation.

### 6.4 Slot and RAM-cache behaviour (important when sharing the server with the other app)
* `--cache-idle-slots` (default on with unified KV): when any slot starts a new task, **idle slots are saved to the host-RAM prompt cache
  and cleared from VRAM**. Observed: slot 0 (the other app, 113,466 tokens) dropped to `n_prompt_tokens: 0` after our first request, and
  our own idle slots were cleared the same way.
* New requests look up the best-matching prefix in the RAM cache. loop_1 restored 387 tokens that another slot had written.
* So every request Obsidian Code sends can push the other app's big context out to RAM. Its next request restores it (fast, if it is
  still within the 8 GiB `--cache-ram`), or re-prefills it (minutes for 113k tokens) if it was evicted. Keep local concurrency to one request and
  show `/slots` busy state in the UI.
* Slot choice: the server picks the slot by prompt similarity (`--slot-prompt-similarity 0.10`), else the least recently used. Clients do **not** need
  `id_slot`. The probes used it only to protect the other app's slot.

### 6.5 Abort: `samples/abort_stream_behaviour.json`
After the client closed the stream at 31 tokens, `/slots` showed `is_processing:false` within **0.5 s**. Aborting the fetch is enough to cancel.

---

## 7. Anthropic Messages API

**Yes**, `POST /v1/messages` works (`samples/anthropic_messages.*`):
```json
{"id":"chatcmpl-cm8q…","type":"message","role":"assistant","content":[{"type":"text","text":"Hi there"}],
 "model":"qwen3.6-35b-a3b-uncensored","stop_reason":"end_turn","stop_sequence":null,
 "usage":{"cache_read_input_tokens":0,"input_tokens":18,"output_tokens":3}}
```
`POST /v1/messages/count_tokens` returns `{"input_tokens":16}`. We still use `/v1/chat/completions`. It is the common denominator for
vLLM, Vast and custom endpoints, and everything above was verified on it.

---

## 8. Implementation guidance (src/core/llm)

### 8.1 Server dialect detection (per endpoint, cached, re-checked on `refresh()`)
Normalise the base URL by stripping trailing `/` and one trailing `/v1`. Use `${root}/v1/chat/completions` and `${root}/v1/models`.
* **llamacpp** if `GET ${root}/props` returns 200 JSON with `build_info`, or `/v1/models` has `data[].owned_by === "llamacpp"`, or the
  response header is `Server: llama.cpp`. Read `n_ctx`, vision and `chat_template_caps` as in §1.
* **vllm** if `/v1/models` has `owned_by === "vllm"` (it has `max_model_len`, so `contextLength = max_model_len`).
* **generic** otherwise. Local and Vast providers are always llama-server, so treat them as llamacpp without probing if that is
  easier. Send the API key as `Authorization: Bearer <key>` (Vast; llama-server `--api-key`).

### 8.2 Request body
llamacpp dialect (local + Vast):
```jsonc
{
  "model": "<data[0].id>",                    // ignored by llama-server, but send the real id
  "messages": [...],                          // see 8.4
  "tools": [...],                             // OMIT when empty; keep identical for the whole session (cache!)
  "stream": true,
  "stream_options": { "include_usage": true },
  "chat_template_kwargs": { "enable_thinking": <req.thinking ?? true> },
  "reasoning_format": "deepseek",             // explicit: reasoning always in reasoning_content, even if the server was started with another default
  "return_progress": true,                    // immediate first byte + prefill progress (liveness)
  "cache_prompt": true,                       // default, explicit for clarity
  "temperature": ..., "top_p": ..., "top_k": 20, "presence_penalty": ...,   // see 8.6
  // "max_tokens": omit for agent turns (server default = unlimited up to n_ctx); set only for cheap complete() calls
}
```
generic/vllm: send only standard OpenAI fields plus `stream_options`. Add `chat_template_kwargs` for vllm/sglang (both support it) or
when the endpoint config opts in. If a 400 complains about an unknown field, retry once without the extras and remember that for the endpoint.

### 8.3 Stream parsing (exact rules)
**SSE reader**
1. Decode bytes with `new TextDecoder('utf-8')` in `{stream:true}` mode. Keep a string buffer and split on `/\r?\n/`, keeping the trailing partial line.
2. A line starting with `:` is a comment or ping: ignore it. `event:` sets the pending event name. A `data:` line strips `data:` plus one optional space and
   appends to the event data (join multiple data lines with `\n`). A blank line dispatches the event. At EOF, dispatch any pending data.
3. `data == "[DONE]"` → finish. Invalid JSON → skip (count it, log it). A JSON object with an `error` key → throw
   `LlmError(error.message, error.code, error.type)`. vLLM's top-level `{"object":"error","message":…}` → throw too.
4. Before reading the body: if `!res.ok` or `content-type` is not `text/event-stream`, read the body as JSON and throw using `error.message ?? message`.
   This also covers pre-stream errors on `stream:true` (§5).
5. Ignore chunks that have no `choices`, or empty `choices`, except to read `usage`/`timings`. Ignore `prompt_progress` chunks for content,
   but surface progress in an optional callback or log, since the contract has no event for it.

**Per chunk** (`c = chunk.choices?.[0]`, `d = c?.delta ?? {}`):
* Reasoning: `r = d.reasoning_content ?? d.reasoning ?? textOf(d.reasoning_details)`, using the first non-empty one, never the sum. Emit `{type:'thinking', delta:r}`
  when it is a non-empty string.
* Content: `d.content` (string, non-empty) goes into the **content state machine** below. `null` or `""` is ignored (role chunks repeat with `return_progress`).
* Tool calls: `d.tool_calls` goes into the **tool-call accumulator** below.
* `c.finish_reason` (non-null): remember it. Do not stop reading. The usage chunk and `[DONE]` follow.
* `chunk.usage`: remember `{promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens}`. Keep `chunk.timings` for logs and perf UI.

**Content state machine** (for servers or settings that leave tags in content; a no-op for llama.cpp with `reasoning_format` deepseek/auto)
* States: `text | think | toolcall`. Start in `text`. Start in `think` only if the endpoint is flagged `thinkStartsOpen` (see below) and thinking was requested.
* Keep a `pending` string. On each delta, append, then loop:
  * in `text`: find the earliest of `<think>`, and (when tools were sent) `<tool_call>` or `<function=`. Emit the text before it, then switch to `think` or
    `toolcall` (keep the tag in the toolcall buffer). If none is found, emit everything except a trailing suffix that is a **prefix of any tag**
    (e.g. `"<"`, `"<thi"`, `"<tool_ca"`), which stays in `pending`.
  * in `think`: find `</think>`. Emit the text before it as `thinking`, then switch to `text` and **drop leading whitespace** of the following text (the template
    emits `</think>\n\n`). Otherwise emit everything except a suffix that is a prefix of `</think>`.
  * in `text`: if `</think>` appears and no `<think>` was seen in this response, drop the tag and set the endpoint flag `thinkStartsOpen = true` for later
    requests. This handles servers whose template pre-fills `<think>\n`, such as vLLM without `--reasoning-parser`. The text already emitted cannot be reclassified.
  * in `toolcall`: buffer everything and emit nothing. The template forbids text after calls ("NO suffix").
* At end of stream: flush `pending` according to the state. In `toolcall`, run the **fallback parser** (8.5) on the buffer. If it yields calls, use them.
  Otherwise emit the buffer as `text`.

**Tool-call accumulator**
```ts
type Acc = { index: number; id?: string; name: string; args: string };
for (const tc of d.tool_calls) {
  let a = tc.index != null ? byIndex.get(tc.index)
        : tc.id ? byId.get(tc.id) ?? undefined : last;           // missing index: group by id, else continue the last call
  if (!a) { a = { index: tc.index ?? nextIndex++, name: '', args: '' }; register(a); }
  if (tc.id && !a.id) a.id = tc.id;
  const n = tc.function?.name; if (n && n !== a.name) a.name = a.name ? a.name + n : n;   // fragments append, repeated full names don't duplicate
  const g = tc.function?.arguments;
  if (typeof g === 'string') a.args += g; else if (g && typeof g === 'object') a.args = JSON.stringify(g);
}
```
At end of stream, ordered by `index`:
* No `name` → drop the call and log it.
* `args.trim() === ''` → `'{}'`.
* `JSON.parse(args)` fails → if `finish_reason === 'length'`, the call was **truncated**. Do not execute it. The agent should feed back
  "Your tool call was cut off by the output limit; retry with smaller arguments (e.g. split the write)". Otherwise try a light repair
  (strip text after the last `}`, close an unbalanced brace) and, if that still fails, emit the call and let the agent return an
  "invalid JSON arguments" tool error.
* A missing id gets `call_${nanoid(24)}`.
* Emit `{type:'tool_call', id, name, arguments}` once per call **after the stream ends** (simplest, and execution waits for the turn anyway).

**Done event:** `finishReason = calls.length ? 'tool_calls' : (finish_reason ?? (sawDone ? 'stop' : 'error'))`. Don't trust the server's
value for tool detection (Ollama and older servers say `stop`). If EOF arrives with neither `[DONE]` nor a finish_reason, throw "stream ended unexpectedly"
(retryable). Usage comes from the usage chunk. If it is absent, estimate with `chars/3.6` (and optionally `POST /tokenize` on llamacpp).

### 8.4 Building history (`ChatMessage[]`)
1. **One** system message, first. Put memory, environment, skills and agent list into it **once per session**, and use date-only
   granularity. Never edit it mid-session. Per-turn dynamic notes (plan-mode reminders, todo nudges, hook `additionalContext`) go
   **into the user message** (or tool result) as a `<system-reminder>` block. A second system message is HTTP 500.
2. **Tools are part of the first system block** (template line 45+). Keep the tool list identical and in the same order for the whole session.
   Changing it re-prefills everything (3.5k+ tokens ≈ 8–10 s locally). This supports the spec's plan-mode design: keep all tools listed
   and reject disallowed ones at execution time. Avoid filtering the tool list per mode. MCP tool changes cost one re-prefill, which is acceptable.
3. Assistant messages: `content` = visible text (or `null`), `tool_calls` = exactly the ids, names and arguments received. **Arguments must be valid
   JSON**; replace an invalid string with `'{}'` before sending, or llama-server returns 500.
4. Tool results: one `role:'tool'` message per call, **in call order**, directly after the assistant message. `content` can be a string or
   `[{type:'text'},{type:'image_url'}]` (images verified, §4).
5. **Reasoning:** put `reasoning_content` (verbatim, as streamed) on every assistant message of the **current turn** (after the last user
   message). This is required for cache reuse (§6.2 loop_2 vs loop_3), and it keeps the model thinking (loop_3 stopped reasoning once it was stripped).
   For **older turns**, see the decision below.
6. Images: downscale to ≤1024 px on the long side (≈768 tokens). Never put images in the system message. Strip images and replace them with `[image omitted]`
   when `supportsVision` is false.
7. There must be at least one non-tool-response user message (subagents and headless runs must start with a user message). Never send
   `developer` or a second `system` message: merge them into the first system message. Don't end the list with an assistant message
   unless you want a prefill.
8. Tool-output truncation must happen **when the result is first recorded**, never retroactively. Rewriting old messages re-prefills from the edit point.

**Decision recorded (deviation from SPEC §4.1 "Strip previous turns' thinking"):** for the `llamacpp` dialect, keep `reasoning_content`
on *all* assistant messages until the next compaction (compaction re-prefills anyway, and the summary replaces old turns). Reasons:
llama-server renders preserved reasoning by default, stripping it diverges the prompt at the previous turn's first assistant message,
and on this hybrid model that means re-prefilling the entire previous turn, or more if no checkpoint is left. The context cost is
about 100–500 tokens per assistant step, which auto-compaction at 80% absorbs. For generic/vLLM endpoints, follow the spec and strip older-turn
reasoning (stock Qwen templates drop it anyway, and GPU servers re-prefill fast). Also don't send `reasoning_content` to generic endpoints
unless the endpoint is known to accept it. If the agent-core owner prefers the spec as written, strip only at compaction boundaries.

### 8.5 Fallback text tool-call parser (content outside thinking, only when `tools` were sent and no native calls arrived)
Blocks: every `<tool_call>…</tool_call>`. Accept a missing final `</tool_call>` at end of text, and bare `<function=…>…</function>` without a wrapper.
For each block body `b = trimmed`:
1. **Hermes JSON**: `b` starts with `{`. `JSON.parse(b)` gives `{name, arguments | parameters}`. Arguments may be an object or a JSON string.
2. **Qwen3-Coder / Qwen3.5+ XML**: `/<function=([^>\n]+)>([\s\S]*?)(?:<\/function>|$)/`. Params come from
   `/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g`, stripping **exactly one** leading and one trailing `\n` (the template writes
   `<parameter=k>\n{value}\n</parameter>`). Coerce types using the tool's JSON schema:
   `integer|number` → `Number(v)` if finite; `boolean` → `v.trim() === 'true'`; `array|object` → `JSON.parse(v)` (fall back to the raw string);
   `string` → raw text as-is (never JSON.parse a string-typed value). For untyped or union types, JSON.parse only if `v` looks like JSON.
3. **GLM-4.5+ style** (catalog "max" profile): body is `NAME\n<arg_key>k</arg_key>\n<arg_value>v</arg_value>…`, with the same coercion.
4. If nothing parses, the block is plain text. Ignore anything that looks like a tool call inside **reasoning**.

The arguments you build must be `JSON.stringify(obj)`. Generate ids `call_${nanoid(24)}`.

### 8.6 Sampling defaults (`src/core/llm` model profiles; the contract only carries temperature/topP)
Qwen3.6 guidance plus observed behaviour (the emoji loop in §3.4 happened at temperature 0.6 with presence_penalty 0):
* thinking on: `temperature 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 0–1.0`. The other app uses 1.0 / 1.5.
* thinking off: `temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.0–1.5`.
* `complete()` utility calls (titles, WebFetch extraction): thinking **off**, `max_tokens` 64–1024, short prompts. They don't need the
  session's tools or system prompt. They will evict idle slots to RAM (§6.4), which is cheap.

### 8.7 Timeouts, abort, liveness
* Use an **idle** timeout, not a total one: abort if no bytes arrive for 120 s. With `return_progress` the first byte arrives immediately and
  progress chunks arrive every ubatch (~2k tokens). Without it, TTFB equals the full prefill (≈4 min for a 100k-token cold prompt here).
* Abort through `AbortController` on fetch. The server stops within 0.5 s (§6.5). Mark tools `interrupted` as the spec says.
* Busy detection (llamacpp): `GET /slots`. If every slot shows `is_processing`, show "local server busy" (requests queue server-side; they don't fail).
  Run at most one concurrent request to the local server (two at most for E2E, per spec).
* Retry policy: network errors, 503 (loading), and "stream ended unexpectedly" get 2 retries with backoff. 400/500 template or JSON errors
  are bugs, so don't retry them, but surface them. Context overflow (see 8.8) triggers compact and retries once.

### 8.8 Error classification (all servers)
```
status/body → kind
  fetch failed / ECONNREFUSED          → 'offline'      (provider offline)
  503 or "Loading model"              → 'loading'      (retry with backoff)
  /exceed_context_size_error|context_length_exceeded|maximum context length|context size|too many tokens|prompt is too long/i
                                       → 'context_overflow' (auto-compact, retry once)
  401/403                              → 'auth'         (Vast/custom key wrong)
  400 + /logprobs is not supported/   → 'bad_request'
  500 + /Jinja Exception|Failed to parse tool call arguments/ → 'bad_history' (bug in history building; log the request)
  other                                → 'server_error'
message = body.error?.message ?? body.message ?? text
```

### 8.9 vLLM and other OpenAI-compatible servers: differences to handle (source/docs, not captured)
* **Reasoning field name:** llama.cpp, SGLang, LM Studio, DeepSeek API and older vLLM use `reasoning_content`. Newer vLLM, OpenRouter, Ollama and Groq use `reasoning`.
  OpenRouter also sends `reasoning_details[]` (`{type:"reasoning.text", text}`). Accept all, as in 8.3, and never double count when a server sends two.
* vLLM only separates reasoning when started with `--reasoning-parser qwen3` (or `deepseek_r1`). Otherwise Qwen output arrives in `content` as
  reasoning text followed by `</think>` with **no opening tag**. That is the `thinkStartsOpen` path.
* vLLM only emits native tool calls with `--enable-auto-tool-choice --tool-call-parser qwen3_coder` (Qwen3.5/3.6/Coder XML), `hermes`
  (Qwen2.5/Qwen3 JSON), or `glm45`. Without them, calls arrive as text and the fallback parser handles them. vLLM's first tool delta often
  has `arguments:""`, and some servers send the whole call in one delta. The accumulator handles both.
* Usage: vLLM supports `include_usage` (final chunk with `choices: []`), and some servers attach usage to the last choice chunk. Some never send it, so estimate.
* `finish_reason` may be `stop` even with tool calls (Ollama), or `function_call` (legacy). Decide from the accumulated calls.
* Errors: vLLM uses `{"object":"error","message":"…","type":"BadRequestError","param":null,"code":400}` (top level) and newer versions use `{"error":{…}}`.
  Context overflow message: "This model's maximum context length is N tokens. However, you requested M tokens…". OpenRouter sends
  `: OPENROUTER PROCESSING` SSE comments, which the reader ignores.
* Strict OpenAI-proper endpoints reject unknown body fields. Only send `chat_template_kwargs`, `reasoning_format`, `return_progress`,
  `cache_prompt`, `top_k`, `min_p` and `presence_penalty` to llamacpp/vllm/sglang dialects.
* Images on a text-only model give 400. Mark `supportsVision=false` for that endpoint/model and strip images.

### 8.10 Mock server (tests/fixtures/mock-llm) should reproduce
The leading role chunk (`content:null`), reasoning_content deltas, content deltas, parallel tool_calls deltas exactly as in §3.1
(id/name only in the first delta, `"{"` as the first argument fragment), `finish_reason` chunk with an empty delta, usage chunk with `choices: []`
plus `timings`, `[DONE]`, the `return_progress` repeated role chunks, a `reasoning_format:none` style stream (`<think>\n…</think>\n\n` in content,
tags split across deltas), XML and Hermes `<tool_call>` text-form content, a truncated call with `finish_reason:"length"`, and pre-stream
HTTP JSON errors (400/500) as well as an in-stream `data: {"error":…}`.

---

## 9. Sample index (`docs/research/samples/`)
Each probe writes `<name>.request.json`, `<name>.sse.txt` (raw SSE) or `<name>.response.txt`, `<name>.meta.json` (status, headers,
TTFB/TTFT, slot), and for streams `<name>.summary.json` (reassembled reasoning, content, tool calls, usage, timings).

| Topic | Files |
|---|---|
| Discovery | `v1_models.json`, `props.json`, `health.txt`, `slots.json`, `chat_template.jinja`, `llama-server-help-b11517.txt` |
| Basic streaming | `chat_default_stream.*`, `chat_nothink_stream.*`, `chat_nothink_no_include_usage.*`, `stream_return_progress.*` |
| Reasoning formats | `chat_reasoning_format_{none,auto,deepseek,deepseek-legacy}.*` |
| Tools | `tools_parallel_{nothink,think}.*`, `tools_followup_nothink.*`, `tools_parallel_tool_calls_false.*`, `tools_tool_choice_required.*`, `tools_typed_params.*`, `tools_truncated_by_max_tokens.*`, `tools_as_text_{no_tools_field,hermes_json}.*`, `tools_multiline_string_param*`, `nonstream_tools_think.*` |
| Images | `image_data_url.*`, `image_in_tool_result.*`, `image_tokens_{512x512,1024x768}.*`, `image_token_cost.json` |
| Errors | `error_*.*`, `errors_summary.json` |
| Performance / cache | `perf_A_cold.*`, `perf_B_same_prompt.*`, `perf_large_prompt_cold.*`, `cache_C_extend_conversation.*`, `cache_D_diverge_tail.*`, `loop_{1,2,3}_*.*`, `abort_stream_behaviour.json` |
| Template rendering | `apply_template_renders.json`, `apply_template_reasoning_history.json`, `apply_template_role_checks.json`, `tokenize_apply_template.json`, `tokenizer_estimates.json` |
| Anthropic | `anthropic_messages.*` |

To reproduce a probe, run `python -I docs/research/probe_llama.py <probe>` (see the `p_*` functions; `perf <slot> <tag>`, `cache_extend <slot>`, and so on).
