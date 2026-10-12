"""Gentle probe of a local llama-server (OpenAI-compatible) for wire-format research.

Usage:  python -I probe_llama.py <probe-name> [...]
Writes raw request/response samples to ./samples next to this file.
Rules: one request at a time, max_tokens <= 400, waits while all slots are busy.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("LLAMA_BASE", "http://127.0.0.1:8080")
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")
os.makedirs(SAMPLES, exist_ok=True)


def get_json(path, timeout=10):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def model_id():
    return get_json("/v1/models")["data"][0]["id"]


def wait_for_free_slot(max_wait=300):
    """Return id of an idle slot (prefer the one with the smallest cached prompt so we never
    evict the other app's big cache). Waits (poll 10 s, up to 5 min) while all slots are busy."""
    t0 = time.time()
    while True:
        slots = get_json("/slots")
        free = [s for s in slots if not s["is_processing"]]
        if free:
            free.sort(key=lambda s: (s.get("n_prompt_tokens", 0), -s["id"]))
            return free[0]["id"], slots
        if time.time() - t0 > max_wait:
            raise SystemExit("all slots busy for 5 minutes - giving up")
        print("all slots busy, waiting 10s ...", flush=True)
        time.sleep(10)


def save(name, data, ext):
    p = os.path.join(SAMPLES, f"{name}.{ext}")
    mode = "w"
    with open(p, mode, encoding="utf-8", newline="\n") as f:
        if isinstance(data, (dict, list)):
            json.dump(data, f, indent=2, ensure_ascii=False)
        else:
            f.write(data)
    return p


def post(name, path, body, stream=None, slot=None, raw_body=None, headers=None, timeout=180):
    """POST and capture everything. Returns dict with status, raw text, timing, parsed chunks."""
    if body is not None:
        assert body.get("max_tokens", 0) <= 400 or "max_tokens" not in body, "keep max_tokens <= 400"
    sid, _ = wait_for_free_slot()
    if body is not None and slot != "none":
        body = dict(body)
        body.setdefault("id_slot", sid if slot is None else slot)
    if body is not None:
        save(name, body, "request.json")
    data = raw_body if raw_body is not None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.time()
    first_byte = None
    first_token = None
    lines = []
    status = None
    resp_headers = {}
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        status = r.status
        resp_headers = dict(r.headers)
        if stream:
            for raw in r:
                now = time.time()
                if first_byte is None:
                    first_byte = now
                line = raw.decode("utf-8")
                lines.append(line)
                if first_token is None and line.startswith("data: ") and '"delta"' in line:
                    try:
                        ch = json.loads(line[6:])
                        d = (ch.get("choices") or [{}])[0].get("delta") or {}
                        if d.get("content") or d.get("reasoning_content") or d.get("tool_calls"):
                            first_token = now
                    except Exception:
                        pass
        else:
            txt = r.read().decode("utf-8")
            first_byte = time.time()
            lines = [txt]
    except urllib.error.HTTPError as e:
        status = e.code
        resp_headers = dict(e.headers)
        first_byte = time.time()
        lines = [e.read().decode("utf-8", "replace")]
    t1 = time.time()
    raw_text = "".join(lines)
    save(name, raw_text, "response.txt" if not stream else "sse.txt")
    meta = {
        "status": status,
        "headers": resp_headers,
        "elapsed_s": round(t1 - t0, 3),
        "ttfb_s": round(first_byte - t0, 3) if first_byte else None,
        "ttft_s": round(first_token - t0, 3) if first_token else None,
        "slot": body.get("id_slot") if body else None,
    }
    save(name, meta, "meta.json")
    return meta, raw_text


def parse_sse(raw_text):
    chunks = []
    for line in raw_text.splitlines():
        if line.startswith("data: "):
            payload = line[6:]
            if payload.strip() == "[DONE]":
                chunks.append("[DONE]")
            else:
                chunks.append(json.loads(payload))
    return chunks


def summarize_stream(raw_text):
    chunks = parse_sse(raw_text)
    reasoning, content, tcs = [], [], {}
    finish, usage, timings = None, None, None
    keys_seen = set()
    for ch in chunks:
        if ch == "[DONE]":
            continue
        if ch.get("usage"):
            usage = ch["usage"]
        if ch.get("timings"):
            timings = ch["timings"]
        for c in ch.get("choices") or []:
            d = c.get("delta") or {}
            keys_seen.update(d.keys())
            if d.get("reasoning_content"):
                reasoning.append(d["reasoning_content"])
            if d.get("content"):
                content.append(d["content"])
            for tc in d.get("tool_calls") or []:
                slot = tcs.setdefault(tc.get("index", 0), {"id": None, "name": "", "arguments": "", "n_chunks": 0})
                slot["n_chunks"] += 1
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
            if c.get("finish_reason"):
                finish = c["finish_reason"]
    return {
        "n_chunks": len(chunks),
        "delta_keys_seen": sorted(keys_seen),
        "reasoning": "".join(reasoning),
        "content": "".join(content),
        "tool_calls": tcs,
        "finish_reason": finish,
        "usage": usage,
        "timings": timings,
        "last_chunk_is_DONE": bool(chunks) and chunks[-1] == "[DONE]",
    }


def run_stream(name, body, **kw):
    body = dict(body)
    body.setdefault("model", model_id())
    body["stream"] = True
    meta, raw = post(name, "/v1/chat/completions", body, stream=True, **kw)
    if meta["status"] != 200:
        print(json.dumps(meta, indent=1))
        print(raw[:3000])
        return meta, None
    s = summarize_stream(raw)
    save(name, {"meta": meta, "summary": s}, "summary.json")
    print(json.dumps({"meta": {k: meta[k] for k in ("status", "elapsed_s", "ttfb_s", "ttft_s", "slot")}, "summary": s}, indent=1, ensure_ascii=False)[:6000])
    return meta, s


SHORT_SYS = "You are a terse assistant."

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name"}},
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_time",
            "description": "Get the current local time in an IANA timezone.",
            "parameters": {
                "type": "object",
                "properties": {"timezone": {"type": "string", "description": "IANA timezone, e.g. Europe/Paris"}},
                "required": ["timezone"],
            },
        },
    },
]


