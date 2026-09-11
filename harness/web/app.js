const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const token = document.querySelector('meta[name="session-token"]').content;
const statusNames = { starting: '启动中', running: '运行中', stopping: '停止中', completed: '已完成', failed: '失败', aborted: '已中断', legacy: '历史' };
const caseNames = { '01-flat-scene': '平面场景', '02-3d-character': '立体角色', '03-complex-scene': '复杂场景' };
const providerTypes = { third_party: '第三方渠道', builtin: 'Pi 内置渠道' };
const badge = status => `<span class="status ${escape(status)}">${escape(statusNames[status] ?? status)}</span>`;
const number = value => value === undefined ? '—' : new Intl.NumberFormat('en', { notation: value >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
let catalog = null;
let runs = [];
let job = null;
let selectedCase = '';
let selectedRun = null;
let detail = null;
let followJob = false;
let working = false;
let authProvider = '';
let auth = null;
let handledAuth = '';
let authPromptId = null;
let confirmedRun = null;
let previewUrl = null;
let toastTimer;
const caseImages = new Map();

async function request(url, data, image = false) {
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'x-harness-token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error ?? `请求失败：${response.status}`);
  }
  return image ? response.blob() : response.json();
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('toast');
  (document.querySelector('dialog[open]') ?? document.body).append(element);
  element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 9000 : 3500);
}
async function action(work) {
  if (working) return;
  working = true; controls();
  try { await work(); } catch (error) { toast(error.message, true); }
  finally { working = false; controls(); }
}
const selectedProvider = () => catalog?.providers.find(provider => provider.id === $('provider').value);
const selectedModel = () => selectedProvider()?.models.find(model => model.id === $('model').value);
const selection = () => ({ provider: $('provider').value, model: $('model').value, thinking: $('thinking').value, transport: $('transport').value });
const transportDirty = () => catalog && $('transport').value !== (catalog.config.transports[$('provider').value] ?? '');
const authRunning = () => auth?.state === 'authorizing';

