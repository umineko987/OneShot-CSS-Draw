import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, install } from 'undici';
import { FileCredentials, createRedactor } from './credentials.mjs';
import { loadModels, readJson } from './models.mjs';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

const root = import.meta.dirname;
const project = path.dirname(root);
const runsRoot = path.join(project, 'runs');
const configFile = path.join(root, 'config.json');
const modelsFile = path.join(root, '.agent/models.json');
const credentials = new FileCredentials(path.join(root, '.agent/auth.json'));
const { remember, redact } = createRedactor();
const token = randomBytes(32).toString('hex');
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const builtinProviderIds = new Set(builtinProviders().map(provider => provider.id));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.css', ['app.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']]]);
let job = null;
let auth = null;
let mutating = false;
let closing = false;

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} 无效。`);
  return value.trim();
}
function proxyAddress(value) {
  if (!value) return '';
  const address = text(value, '代理地址');
  let url;
  try { url = new URL(address.includes('://') ? address : `http://${address}`); }
  catch { fail('请输入 HTTP/HTTPS 代理地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('只支持 HTTP/HTTPS 代理。');
  remember(decodeURIComponent(url.password));
  return url.href;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function inside(base, file) {
  const relative = path.relative(fs.realpathSync(base), fs.realpathSync(file));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('不允许访问目录外的文件。', 403);
  return file;
}
function directories(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const encodeId = relative => Buffer.from(relative).toString('base64url');
function runDirectory(id) {
  const relative = Buffer.from(id, 'base64url').toString('utf8');
  if (encodeId(relative) !== id || relative.split('/').length !== 3 || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) fail('无效轮次。', 404);
  try { return inside(runsRoot, path.join(runsRoot, relative)); }
  catch (error) { if (error.code === 'ENOENT') fail('轮次不存在。', 404); throw error; }
}
function hasOutput(dir) {
  try {
    const file = fs.statSync(inside(dir, path.join(dir, 'work/index.html')));
    return file.isFile() && file.size > 0;
  }
  catch { return false; }
}
function runSummary(dir, id) {
  let meta;
  try { meta = readJson(inside(dir, path.join(dir, 'meta.json'))); }
  catch { return null; } // A CLI process may be updating metadata; retry on the next poll.
  const active = job?.runId === id && job.process;
  const parts = Buffer.from(id, 'base64url').toString('utf8').split('/');
  return {
    id, caseId: meta.caseId ?? parts[0], round: parts[2], path: `runs/${parts.join('/')}`,
    provider: meta.requestedProvider ?? meta.model?.provider ?? '',
    model: meta.requestedModel ?? meta.model?.id ?? '',
    thinking: meta.effectiveThinking ?? meta.requestedThinking,
    requestedThinking: meta.requestedThinking, status: meta.status ?? 'legacy',
    createdAt: meta.createdAt, finishedAt: meta.finishedAt,
    width: meta.width, height: meta.height, error: meta.error,
    turns: active ? job.progress.turns : meta.turns,
    httpRequests: active ? job.progress.httpRequests : meta.httpRequests,
    usage: active ? job.progress.usage : meta.usage,
    transport: meta.transportCompatibility, output: hasOutput(dir),
  };
}
function history() {
  const result = [];
  for (const caseId of directories(runsRoot)) {
    for (const channel of directories(path.join(runsRoot, caseId))) {
      for (const round of directories(path.join(runsRoot, caseId, channel))) {
        const relative = `${caseId}/${channel}/${round}`;
        const summary = runSummary(path.join(runsRoot, relative), encodeId(relative));
        if (summary) result.push(summary);
      }
    }
  }
  return result.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.path.localeCompare(a.path));
}
function tail(file, limit = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    let value = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) value = value.slice(value.indexOf('\n') + 1);
    return { text: value, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}
const clip = (value, limit = 4000) => value.length > limit ? `${value.slice(0, limit)}\n…（内容截断）` : value;
function messageText(message) {
  if (message.role === 'user') return '固定任务与参考图（图片数据省略）';
  if (typeof message.content === 'string') return clip(message.content);
  return clip((message.content ?? []).map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return `[思考] ${block.thinking}`;
    if (block.type === 'toolCall') return `[调用 ${block.name}] ${clip(JSON.stringify(block.arguments ?? {}), 1600)}`;
    if (block.type === 'image') return '[图像]';
    return '';
  }).join('\n'));
}
function sessionEvents(dir) {
  const sessionDir = path.join(dir, 'sessions');
  let files;
  try { files = fs.readdirSync(inside(dir, sessionDir)).filter(name => name.endsWith('.jsonl')).sort(); }
  catch { return { events: [], truncated: false }; }
  if (!files.length) return { events: [], truncated: false };
  const data = tail(inside(dir, path.join(sessionDir, files.at(-1))));
  const events = [];
  for (const line of data.text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'message' && event.message) {
      events.push({ kind: event.message.toolName ?? event.message.role, time: event.message.timestamp ?? event.timestamp,
        text: messageText(event.message), error: event.message.isError || event.message.stopReason === 'error' });
    } else if (event.type === 'http_request') {
      events.push({ kind: 'HTTP →', time: event.timestamp, text: `#${event.number} ${event.endpoint}\n${JSON.stringify(event.parameters ?? {}, null, 2)}` });
    } else if (event.type === 'http_response') {
      events.push({ kind: 'HTTP ←', text: `#${event.number} · ${event.status}`, error: event.status >= 400 });
    } else if (event.type === 'run_end') events.push({ kind: '结束', time: event.timestamp, text: event.status });
  }
  return { events: events.slice(-80), truncated: data.truncated || events.length > 80 };
}
function publicJob() {
  if (!job) return null;
  const { process, output, ...info } = job;
  return { ...info, active: !!process, console: redact(output) };
}
function authActive() { return auth?.state === 'authorizing'; }
function idle() {
  if (job?.process) fail('有用例正在运行，请结束后再修改配置或鉴权。', 409);
  if (authActive()) fail('有鉴权正在进行，请先完成或取消。', 409);
}
async function rememberCredentials() {
  for (const value of Object.values(await credentials.load())) {
    for (const key of ['key', 'access', 'refresh']) remember(value[key]);
  }
}
async function modelCatalog() {
  await rememberCredentials();
  return loadModels(modelsFile, credentials, remember);
}
function transportOptions(config) {
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'transports')).filter(file => file.endsWith('.mjs')).map(file => `./transports/${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [...new Set([...files, ...Object.values(config.transports ?? {})])];
}
async function catalog() {
  const models = await modelCatalog();
  const stored = new Map((await credentials.list()).map(item => [item.providerId, item.type]));
  const providers = await Promise.all(models.getProviders().map(async provider => {
    let available, error;
    try { available = await models.checkAuth(provider.id); }
    catch (cause) { error = cause.message; }
    return { id: provider.id, name: provider.name ?? provider.id,
      type: builtinProviderIds.has(provider.id) ? 'builtin' : 'third_party',
      methods: [provider.auth.apiKey?.login && 'api_key', provider.auth.oauth && 'oauth'].filter(Boolean),
      auth: available ?? null, stored: stored.get(provider.id), error,
      authName: provider.auth.apiKey?.name,
      models: provider.getModels().map(model => ({ id: model.id, name: model.name, input: model.input,
        reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, api: model.api })),
    };
  }));
  const config = readJson(configFile, {});
  const cases = Object.entries(readJson(path.join(root, 'cases.json'))).map(([id, value]) => ({ id, width: value.width, height: value.height }));
  return { providers, config: { provider: config.provider, model: config.model, thinking: config.thinking ?? 'high', transports: config.transports ?? {} },
    cases, transports: transportOptions(config) };
}
async function validateSelection(data) {
  const provider = text(data.provider, '渠道');
  const model = text(data.model, '模型');
  if (!levels.includes(data.thinking)) fail('无效 thinking 等级。');
  const models = await modelCatalog();
  const selected = models.getModel(provider, model);
  if (!selected) fail('渠道或模型不存在。');
  if (!selected.input.includes('image')) fail('纯文本模型不能运行图像用例，请选择 vision 模型。');
  return { provider, model, thinking: data.thinking, models };
}
async function saveConfig(data) {
  idle();
  const { provider, model, thinking } = await validateSelection(data);
  const config = readJson(configFile, {});
  if (data.transport && !transportOptions(config).includes(data.transport)) fail('只能选择已存在的传输模块。');
  config.provider = provider; config.model = model; config.thinking = thinking;
  config.transports ??= {};
  if (data.transport) config.transports[provider] = data.transport;
  else delete config.transports[provider];
  writeJson(configFile, config);
  return { ok: true };
}
async function saveProvider(data) {
  idle();
  const id = text(data.id, '渠道 ID', 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail('渠道 ID 只允许小写字母、数字、下划线和连字符。');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(data.api)) fail('请选择支持的 API 协议。');
  const baseUrl = text(data.baseUrl, 'API 地址');
  let url;
  try { url = new URL(baseUrl); } catch { fail('API 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('API 地址必须是 HTTP/HTTPS，不能包含用户名或密码。');
  const modelId = text(data.model, '模型 ID');
  for (const field of ['contextWindow', 'maxTokens']) {
    if (!Number.isSafeInteger(data[field]) || data[field] <= 0) fail(`${field} 必须是正整数。`);
  }
  if (data.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(data.apiKeyEnv)) fail('密钥环境变量名无效。');
  const settings = readJson(modelsFile, { providers: {} });
  const existing = settings.providers[id] ?? {};
  const entries = existing.models ?? [];
  const previous = entries.find(model => model.id === modelId);
  const entry = { ...previous, id: modelId, api: data.api, baseUrl, reasoning: !!data.reasoning,
    input: ['text', 'image'], contextWindow: data.contextWindow, maxTokens: data.maxTokens };
  settings.providers[id] = { ...existing, api: data.api, baseUrl, authHeader: !!data.authHeader,
    ...(data.apiKeyEnv ? { apiKeyEnv: data.apiKeyEnv } : {}), models: [...entries.filter(model => model.id !== modelId), entry] };
  writeJson(modelsFile, settings);
  return { ok: true, provider: id, model: modelId };
}
async function deleteProvider(data) {
  idle();
  const id = text(data.provider, '渠道', 100);
  if (builtinProviderIds.has(id)) fail('Pi 内置渠道不能删除。', 403);
  if (data.confirm !== true) fail('删除第三方渠道需要明确确认。');
  const settings = readJson(modelsFile, { providers: {} });
  if (!Object.hasOwn(settings.providers, id)) fail('第三方渠道不存在。', 404);
  const config = readJson(configFile, {});
  delete settings.providers[id];
  if (config.provider === id) { delete config.provider; delete config.model; }
  delete config.transports?.[id];
  await credentials.delete(id);
  writeJson(configFile, config);
  writeJson(modelsFile, settings);
  if (auth?.provider === id) auth = null;
  return { ok: true };
}
async function startRun(data) {
  idle();
  if (data.confirm !== true) fail('启动正式用例需要明确确认。');
  const caseId = text(data.caseId, '用例');
  if (!Object.hasOwn(readJson(path.join(root, 'cases.json')), caseId)) fail('用例不存在。');
  const { provider, model, thinking, models } = await validateSelection(data);
  if (!await models.checkAuth(provider)) fail('该渠道尚未配置鉴权。');
  const transport = readJson(configFile, {}).transports?.[provider] ?? '';
  if (data.transport !== undefined && data.transport !== transport) fail('传输模块配置已变化，请保存配置或刷新页面。', 409);
  const proxy = proxyAddress(data.proxy);
  const args = [path.join(root, 'run.mjs'), caseId, '--provider', provider, '--model', model, '--thinking', thinking];
  if (proxy) args.push('--proxy', proxy);
  if (closing) fail('服务正在关闭。', 503);
  const child = spawn(process.execPath, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const current = job = { id: randomUUID(), process: child, caseId, provider, model, thinking,
    startedAt: new Date().toISOString(), state: 'starting', runId: null, progress: {}, output: '' };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { current.output = (current.output + chunk).slice(-120000); });
  }
  child.on('message', event => {
    if (event.type === 'run_started') { current.runId = encodeId(event.relative); if (current.state !== 'stopping') current.state = 'running'; }
    if (event.type === 'progress') current.progress = event.progress;
  });
  child.on('error', error => { current.output += `\n${redact(error.message)}`; });
  child.on('close', (code, signal) => {
    current.state = current.state === 'stopping' || code === 130 ? 'aborted' : code === 0 ? 'completed' : 'failed';
    current.exitCode = code; current.signal = signal; current.finishedAt = new Date().toISOString(); current.process = null;
  });
  return publicJob();
}
function stopRun(data) {
  if (!job?.process || data.id !== job.id) fail('该运行已结束或不属于当前服务。', 409);
  job.state = 'stopping';
  job.process.kill('SIGINT');
  return { ok: true };
}
function publicAuth() {
  if (!auth) return null;
  const { id, provider, method, state, events, prompt, error } = auth;
  return { id, provider, method, state, events, prompt, error };
}
async function startAuth(data) {
  idle();
  const models = await modelCatalog();
  const provider = models.getProvider(text(data.provider, '渠道'));
  if (!provider) fail('渠道不存在。');
  const method = data.method;
  if (!(method === 'api_key' && provider.auth.apiKey?.login) && !(method === 'oauth' && provider.auth.oauth)) fail('该渠道不支持此交互式鉴权方式，请使用它的环境配置。');
  const proxy = proxyAddress(data.proxy);
  if (closing) fail('服务正在关闭。', 503);
  const controller = new AbortController();
  const current = auth = { id: randomUUID(), provider: provider.id, method, state: 'authorizing', events: [], prompt: null, controller };
  const dispatcher = new EnvHttpProxyAgent(proxy ? { httpProxy: proxy, httpsProxy: proxy } : {});
  const previousDispatcher = getGlobalDispatcher();
  install();
  setGlobalDispatcher(dispatcher);
  current.done = models.login(provider.id, method, {
    signal: controller.signal,
    notify(event) { current.events = [...current.events, event].slice(-20); },
    prompt(prompt) {
      const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
      if (signal.aborted) return Promise.reject(signal.reason);
      const { signal: ignored, ...fields } = prompt;
      const promptId = randomUUID();
      current.prompt = { ...fields, id: promptId };
      return new Promise((resolve, reject) => {
        const clear = () => { signal.removeEventListener('abort', cancel); current.prompt = null; current.answer = null; };
        const cancel = () => { clear(); reject(signal.reason); };
        current.answer = answer => { clear(); resolve(answer); };
        signal.addEventListener('abort', cancel, { once: true });
      });
    },
  }).then(credential => {
    for (const key of ['key', 'access', 'refresh']) remember(credential[key]);
    current.state = 'completed';
  }).catch(error => {
    current.state = controller.signal.aborted ? 'aborted' : 'failed'; current.error = redact(error.message);
  }).finally(async () => {
    current.prompt = null; current.answer = null;
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.destroy();
  });
  return publicAuth();
}
async function authAction(action, data) {
  if (!authActive() || data.id !== auth.id) fail('鉴权已结束，请重新开始。', 409);
  if (action === 'cancel') { auth.controller.abort(); return { ok: true }; }
  if (!auth.prompt || auth.prompt.id !== data.promptId || !auth.answer) fail('该输入步骤已结束，请等待下一步。', 409);
  if (typeof data.answer !== 'string' || data.answer.length > 16384) fail('输入无效。');
  const answer = data.answer.trim(); // Some provider prompts explicitly accept Enter with no input.
  if (auth.prompt.type === 'select' && !auth.prompt.options.some(option => option.id === answer)) fail('请选择有效选项。');
  if (['secret', 'manual_code'].includes(auth.prompt.type)) remember(answer);
  auth.answer(answer);
  return { ok: true };
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('请求必须为 JSON。', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) fail('请求过大。', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('无效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('无效请求。');
  return value;
}
function send(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(redact(JSON.stringify(value)));
}
function image(res, base, file) {
  const extension = path.extname(file).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
  if (!mime) fail('不支持的参考图格式。', 404);
  const bytes = fs.readFileSync(inside(base, file));
  res.writeHead(200, { 'Content-Type': mime }); res.end(bytes);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  try {
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) fail('仅接受本机地址。', 403);
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) fail('拒绝跨站请求。', 403);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      const content = fs.readFileSync(path.join(root, 'web', file), 'utf8').replace('{{SESSION_TOKEN}}', token);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
    }
    if (req.headers['x-harness-token'] !== token) fail('页面会话已失效，请刷新。', 403);
    await rememberCredentials();
    if (req.method === 'GET') {
      if (url.pathname === '/api/catalog') return send(res, await catalog());
      if (url.pathname === '/api/runs') return send(res, { runs: history(), job: publicJob() });
      if (url.pathname === '/api/auth') return send(res, publicAuth());
      const match = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(reference|preview))?$/);
      if (match) {
        const dir = runDirectory(match[1]);
        const summary = runSummary(dir, match[1]);
        if (!summary) fail('元数据暂不可读，请稍后重试。', 409);
        if (match[2] === 'reference') {
          const name = fs.readdirSync(dir).find(file => /^reference\.(png|jpe?g|webp|gif)$/i.test(file));
          if (!name) fail('没有参考图。', 404);
          return image(res, dir, path.join(dir, name));
        }
        if (match[2] === 'preview') {
          if (summary.status === 'running' || (job?.process && job.runId === match[1])) fail('运行结束后才能预览。', 409);
          const file = inside(dir, path.join(dir, 'work/index.html'));
          if (fs.statSync(file).size > 8 * 1024 * 1024) fail('结果超过 8 MB，请在本地查看。', 413);
          return send(res, { html: fs.readFileSync(file, 'utf8') });
        }
        return send(res, { run: summary, ...sessionEvents(dir), console: job?.runId === match[1] ? publicJob().console : '' });
      }
      const caseMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/reference$/);
      if (caseMatch) {
        const testCase = readJson(path.join(root, 'cases.json'))[caseMatch[1]];
        if (!testCase) fail('用例不存在。', 404);
        return image(res, project, path.join(project, testCase.image));
      }
    }
    if (req.method === 'POST') {
      if (closing) fail('服务正在关闭。', 503);
      const data = await body(req);
      if (mutating) fail('操作正在处理中，请稍后重试。', 409);
      mutating = true;
      try {
        if (url.pathname === '/api/config') return send(res, await saveConfig(data));
        if (url.pathname === '/api/providers') return send(res, await saveProvider(data));
        if (url.pathname === '/api/providers/delete') return send(res, await deleteProvider(data));
        if (url.pathname === '/api/runs') return send(res, await startRun(data), 202);
        if (url.pathname === '/api/runs/stop') return send(res, stopRun(data));
        if (url.pathname === '/api/auth/start') return send(res, await startAuth(data), 202);
        if (url.pathname === '/api/auth/answer') return send(res, await authAction('answer', data));
        if (url.pathname === '/api/auth/cancel') return send(res, await authAction('cancel', data));
        if (url.pathname === '/api/auth/delete') {
          idle();
          const provider = text(data.provider, '渠道');
          await credentials.delete(provider);
          if (auth?.provider === provider) auth = null;
          return send(res, { ok: true });
        }
      } finally { mutating = false; }
    }
    fail('接口不存在。', 404);
  } catch (error) {
    if (!res.headersSent) send(res, { error: redact(error.message) }, error.status ?? (error.code === 'ENOENT' ? 404 : 500));
    else res.end();
  }
});

const { values } = parseArgs({ options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('用法：npm --prefix harness run ui -- [--port 4311]\n仅监听 127.0.0.1；启动页面不会调用模型。关闭服务会中断本服务启动的任务和登录。');
} else {
  const port = Number(values.port ?? 4311);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 的整数。');
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，Web 控制台未启动。请运行 npm --prefix harness run ui -- --port 0，并打开终端输出的实际地址。`
      : redact(error.message));
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`OneShot Console · http://127.0.0.1:${server.address().port}`));
  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (job?.process) { job.state = 'stopping'; job.process.kill('SIGINT'); }
    auth?.controller.abort();
    server.close();
    server.closeIdleConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