def p_basic_default():
    return run_stream("chat_default_stream", {
        "messages": [{"role": "system", "content": SHORT_SYS}, {"role": "user", "content": "What is 17*3? Answer with the number only."}],
        "max_tokens": 400,
        "stream_options": {"include_usage": True},
    })


def p_basic_nothink():
    return run_stream("chat_nothink_stream", {
        "messages": [{"role": "system", "content": SHORT_SYS}, {"role": "user", "content": "What is 17*3? Answer with the number only."}],
        "max_tokens": 100,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_reasoning_format(fmt):
    return run_stream(f"chat_reasoning_format_{fmt}", {
        "messages": [{"role": "user", "content": "What is 12+30? Answer with the number only."}],
        "max_tokens": 400,
        "stream_options": {"include_usage": True},
        "reasoning_format": fmt,
    })


def p_no_usage():
    return run_stream("chat_nothink_no_include_usage", {
        "messages": [{"role": "user", "content": "Say hi."}],
        "max_tokens": 30,
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_tools_parallel(think):
    name = "tools_parallel_" + ("think" if think else "nothink")
    body = {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Use tools when needed. Call independent tools in parallel in one turn."},
            {"role": "user", "content": "What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"},
        ],
        "tools": TOOLS,
        "max_tokens": 400,
        "stream_options": {"include_usage": True},
    }
    if not think:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    return run_stream(name, body)


def p_tools_followup():
    s = json.load(open(os.path.join(SAMPLES, "tools_parallel_nothink.summary.json"), encoding="utf-8"))["summary"]
    tcs = [s["tool_calls"][k] for k in sorted(s["tool_calls"], key=int)]
    assistant = {"role": "assistant", "content": s["content"] or None,
                 "tool_calls": [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}} for t in tcs]}
    results = []
    for t in tcs:
        res = "18°C, light rain" if t["name"] == "get_weather" else "2026-10-13 07:42 JST"
        results.append({"role": "tool", "tool_call_id": t["id"], "content": res})
    body = {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Use tools when needed. Call independent tools in parallel in one turn."},
            {"role": "user", "content": "What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"},
            assistant, *results,
        ],
        "tools": TOOLS,
        "max_tokens": 200,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    }
    return run_stream("tools_followup_nothink", body)


