import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici';
import { FileCredentials, createRedactor } from './credentials.mjs';
import { loadModels, readJson } from './models.mjs';
import { createTools } from './tools.mjs';
import { detectSupportedImageMimeType, processImage } from './images.mjs';
import { login } from './login.mjs';

const harnessDir = import.meta.dirname;
const projectDir = path.dirname(harnessDir);
const agentDir = path.join(harnessDir, '.agent');
const { remember, redact } = createRedactor();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, `${redact(JSON.stringify(value, null, 2))}\n`);
const requestOptions = { transport: 'sse', cacheRetention: 'short', maxRetries: 0, maxRetryDelayMs: 60000, timeoutMs: 300000 };
// Optional observation channel; it never feeds input back into the agent.
const notifyUI = event => { if (process.connected) process.send(event, () => {}); };

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' },
      proxy: { type: 'string' }, login: { type: 'string' }, 'auth-method': { type: 'string' },
      'list-models': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    }, allowPositionals: true,
  });
  const cases = readJson(path.join(harnessDir, 'cases.json'));
  if (values.help || (!positionals.length && !values.login && !values['list-models'])) {
    console.log(`用法（从项目根目录）：
  npm --prefix harness start -- <用例> [--provider 渠道 --model 完整模型ID] [--thinking 等级] [--proxy 地址]
  npm --prefix harness start -- --list-models [--provider 渠道]
  npm --prefix harness start -- --login 渠道 [--auth-method oauth|api_key] [--proxy 地址]

用例：${Object.keys(cases).join(', ')}
默认参数：harness/config.json；自定义模型：harness/.agent/models.json；凭据：harness/.agent/auth.json。
thinking：off, minimal, low, medium, high, xhigh, max；不支持的等级按模型能力下调并记录。
proxy：127.0.0.1:7890 或 HTTP/HTTPS URL；仅本次生效，省略时沿用环境变量。
正式运行只接受固定输入，不读取 stdin、个人 Pi 设置、skills 或插件目录。
固定 read/write/edit/bash，多轮工具调用；无自动压缩、模型切换、请求重试或任务重跑。
结果：runs/<用例>/<渠道--模型>/<新轮次>/work/index.html；中断和失败也保留日志。
渠道传输模块由 config.json 的 transports 显式指定。详见 harness/README.md。`);
    return 0;
  }
  if (positionals.length > 1 || (positionals.length && (values.login || values['list-models']))
    || (values.login && values['list-models']) || (values['auth-method'] && !values.login)) {
    throw new Error('测试、登录、列出模型必须分别执行。使用 --help 查看用法。');
  }
  const caseId = positionals[0];
  if (caseId && !Object.hasOwn(cases, caseId)) throw new Error(`未知用例：${caseId}`);
  const config = readJson(path.join(harnessDir, 'config.json'), {});
  const provider = values.provider ?? config.provider;
  const modelId = values.model ?? config.model;
  const requestedThinking = values.thinking ?? config.thinking ?? 'high';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(requestedThinking)) {
    throw new Error(`无效 thinking 等级：${requestedThinking}`);
  }
  if (values.proxy !== undefined) {
    let proxy;
    try {
      const address = values.proxy.trim();
      proxy = new URL(address.includes('://') ? address : `http://${address}`);
    } catch { throw new Error('无效代理地址。请使用 127.0.0.1:7890 或 HTTP/HTTPS URL。'); }
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('--proxy 仅支持 HTTP/HTTPS 代理。');
    remember(decodeURIComponent(proxy.password));
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) process.env[key] = proxy.href;
  }
  const credentials = new FileCredentials(path.join(agentDir, 'auth.json'));
  for (const credential of Object.values(await credentials.load())) {
    for (const key of ['key', 'access', 'refresh']) remember(credential[key]);
  }
  const models = await loadModels(path.join(agentDir, 'models.json'), credentials, remember);
  if (values['list-models']) {
    for (const model of models.getModels(values.provider)) {
      console.log(`${model.provider}\t${model.id}\t${model.input.includes('image') ? 'vision' : 'text-only'}`);
    }
    return 0;
  }
  if (caseId && (!provider || !modelId || (values.provider && !values.model && provider !== config.provider))) {
    throw new Error('请指定 --provider 和 --model，或在 config.json 中设置默认值。');
  }
  let model;
  if (caseId) {
    model = models.getModel(provider, modelId);
    if (!model) throw new Error(`未知模型：${provider}/${modelId}。使用 --list-models 或配置 .agent/models.json。`);
    if (!model.input.includes('image')) throw new Error(`${provider}/${modelId} 被标记为纯文本模型，不能接收参考图；不分配测试轮次。`);
    if (!await models.checkAuth(provider)) throw new Error(`${provider} 尚未配置鉴权。请先 --login 或设置渠道密钥环境变量。`);
  }
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false, proxyTunnel: true, bodyTimeout: requestOptions.timeoutMs,
    headersTimeout: requestOptions.timeoutMs, connect: { autoSelectFamilyAttemptTimeout: 2000 },
  });
  setGlobalDispatcher(dispatcher);
  install();
  try {
    if (values.login) { await login(models, values.login, values['auth-method']); return 0; }
    const thinking = clampThinkingLevel(model, requestedThinking);
    if (thinking !== requestedThinking) console.error(`thinking：${requestedThinking} → ${thinking}（模型支持范围）`);
    const transportPath = config.transports?.[provider];
    let wrapFetch = fetch => fetch;
    let transport = null;
    if (transportPath) {
      const file = path.resolve(harnessDir, transportPath);
      ({ wrapFetch } = await import(pathToFileURL(file).href));
      if (typeof wrapFetch !== 'function') throw new Error(`${transportPath} 必须导出 wrapFetch(fetch)。`);
      transport = { module: transportPath, sha256: sha256(fs.readFileSync(file)) };
    }
    return await runCase({ caseId, testCase: cases[caseId], model, models, requestedThinking, thinking, wrapFetch, transport });
  } finally {
    await dispatcher.destroy();
  }
}