function navigate() {
  const name = ['workspace', 'providers', 'observe'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'workspace';
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${name}`;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('page-title').textContent = { workspace: '测试工作台', providers: '渠道与鉴权', observe: '运行观测' }[name];
  if (name === 'observe') resizePreview();
}
function modelOptions(preferred = $('model').value) {
  const provider = selectedProvider();
  const query = $('model-search').value.toLowerCase().trim();
  const models = provider?.models.filter(model => model.id === preferred || (model.input.includes('image') && model.id.toLowerCase().includes(query))) ?? [];
  $('model').innerHTML = '<option value="">请选择视觉模型…</option>' + models.map(model => `<option value="${escape(model.id)}" ${model.input.includes('image') ? '' : 'disabled'}>${escape(model.id)}${model.input.includes('image') ? '' : ' · 纯文本，不可运行'}</option>`).join('');
  $('model').value = preferred;
  if (!$('model').value) $('model').value = '';
  controls();
}
function chooseProvider(id, model = '') {
  $('provider').value = id;
  $('model-search').value = '';
  $('transport').value = catalog.config.transports[id] ?? '';
  modelOptions(model);
}
async function refreshCatalog(reset = false) {
  const previous = reset || !catalog ? null : selection();
  catalog = await request('/api/catalog');
  $('provider').innerHTML = '<option value="">请选择渠道…</option>' + Object.entries(providerTypes).map(([type, label]) => {
    const providers = catalog.providers.filter(provider => provider.type === type);
    return providers.length ? `<optgroup label="${label}">${providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.id)}${provider.auth ? ' · 已配置' : ''}</option>`).join('')}</optgroup>` : '';
  }).join('');
  $('transport').innerHTML = '<option value="">无需适配</option>' + catalog.transports.map(value => `<option value="${escape(value)}">${escape(value.split('/').at(-1))}</option>`).join('');
  const current = previous ?? catalog.config;
  $('thinking').value = current.thinking ?? 'high';
  chooseProvider(current.provider ?? '', current.model ?? '');
  if (previous && selectedProvider()) $('transport').value = previous.transport;
  selectedCase ||= catalog.cases[0]?.id ?? '';
  renderCases(); renderProviders(); controls();
}
function renderCases() {
  $('cases').innerHTML = catalog.cases.map((testCase, index) => `<button class="case-card" data-case="${escape(testCase.id)}" aria-pressed="${testCase.id === selectedCase}"><span class="case-image"><img data-case-image="${escape(testCase.id)}" alt="${escape(caseNames[testCase.id] ?? testCase.id)}参考图"></span><span class="case-text"><strong>${String(index + 1).padStart(2, '0')} · ${escape(caseNames[testCase.id] ?? testCase.id)}</strong><small>${testCase.width} × ${testCase.height}</small></span></button>`).join('');
  for (const testCase of catalog.cases) {
    if (!caseImages.has(testCase.id)) caseImages.set(testCase.id, request(`/api/cases/${encodeURIComponent(testCase.id)}/reference`, undefined, true).then(blob => URL.createObjectURL(blob)));
    caseImages.get(testCase.id).then(url => {
      const image = [...document.querySelectorAll('[data-case-image]')].find(element => element.dataset.caseImage === testCase.id);
      if (image) image.src = url;
    }).catch(error => toast(error.message, true));
  }
}
function controls() {
  const provider = selectedProvider();
  const model = selectedModel();
  const vision = model?.input.includes('image');
  const busy = working || !!job?.active || authRunning();
  $('auth-status').textContent = provider?.error ? '鉴权配置有误' : provider?.auth ? `已配置 · ${provider.auth.type === 'oauth' ? 'OAuth' : 'API Key / 环境'}` : '尚未配置鉴权';
  $('model-facts').innerHTML = model ? `<span class="${vision ? 'vision' : ''}">${vision ? '◉ vision' : '仅文本'}</span><span>上下文 ${number(model.contextWindow)}</span><span>输出 ${number(model.maxTokens)}</span>` : '';
  $('run-summary').textContent = model ? `${provider.id} / ${model.id}\n${selectedCase} · thinking ${$('thinking').value}` : '请选择渠道与视觉模型，不会自动切换或回退模型。';
  const changed = catalog && ['provider', 'model', 'thinking'].some(key => selection()[key] !== catalog.config[key]);
  $('config-state').textContent = changed || transportDirty() ? '尚未保存为默认' : '本地默认值';
  let warning = '正式测试会调用真实渠道并可能产生费用。启动前需要再次确认。';
  if (job?.active) warning = '已有任务运行中。当前页面只允许一轮任务，不并行调度。';
  else if (authRunning()) warning = '请先完成或取消正在进行的鉴权。';
  else if (model && !vision) warning = '当前模型被标为纯文本，请明确选择支持 vision 的模型。';
  else if (provider && !provider.auth) warning = '该渠道尚未配置鉴权，请先在“渠道与鉴权”中登录。';
  else if (transportDirty()) warning = '传输模块修改需要先“保存为默认配置”后才能启动。';
  $('run-warning').textContent = warning;
  $('start-run').disabled = busy || !vision || !provider?.auth || !selectedCase || transportDirty();
  $('save-config').disabled = busy || !vision;
  $('configure-auth').disabled = working || !!job?.active || !provider;
  $('add-provider').disabled = busy;
  $('confirm-start').disabled = working;
  $('stop-workspace').hidden = !job?.active;
  $('stop-workspace').disabled = working || job?.state === 'stopping';
  $('stop-detail').hidden = !(job?.active && selectedRun === job.runId);
  $('stop-detail').disabled = working || job?.state === 'stopping';
  $('active-job').hidden = !job;
  if (job) $('active-job').textContent = `${statusNames[job.state] ?? job.state}${job.progress?.tool ? ` · ${job.progress.tool}` : ''} ↗`;
  for (const button of document.querySelectorAll('[data-auth], [data-method], [data-delete-provider]')) button.disabled = busy;
  $('auth-submit').disabled = working || !auth?.prompt;
  $('delete-auth').disabled = busy;
  $('cancel-auth').disabled = working;
  $('load-preview').disabled = working || !detail?.output || detail.status === 'running' || !!(job?.active && selectedRun === job.runId);
}
function authLabel(provider) {
  if (provider.error) return '配置有误 · 请重新检查';
  if (provider.auth) return `已配置 · ${provider.auth.source ?? provider.auth.type}`;
  return provider.stored ? '已有凭据 · 仍需补充渠道配置' : '尚未配置鉴权';
}
function renderProviders() {
  if (!catalog) return;
  const query = $('provider-search').value.toLowerCase().trim();
  const providers = catalog.providers.filter(provider => `${provider.id} ${provider.name}`.toLowerCase().includes(query));
  $('provider-count').textContent = `${providers.length} / ${catalog.providers.length} 个渠道`;
  $('provider-grid').innerHTML = Object.entries(providerTypes).map(([type, label]) => {
    const group = providers.filter(provider => provider.type === type);
    if (!group.length && query) return '';
    const cards = group.map(provider => `<article class="panel provider-card"><div class="provider-card-top"><span class="provider-avatar">${escape(provider.id.slice(0, 2).toUpperCase())}</span><h2>${escape(provider.id)}</h2></div><p class="provider-meta">${provider.models.filter(model => model.input.includes('image')).length} 个视觉模型 · ${escape(provider.methods.map(method => method === 'oauth' ? 'OAuth' : 'API Key').join(' / ') || '环境鉴权')}</p><p class="provider-status">${escape(authLabel(provider))}</p><div class="provider-actions"><button class="text-button" data-auth="${escape(provider.id)}">配置鉴权 ↗</button><button class="text-button" data-use-provider="${escape(provider.id)}">使用此渠道 →</button>${type === 'third_party' ? `<button class="text-button danger" data-delete-provider="${escape(provider.id)}">删除渠道</button>` : ''}</div></article>`).join('');
    return `<section class="provider-section" data-provider-type="${type}"><h2 class="provider-section-title">${label}<span class="counter">${group.length}</span></h2><div class="provider-grid">${cards || '<p class="empty-small">暂无第三方渠道，可在右上角添加。</p>'}</div></section>`;
  }).join('') || '<p class="empty-small">没有匹配的渠道。</p>';
  controls();
}
function renderHistory() {
  $('run-count').textContent = runs.length;
  const query = $('history-search').value.toLowerCase().trim();
  const filtered = runs.filter(run => `${run.model} ${run.provider} ${run.caseId} ${run.status} ${statusNames[run.status]}`.toLowerCase().includes(query));
  $('history-list').innerHTML = filtered.map(run => `<button class="history-row" data-run="${escape(run.id)}" aria-pressed="${run.id === selectedRun}"><span class="history-top">${escape(run.caseId.split('-')[0])} / ROUND ${escape(run.round)} ${badge(run.status)}</span><strong>${escape(run.model)}</strong><small>${escape(run.provider)} · ${date(run.createdAt)}</small></button>`).join('') || '<p class="empty-small">没有匹配的运行记录。</p>';
  $('recent-runs').innerHTML = runs.slice(0, 3).map(run => `<button class="recent-row" data-run="${escape(run.id)}"><div><strong>${escape(run.model)}</strong><small>${escape(caseNames[run.caseId] ?? run.caseId)} · #${escape(run.round)} · ${date(run.createdAt)}</small></div>${badge(run.status)}<span class="muted">↗</span></button>`).join('') || '<p class="empty-small">还没有结果。新轮次会显示在这里。</p>';
}
function resetPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('preview-output').removeAttribute('srcdoc');
  $('preview-reference').removeAttribute('src');
  $('preview-comparison').hidden = true;
  $('preview-placeholder').hidden = false;
}
function selectRun(id) {
  if (selectedRun !== id) { resetPreview(); detail = null; }
  selectedRun = id; followJob = false;
  renderHistory();
  if (location.hash !== '#observe') location.hash = 'observe';
  refreshDetail().catch(error => toast(error.message, true));
}
function duration(run) {
  if (!run.createdAt || (!run.finishedAt && run.status !== 'running')) return '—';
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now()) - new Date(run.createdAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function scrollContent(element, content, html = false) {
  const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  const property = html ? 'innerHTML' : 'textContent';
  if (element[property] !== content) element[property] = content;
  if (pinned) element.scrollTop = element.scrollHeight;
}
async function refreshDetail() {
  const id = selectedRun;
  if (!id) {
    $('run-detail').hidden = true; $('detail-empty').hidden = false;
    if (followJob && job) $('detail-empty').innerHTML = `<span class="empty-symbol">◷</span><h2>${escape(statusNames[job.state])}</h2><p>${escape(job.runId ? '读取轮次记录…' : '尚未分配轮次。若启动失败，可查看下面的诊断。')}</p><pre class="console-output">${escape(job.console || '等待 runner…')}</pre>`;
    return;
  }
  const data = await request(`/api/runs/${id}`);
  if (id !== selectedRun) return;
  detail = data.run;
  $('detail-empty').hidden = true; $('run-detail').hidden = false;
  $('detail-case').textContent = `${detail.caseId} / ROUND ${detail.round}`;
  $('detail-model').textContent = `${detail.provider} / ${detail.model}`;
  $('detail-path').textContent = detail.path;
  $('detail-status').innerHTML = badge(detail.status);
  $('metrics').innerHTML = [[number(detail.httpRequests), 'HTTP 请求'], [number(detail.turns), '模型轮次'], [number(detail.usage?.totalTokens), '总 Token'], [duration(detail), '运行时长']].map(([value, label]) => `<div class="metric"><strong>${escape(value)}</strong><span>${label}</span></div>`).join('');
  const usage = detail.usage;
  $('detail-facts').textContent = `thinking: ${detail.requestedThinking ?? '—'} → ${detail.thinking ?? '—'} · ${detail.width} × ${detail.height} · adapter: ${detail.transport?.module ?? 'none'}${usage ? ` · input ${number(usage.input)} / output ${number(usage.output)} / cache ${number(usage.cacheRead)}` : ''}`;
  $('detail-error').hidden = !detail.error;
  $('detail-error').textContent = detail.error ?? '';
  const events = data.events.map(event => `<article class="event ${event.error ? 'error' : ''}"><header><span>${escape(event.kind)}</span><time>${event.time ? date(event.time) : ''}</time></header><pre>${escape(event.text)}</pre></article>`).join('') || '<p class="empty-small">等待模型事件；消息和工具结果完成后出现在这里。</p>';
  scrollContent($('events'), events, true);
  scrollContent($('console-output'), data.console || '该轮次没有当前进程输出。请查看事件轨迹。');
  $('log-note').textContent = data.truncated ? '仅显示日志尾部最近 1 MB / 80 个事件，长消息也会截断。完整记录保留在本轮 sessions/。' : '显示已完成的消息与 HTTP 事件；图片数据省略，长消息截断。完整记录保留在本轮 sessions/。';
  controls();
}
async function refreshRuns() {
  const data = await request('/api/runs');
  runs = data.runs; job = data.job;
  if (followJob && job?.runId && selectedRun !== job.runId) { selectedRun = job.runId; resetPreview(); }
  if (!selectedRun && !followJob && runs.length) selectedRun = runs[0].id;
  renderHistory(); controls();
  if (!$('view-observe').hidden) await refreshDetail();
}
function resizePreview() {
  if ($('preview-comparison').hidden || !detail) return;
  const width = Number(detail.width) || 1440;
  const height = Number(detail.height) || 805;
  const frame = $('preview-output-frame');
  const scale = Math.min(1, (frame.clientWidth || 1) / width);
  $('preview-output').style.width = `${width}px`;
  $('preview-output').style.height = `${height}px`;
  $('preview-output').style.transform = `scale(${scale})`;
  frame.style.height = `${height * scale}px`;
  $('preview-reference-frame').style.height = `${height * scale}px`;
}
new ResizeObserver(resizePreview).observe($('preview-output-frame'));
async function preview() {
  const id = selectedRun;
  const [result, image] = await Promise.all([request(`/api/runs/${id}/preview`), request(`/api/runs/${id}/reference`, undefined, true)]);
  if (id !== selectedRun) return;
  resetPreview();
  previewUrl = URL.createObjectURL(image);
  $('preview-reference').src = previewUrl;
  // The parent also forbids cross-origin frame navigation. The sandbox has no grants.
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const doctype = result.html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  $('preview-output').srcdoc = `${doctype}<meta http-equiv="Content-Security-Policy" content="${policy}">\n${result.html.slice(doctype.length)}`;
  $('preview-placeholder').hidden = true; $('preview-comparison').hidden = false;
  resizePreview();
}

function openAuth(providerId) {
  const provider = catalog.providers.find(item => item.id === providerId);
  if (!provider) return;
  authProvider = providerId;
  $('auth-title').textContent = providerId;
  $('auth-source').textContent = authLabel(provider);
  $('auth-methods').innerHTML = provider.methods.map(method => `<button class="button secondary" data-method="${method}">${method === 'oauth' ? 'OAuth 授权 ↗' : '配置 API Key'}</button>`).join('');
  $('delete-auth').hidden = !provider.stored;
  $('auth-events').replaceChildren(); $('auth-form').hidden = true; $('auth-answer').value = '';
  $('auth-message').textContent = provider.methods.length ? '选择鉴权方式。OAuth 会显示授权链接、设备码或需要输入的步骤。' : `此渠道通过环境变量或本机凭据配置：${provider.authName ?? provider.id}。配置后重启服务或刷新页面。`;
  authPromptId = null;
  if (!$('auth-dialog').open) $('auth-dialog').showModal();
  renderAuth(); controls();
}
function safeLink(url, label) {
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return ''; }
  catch { return ''; }
  return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
}
function renderAuth() {
  const current = auth?.provider === authProvider ? auth : null;
  const provider = catalog?.providers.find(item => item.id === authProvider);
  if (provider) { $('auth-source').textContent = authLabel(provider); $('delete-auth').hidden = !provider.stored; }
  $('cancel-auth').hidden = !authRunning();
  if (!current || !$('auth-dialog').open) return;
  $('auth-events').innerHTML = current.events.map(event => `<div class="auth-event">${escape(event.message ?? event.instructions ?? '')}${event.type === 'auth_url' ? safeLink(event.url, '打开授权页面') : ''}${event.type === 'device_code' ? `<code>${escape(event.userCode)}</code>${safeLink(event.verificationUri, '打开设备授权页面')}` : ''}${(event.links ?? []).map(link => safeLink(link.url, link.label ?? link.url)).join('')}</div>`).join('');
  const prompt = current.prompt;
  $('auth-form').hidden = !prompt;
  if (prompt && authPromptId !== prompt.id) {
    authPromptId = prompt.id;
    $('auth-prompt-label').textContent = prompt.message;
    $('auth-answer').value = '';
    $('auth-answer').type = ['secret', 'manual_code'].includes(prompt.type) ? 'password' : 'text';
    $('auth-answer').placeholder = prompt.placeholder ?? '';
    $('auth-answer').hidden = prompt.type === 'select';
    $('auth-choice').hidden = prompt.type !== 'select';
    $('auth-choice').innerHTML = (prompt.options ?? []).map(option => `<option value="${escape(option.id)}">${escape(option.label)}</option>`).join('');
    (prompt.type === 'select' ? $('auth-choice') : $('auth-answer')).focus();
  }
  if (!prompt) { $('auth-answer').value = ''; authPromptId = null; }
  $('auth-message').textContent = current.state === 'completed' ? '凭据已保存到本地。不会自动启动模型测试。' : current.state === 'aborted' ? '登录已取消。' : current.state === 'failed' ? current.error : prompt ? '按提示完成当前步骤。输入只发送给本机服务。' : '等待授权完成…';
  controls();
}
async function refreshAuth() {
  auth = await request('/api/auth');
  if (authRunning() && !$('auth-dialog').open && !working) openAuth(auth.provider);
  renderAuth(); controls();
  if (auth && auth.state !== 'authorizing' && handledAuth !== auth.id) {
    handledAuth = auth.id;
    await refreshCatalog();
    if (auth.state === 'completed') toast(`${auth.provider} 鉴权已保存。`);
  }
}
async function closeAuth() {
  if (authRunning()) await request('/api/auth/cancel', { id: auth.id });
  $('auth-answer').value = ''; $('auth-dialog').close();
  await refreshAuth();
}