def p_tools_parallel_false():
    return run_stream("tools_parallel_tool_calls_false", {
        "messages": [
            {"role": "user", "content": "What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"},
        ],
        "tools": TOOLS,
        "parallel_tool_calls": False,
        "max_tokens": 300,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_tools_as_text():
    """No `tools` field, but the system prompt describes Qwen's XML tool format -> server should NOT parse; text arrives in content."""
    sysmsg = ("You can call a function get_weather(city). To call it reply ONLY with:\n"
              "<tool_call>\n<function=get_weather>\n<parameter=city>\nCITY\n</parameter>\n</function>\n</tool_call>")
    return run_stream("tools_as_text_no_tools_field", {
        "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": "Weather in Oslo?"}],
        "max_tokens": 120,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_tools_json_text():
    """Hermes JSON-style tool call text without tools field."""
    sysmsg = ("You can call a function get_weather(city). To call it reply ONLY with:\n"
              "<tool_call>\n{\"name\": \"get_weather\", \"arguments\": {\"city\": \"CITY\"}}\n</tool_call>")
    return run_stream("tools_as_text_hermes_json", {
        "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": "Weather in Oslo?"}],
        "max_tokens": 120,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def tiny_png_b64():
    import base64
    import struct
    import zlib
    w, h = 16, 16
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))  # solid red RGB

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return base64.b64encode(png).decode()


def p_image():
    return run_stream("image_data_url", {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "What single color fills this image? One word."},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + tiny_png_b64()}},
        ]}],
        "max_tokens": 50,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_image_in_tool_result():
    return run_stream("image_in_tool_result", {
        "messages": [
            {"role": "user", "content": "Read the file red.png and tell me its color in one word."},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call_img1", "type": "function", "function": {"name": "Read", "arguments": "{\"file_path\":\"red.png\"}"}}]},
            {"role": "tool", "tool_call_id": "call_img1", "content": [
                {"type": "text", "text": "Image file red.png (16x16):"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + tiny_png_b64()}},
            ]},
        ],
        "tools": [{"type": "function", "function": {"name": "Read", "description": "Read a file", "parameters": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}}}],
        "max_tokens": 50,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    })


def p_errors():
    out = {}
    mid = model_id()
    # 1 bad model name
    m, raw = post("error_bad_model", "/v1/chat/completions", {"model": "no-such-model", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5, "chat_template_kwargs": {"enable_thinking": False}})
    out["bad_model"] = (m["status"], raw[:600])
    # 2 bad JSON
    m, raw = post("error_bad_json", "/v1/chat/completions", None, raw_body=b'{"model": "x", "messages": [', stream=False)
    out["bad_json"] = (m["status"], raw[:600])
    # 3 empty messages
    m, raw = post("error_empty_messages", "/v1/chat/completions", {"model": mid, "messages": [], "max_tokens": 5})
    out["empty_messages"] = (m["status"], raw[:600])
    # 4 system message not first (template raise_exception)
    m, raw = post("error_system_not_first", "/v1/chat/completions", {"model": mid, "messages": [{"role": "user", "content": "hi"}, {"role": "system", "content": "late system"}], "max_tokens": 5, "chat_template_kwargs": {"enable_thinking": False}})
    out["system_not_first"] = (m["status"], raw[:600])
    # 5 tool message with unknown tool_call_id / no user
    m, raw = post("error_no_user_message", "/v1/chat/completions", {"model": mid, "messages": [{"role": "system", "content": "s"}], "max_tokens": 5})
    out["no_user"] = (m["status"], raw[:600])
    # 6 max_tokens larger than context (cheap way to see n_ctx validation, if any) - tiny prompt, max_tokens capped by n_predict anyway
    # 7 streaming error mid-request: bad model with stream:true
    m, raw = post("error_bad_model_stream", "/v1/chat/completions", {"model": "no-such-model", "stream": True, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5, "chat_template_kwargs": {"enable_thinking": False}}, stream=True)
    out["bad_model_stream"] = (m["status"], raw[:600])
    # 8 unknown endpoint
    try:
        urllib.request.urlopen(BASE + "/v1/nope", timeout=10)
    except urllib.error.HTTPError as e:
        out["unknown_endpoint"] = (e.code, e.read().decode()[:300])
    # 9 tokenize endpoint for estimating length
    print(json.dumps(out, indent=1))
    save("errors_summary", out, "json")