async function runCase({ caseId, testCase, model, models, requestedThinking, thinking, wrapFetch, transport }) {
  const sourceImage = path.join(projectDir, testCase.image);
  const bytes = fs.readFileSync(sourceImage);
  const mimeType = detectSupportedImageMimeType(bytes);
  if (!mimeType) throw new Error(`不支持的参考图格式：${testCase.image}`);
  const image = await processImage(bytes, mimeType, { autoResizeImages: true });
  if (!image.ok) throw new Error(image.message);
  const prompt = fs.readFileSync(path.join(harnessDir, 'prompt.txt'), 'utf8')
    .replaceAll('{{width}}', String(testCase.width)).replaceAll('{{height}}', String(testCase.height));
  const modelDir = path.join(projectDir, 'runs', caseId, `${encodeURIComponent(model.provider)}--${encodeURIComponent(model.id)}`);
  fs.mkdirSync(modelDir, { recursive: true });
  let runDir;
  for (let round = 1; ; round++) {
    runDir = path.join(modelDir, String(round).padStart(3, '0'));
    try { fs.mkdirSync(runDir); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const workDir = path.join(runDir, 'work');
  const sessionDir = path.join(runDir, 'sessions');
  fs.mkdirSync(workDir);
  fs.mkdirSync(sessionDir);
  const reference = path.join(runDir, `reference${path.extname(sourceImage)}`);
  fs.writeFileSync(reference, bytes);
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt);
  // Preserve the old blank-override and @file envelope, including whitespace.
  const systemPrompt = ` \nCurrent working directory: ${workDir.replaceAll('\\', '/')}\n`;
  const userPrompt = `<file name="${reference}">${image.hints.join('\n')}</file>\n${prompt}`;
  fs.writeFileSync(path.join(runDir, 'system-prompt.txt'), systemPrompt);
  const sessionId = randomUUID();
  const sessionFile = path.join(sessionDir, 'session.jsonl');
  const { tools, cleanup } = createTools(workDir, {
    PI_SESSION_ID: sessionId, PI_SESSION_FILE: sessionFile, PI_PROVIDER: model.provider,
    PI_MODEL: model.id, PI_REASONING_LEVEL: thinking,
  });
  const toolDefinitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  writeJson(path.join(runDir, 'tools.json'), toolDefinitions);
  const meta = {
    caseId, createdAt: new Date().toISOString(), harnessVersion: 2,
    packages: readJson(path.join(harnessDir, 'package.json')).dependencies,
    systemPromptMode: 'cwd-only', transportCompatibility: transport,
    requestedProvider: model.provider, requestedModel: model.id, requestedThinking, effectiveThinking: thinking,
    model: { id: model.id, provider: model.provider, api: model.api, input: model.input, reasoning: model.reasoning,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat, samplingParams: model.samplingParams },
    requestOptions, toolExecution: 'parallel', image: testCase.image, imageSha256: sha256(bytes),
    sentImageSha256: sha256(Buffer.from(image.data, 'base64')), sentImageMimeType: image.mimeType,
    width: testCase.width, height: testCase.height, output: 'work/index.html', status: 'running',
  };
  const saveMeta = () => writeJson(path.join(runDir, 'meta.json'), meta);
  const log = event => fs.appendFileSync(sessionFile, `${redact(JSON.stringify(event))}\n`, { mode: 0o600 });
  saveMeta();
  log({ type: 'session', version: 1, id: sessionId, timestamp: meta.createdAt, cwd: workDir, systemPrompt, tools: toolDefinitions });
  let requests = 0;
  let fetch;
  const baseFetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [key, value] of headers) {
      if (/authorization|api[-_]key|token|cookie/i.test(key)) {
        remember(value); remember(value.replace(/^(Bearer|Basic)\s+/i, ''));
      }
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    remember(decodeURIComponent(url.password));
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
    let parameters;
    try {
      const payload = JSON.parse(body);
      const fields = ['model', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p',
        'thinking', 'reasoning', 'reasoning_effort', 'output_config', 'generationConfig', 'context_management'];
      parameters = Object.fromEntries(fields.filter(key => key in payload).map(key => [key, payload[key]]));
    } catch { /* Some APIs do not send JSON bodies. Never log opaque payloads. */ }
    log({ type: 'http_request', number: ++requests, timestamp: new Date().toISOString(),
      endpoint: `${url.origin}${url.pathname}`, parameters });
    notifyUI({ type: 'progress', progress: { turns, httpRequests: requests, usage } });
    const response = await globalThis.fetch(input, init);
    log({ type: 'http_response', number: requests, status: response.status });
    return response;
  };
  const agent = new Agent({
    initialState: { systemPrompt, model, thinkingLevel: thinking, tools },
    sessionId, toolExecution: 'parallel',
    streamFn: (activeModel, context, options) => models.streamSimple(activeModel, context, {
      ...options, ...requestOptions,
      fetch: (input, init) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return fetch(input, { ...init, signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal });
      },
    }),
  });
  let turns = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  agent.subscribe(event => {
    if (event.type === 'message_end') {
      log({ type: 'message', message: event.message });
      if (event.message.role === 'assistant') {
        turns++;
        for (const key of Object.keys(usage)) usage[key] += event.message.usage?.[key] ?? 0;
        notifyUI({ type: 'progress', progress: { turns, httpRequests: requests, usage } });
        const text = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text) console.log(redact(text));
      }
    } else if (event.type === 'tool_execution_start') {
      console.error(`工具：${event.toolName}`);
      notifyUI({ type: 'progress', progress: { turns, httpRequests: requests, usage, tool: event.toolName } });
    }
  });
  let interrupted = false;
  const cancel = () => { interrupted = true; agent.abort(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  console.error(`测试目录：${runDir}\n输出文件：${path.join(workDir, 'index.html')}`);
  notifyUI({ type: 'run_started', relative: path.relative(path.join(projectDir, 'runs'), runDir).split(path.sep).join('/') });
  try {
    fetch = wrapFetch(baseFetch);
    if (typeof fetch !== 'function') throw new Error('wrapFetch 必须返回 fetch 函数。');
    await agent.prompt(userPrompt, [{ type: 'image', data: image.data, mimeType: image.mimeType }]);
    const last = agent.state.messages.at(-1);
    if (interrupted || last?.stopReason === 'aborted') throw new Error('测试已中断。');
    if (last?.role !== 'assistant' || last.stopReason !== 'stop') {
      throw new Error(last?.errorMessage || `任务未正常结束：${last?.stopReason ?? '无响应'}`);
    }
    const output = fs.statSync(path.join(workDir, 'index.html'), { throwIfNoEntry: false });
    if (!output?.isFile() || output.size === 0) throw new Error('本轮没有生成非空 work/index.html；不自动重试。');
    meta.status = 'completed';
    return 0;
  } catch (error) {
    meta.status = interrupted ? 'aborted' : 'failed';
    meta.error = redact(error.message);
    console.error(meta.error);
    return interrupted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    meta.finishedAt = new Date().toISOString();
    meta.turns = turns; meta.httpRequests = requests; meta.usage = usage;
    saveMeta();
    log({ type: 'run_end', status: meta.status, timestamp: meta.finishedAt });
    await cleanup();
  }
}

try { process.exitCode = await main(); }
catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