$('provider').addEventListener('change', () => chooseProvider($('provider').value));
$('model-search').addEventListener('input', () => modelOptions());
for (const id of ['model', 'thinking', 'transport']) $(id).addEventListener('change', controls);
$('provider-search').addEventListener('input', renderProviders);
$('history-search').addEventListener('input', renderHistory);
$('cases').addEventListener('click', event => {
  const card = event.target.closest('[data-case]');
  if (!card) return;
  selectedCase = card.dataset.case;
  for (const item of document.querySelectorAll('[data-case]')) item.setAttribute('aria-pressed', String(item === card));
  controls();
});
$('config-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => { await request('/api/config', selection()); await refreshCatalog(); toast('默认配置已保存；没有调用模型。'); });
});
$('start-run').addEventListener('click', () => {
  confirmedRun = { ...selection(), caseId: selectedCase, proxy: $('proxy').value, confirm: true };
  $('confirm-summary').innerHTML = [['渠道', confirmedRun.provider], ['模型', confirmedRun.model], ['用例', confirmedRun.caseId], ['Thinking', confirmedRun.thinking], ['适配器', confirmedRun.transport || '无']].map(([key, value]) => `<span>${key}</span><strong>${escape(value)}</strong>`).join('');
  $('confirm-dialog').showModal();
});
$('confirm-start').addEventListener('click', () => action(async () => {
  job = await request('/api/runs', confirmedRun);
  $('confirm-dialog').close();
  selectedRun = null; followJob = true; resetPreview();
  location.hash = 'observe';
  await refreshRuns();
  toast('任务已启动，正在分配新轮次。');
}));
async function stop() {
  if (!job?.active || !confirm('停止当前任务？已产生的模型费用不会撤销，日志和已有产物会保留。')) return;
  await request('/api/runs/stop', { id: job.id }); await refreshRuns();
}
$('stop-workspace').addEventListener('click', () => action(stop));
$('stop-detail').addEventListener('click', () => action(stop));
$('active-job').addEventListener('click', () => {
  followJob = true; selectedRun = job?.runId ?? null; resetPreview(); location.hash = 'observe';
  refreshDetail().catch(error => toast(error.message, true));
});
$('refresh-history').addEventListener('click', () => action(refreshRuns));
for (const id of ['history-list', 'recent-runs']) $(id).addEventListener('click', event => {
  const row = event.target.closest('[data-run]'); if (row) selectRun(row.dataset.run);
});
for (const tab of document.querySelectorAll('[data-pane]')) {
  tab.addEventListener('click', () => {
    for (const button of document.querySelectorAll('[data-pane]')) {
      const active = button === tab;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $(`pane-${button.dataset.pane}`).hidden = !active;
    }
    resizePreview();
  });
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-pane]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  });
}
$('load-preview').addEventListener('click', () => action(preview));
$('configure-auth').addEventListener('click', () => openAuth($('provider').value));
$('provider-grid').addEventListener('click', event => {
  const authButton = event.target.closest('[data-auth]');
  const useButton = event.target.closest('[data-use-provider]');
  if (authButton) openAuth(authButton.dataset.auth);
  if (useButton) { chooseProvider(useButton.dataset.useProvider); location.hash = 'workspace'; }
  const deleteButton = event.target.closest('[data-delete-provider]');
  if (deleteButton) action(async () => {
    const id = deleteButton.dataset.deleteProvider;
    if (!confirm(`删除第三方渠道 ${id}？\n将删除模型配置、本地凭据和传输模块绑定；若为默认渠道，也会清空默认选择。\n历史结果、模块文件及环境变量不会删除。`)) return;
    await request('/api/providers/delete', { provider: id, confirm: true });
    if (auth?.provider === id) auth = null;
    await refreshCatalog();
    toast(`已删除第三方渠道 ${id}，历史结果已保留。`);
  });
});
$('auth-methods').addEventListener('click', event => {
  const button = event.target.closest('[data-method]');
  if (button) action(async () => {
    auth = await request('/api/auth/start', { provider: authProvider, method: button.dataset.method, proxy: $('proxy').value });
    authPromptId = null; renderAuth();
  });
});
$('auth-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const current = auth;
    const answer = current.prompt.type === 'select' ? $('auth-choice').value : $('auth-answer').value;
    $('auth-answer').value = '';
    await request('/api/auth/answer', { id: current.id, promptId: current.prompt.id, answer });
    await refreshAuth();
  });
});
$('cancel-auth').addEventListener('click', () => action(async () => { await request('/api/auth/cancel', { id: auth.id }); await refreshAuth(); }));
$('close-auth').addEventListener('click', () => action(closeAuth));
$('auth-dialog').addEventListener('cancel', event => { event.preventDefault(); action(closeAuth); });
$('delete-auth').addEventListener('click', () => action(async () => {
  if (!confirm(`删除 ${authProvider} 的本地凭据？这不会清除环境变量中的凭据。`)) return;
  await request('/api/auth/delete', { provider: authProvider });
  auth = await request('/api/auth');
  await refreshCatalog(); openAuth(authProvider); toast('已删除本地凭据。');
}));
$('add-provider').addEventListener('click', () => $('provider-dialog').showModal());
$('provider-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const result = await request('/api/providers', { id: $('custom-id').value, api: $('custom-api').value,
      baseUrl: $('custom-url').value, model: $('custom-model').value, contextWindow: Number($('custom-context').value),
      maxTokens: Number($('custom-output').value), apiKeyEnv: $('custom-env').value,
      reasoning: $('custom-reasoning').checked, authHeader: $('custom-bearer').checked });
    await refreshCatalog(); chooseProvider(result.provider, result.model);
    $('provider-dialog').close(); $('provider-form').reset(); location.hash = 'workspace';
    toast('模型配置已保存，请配置鉴权后再启动。');
  });
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
window.addEventListener('hashchange', navigate);
navigate();
async function poll() {
  try {
    if (!catalog) await refreshCatalog(true);
    await refreshRuns(); await refreshAuth();
    $('connection').classList.remove('offline'); $('connection').innerHTML = '<i></i>本机已连接';
  } catch (error) {
    $('connection').classList.add('offline'); $('connection').innerHTML = '<i></i>连接异常';
    $('connection').title = error.message;
    if (!catalog) toast(error.message, true);
  } finally { setTimeout(poll, 1000); }
}
poll();