def p_errors_ctx():
    """Context overflow without sending 100k tokens: ask for a prompt that tokenizes > n_ctx would be needed.
    Instead use max_tokens > remaining ctx and n_keep tricks are unreliable; just tokenize a short text to get ratio."""
    out = {}
    req = urllib.request.Request(BASE + "/tokenize", data=json.dumps({"content": "hello world " * 50}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as r:
        toks = json.loads(r.read())["tokens"]
    out["tokenize_hello_world_x50"] = len(toks)
    req = urllib.request.Request(BASE + "/apply-template", data=json.dumps({"messages": [{"role": "user", "content": "hi"}], "chat_template_kwargs": {"enable_thinking": False}}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            out["apply_template"] = json.loads(r.read())
    except urllib.error.HTTPError as e:
        out["apply_template"] = (e.code, e.read().decode()[:300])
    print(json.dumps(out, indent=1))
    save("tokenize_apply_template", out, "json")


LONG_PROMPT_BASE = None


def long_prompt():
    # ~300 tokens of deterministic filler text
    para = ("The obsidian archive keeps a ledger of every expedition: the date it left, the crew, the cargo, the route, "
            "and the weather recorded at each waypoint. Archivists copy each entry twice and compare the copies line by line. ")
    return (para * 7).strip()


def p_perf(tag):
    return run_stream(f"perf_{tag}", {
        "messages": [{"role": "system", "content": SHORT_SYS}, {"role": "user", "content": long_prompt() + "\n\nWrite a 120-word story about the archive."}],
        "max_tokens": 300,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
        "timings_per_token": False,
    }, slot=PERF_SLOT)


PERF_SLOT = None


def p_anthropic():
    mid = model_id()
    m, raw = post("anthropic_messages", "/v1/messages", {"model": mid, "max_tokens": 30, "messages": [{"role": "user", "content": "Say hi in two words."}], "chat_template_kwargs": {"enable_thinking": False}}, stream=False, slot="none",
                  headers={"x-api-key": "none", "anthropic-version": "2023-06-01"})
    print(m["status"], raw[:2000])


def perf_messages():
    return [{"role": "system", "content": SHORT_SYS}, {"role": "user", "content": long_prompt() + "\n\nWrite a 120-word story about the archive."}]


def p_cache_extend(slot):
    """Append the exact previous assistant reply + a new user message (normal multi-turn pattern)."""
    prev = json.load(open(os.path.join(SAMPLES, "perf_B_same_prompt.summary.json"), encoding="utf-8"))["summary"]
    msgs = perf_messages() + [{"role": "assistant", "content": prev["content"]}, {"role": "user", "content": "Now give it a title. Title only."}]
    return run_stream("cache_C_extend_conversation", {"messages": msgs, "max_tokens": 30, "stream_options": {"include_usage": True},
                                                       "chat_template_kwargs": {"enable_thinking": False}}, slot=slot)


def p_cache_diverge_tail(slot):
    """Same long prefix, different final instruction (divergence near the end of the prompt)."""
    msgs = [{"role": "system", "content": SHORT_SYS}, {"role": "user", "content": long_prompt() + "\n\nList three cargo items. Comma-separated."}]
    return run_stream("cache_D_diverge_tail", {"messages": msgs, "max_tokens": 30, "stream_options": {"include_usage": True},
                                               "chat_template_kwargs": {"enable_thinking": False}}, slot=slot)


TOOL_SYS = "You are a helpful assistant. Use tools when needed. Call independent tools in parallel in one turn."
TOOL_USER = "What's the weather in Paris and what time is it in Tokyo (Asia/Tokyo)?"


def p_loop_first(slot):
    return run_stream("loop_1_toolcall_think", {
        "messages": [{"role": "system", "content": TOOL_SYS}, {"role": "user", "content": TOOL_USER}],
        "tools": TOOLS, "max_tokens": 400, "stream_options": {"include_usage": True}}, slot=slot)


def _loop_followup_msgs(keep_reasoning):
    s = json.load(open(os.path.join(SAMPLES, "loop_1_toolcall_think.summary.json"), encoding="utf-8"))["summary"]
    tcs = [s["tool_calls"][k] for k in sorted(s["tool_calls"], key=int)]
    a = {"role": "assistant", "content": s["content"] or None,
         "tool_calls": [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["arguments"]}} for t in tcs]}
    if keep_reasoning:
        a["reasoning_content"] = s["reasoning"]
    res = [{"role": "tool", "tool_call_id": t["id"], "content": "18°C, light rain" if t["name"] == "get_weather" else "2026-10-13 07:42 JST"} for t in tcs]
    return [{"role": "system", "content": TOOL_SYS}, {"role": "user", "content": TOOL_USER}, a, *res]


def p_loop_followup_keep(slot):
    return run_stream("loop_2_followup_keep_reasoning", {"messages": _loop_followup_msgs(True), "tools": TOOLS, "max_tokens": 400,
                                                          "stream_options": {"include_usage": True}}, slot=slot)


def p_loop_followup_strip(slot):
    return run_stream("loop_3_followup_strip_reasoning", {"messages": _loop_followup_msgs(False), "tools": TOOLS, "max_tokens": 400,
                                                           "stream_options": {"include_usage": True}}, slot=slot)


TYPED_TOOL = [{"type": "function", "function": {"name": "read_file", "description": "Read part of a text file.",
    "parameters": {"type": "object", "properties": {
        "path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"},
        "verbose": {"type": "boolean"}, "tags": {"type": "array", "items": {"type": "string"}},
        "options": {"type": "object", "properties": {"encoding": {"type": "string"}}}},
        "required": ["path"]}}}]


def p_tools_typed():
    return run_stream("tools_typed_params", {
        "messages": [{"role": "user", "content": "Call read_file on C:\tmp\a b.txt with offset 10, limit 20, verbose true, tags [\"x\",\"y\"], options {\"encoding\":\"utf-8\"}. Before calling, say 'Reading now.'"}],
        "tools": TYPED_TOOL, "max_tokens": 200, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False}})


