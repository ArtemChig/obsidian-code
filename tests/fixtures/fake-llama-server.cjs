// Fake llama-server for the real-bash bootstrap.sh tests (tests/unit/gpu/server-scripts.test.ts). Owner: gpu.
// Started by bootstrap.sh (through a tiny bash wrapper, OC_LLAMA_BIN) with the real llama-server arguments.
//   FAKE_LLAMA_RULE=no-spec-vision  fails to load (exit 1) whenever it sees --spec-type or --mmproj
//   FAKE_LLAMA_RULE=fa-off-only     fails to load unless it gets "--flash-attn off"
//   FAKE_LLAMA_RULE=never           always fails to load
//   FAKE_LLAMA_RULE=ok              always loads (any other unknown rule too)
//   `--version` prints a version and exits 0 (bootstrap.sh's preflight), without being recorded.
// Otherwise it serves GET /health on --host/--port until the file FAKE_LLAMA_STOP exists (or 60 s pass).
// Every start appends its argv (JSON) to FAKE_LLAMA_CALLS.
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const args = process.argv.slice(2);
// bootstrap.sh's preflight (`llama-server --version`, before the download): like llama.cpp, print and exit 0. Not
// recorded in FAKE_LLAMA_CALLS (those are the load attempts).
if (args.includes('--version')) {
  console.error('version: 11561 (fake)');
  console.error('built with cc for x86_64-linux-gnu');
  process.exit(0);
}
const rule = process.env.FAKE_LLAMA_RULE || 'no-spec-vision';
if (process.env.FAKE_LLAMA_CALLS) fs.appendFileSync(process.env.FAKE_LLAMA_CALLS, `${JSON.stringify(args)}\n`);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

console.log('build: 11561 (fake) with cc for x86_64-linux-gnu');
console.log(`llama_model_loader: loaded meta data with 52 key-value pairs and 866 tensors from ${value('-m')}`);
let reason = null;
if (rule === 'never') reason = 'fake: this build cannot load the model';
else if (rule === 'fa-off-only' && value('--flash-attn') !== 'off') reason = 'fake: flash attention is not supported for this architecture';
else if (rule === 'no-spec-vision' && args.includes('--spec-type')) reason = 'fake: failed to create the MTP draft context';
else if (rule === 'no-spec-vision' && args.includes('--mmproj')) reason = 'fake: failed to load the multimodal projector';
if (reason) {
  console.error(`llama_init_from_model: ${reason}`);
  console.error('main: exiting due to model loading error');
  process.exit(1);
}

const stop = process.env.FAKE_LLAMA_STOP;
const t0 = Date.now();
const server = http.createServer((req, res) => {
  if (req.url === '/health') res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
  else res.writeHead(404).end();
});
server.listen(Number(value('--port') || 8080), value('--host') || '127.0.0.1', () => {
  console.log(`main: server is listening on http://${value('--host')}:${value('--port')} - starting the main loop`);
});
setInterval(() => {
  if ((stop && fs.existsSync(stop)) || Date.now() - t0 > 60_000) process.exit(0);
}, 200);