def p_tools_truncated():
    return run_stream("tools_truncated_by_max_tokens", {
        "messages": [{"role": "user", "content": "Call read_file on C:\tmp\a b.txt with offset 10 and limit 20."}],
        "tools": TYPED_TOOL, "max_tokens": 14, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False}})


def p_tool_choice_required():
    return run_stream("tools_tool_choice_required", {
        "messages": [{"role": "user", "content": "Hello there!"}],
        "tools": TOOLS, "tool_choice": "required", "max_tokens": 80, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False}})


def p_non_stream_tools():
    body = {"model": model_id(), "messages": [{"role": "user", "content": "Weather in Rome?"}], "tools": TOOLS, "max_tokens": 300,
            "stream": False}
    m, raw = post("nonstream_tools_think", "/v1/chat/completions", body, stream=False)
    print(m["status"], raw[:3000])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    which = sys.argv[1]
    if which == "perf":
        PERF_SLOT = int(sys.argv[2])
        p_perf(sys.argv[3])
    elif which == "reasoning_format":
        p_reasoning_format(sys.argv[2])
    elif which in ("cache_extend", "cache_diverge_tail", "loop_first", "loop_followup_keep", "loop_followup_strip"):
        globals()["p_" + which](int(sys.argv[2]))
    elif which == "tools_parallel":
        p_tools_parallel(sys.argv[2] == "think")
    else:
        globals()["p_" + which]()
