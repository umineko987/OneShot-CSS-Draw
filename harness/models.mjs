import fs from 'node:fs';
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function loadModels(file, credentials, remember) {
  const models = builtinModels({ credentials });
  const providers = readJson(file, { providers: {} }).providers;
  for (const [id, config] of Object.entries(providers)) {
    const builtin = models.getProvider(id);
    const catalog = new Map((builtin?.getModels() ?? []).map(model => [model.id, model]));
    const headers = (values = {}) => Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (value && typeof value === 'object' && value.env) {
        value = process.env[value.env];
        if (!value) throw new Error(`${id}: 请求头环境变量 ${values[key].env} 未设置。`);
      }
      if (/authorization|api[-_]key|token|cookie/i.test(key)) remember(value);
      return [key, value];
    }));
    for (const entry of config.models ?? []) {
      const existing = catalog.get(entry.id);
      const model = {
        name: entry.id,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...existing,
        api: config.api ?? existing?.api,
        baseUrl: config.baseUrl ?? existing?.baseUrl,
        ...entry,
        provider: id,
        headers: { ...existing?.headers, ...headers(config.headers), ...headers(entry.headers) },
      };
      if (!model.id || !model.api || !model.baseUrl || typeof model.reasoning !== 'boolean'
        || !Array.isArray(model.input) || !(model.contextWindow > 0) || !(model.maxTokens > 0)) {
        throw new Error(`${id}/${entry.id}: 自定义模型需要 id、api、baseUrl、reasoning、input、contextWindow、maxTokens。`);
      }
      catalog.set(model.id, model);
    }
    const auth = builtin?.auth ?? { apiKey: envApiKeyAuth(`${id} API key`, config.apiKeyEnv ? [config.apiKeyEnv] : []) };
    if (config.apiKey !== undefined) {
      throw new Error(`${id}: 请将密钥移至 .agent/auth.json，或用 apiKeyEnv 指定环境变量名。`);
    }
    if (config.authHeader && auth.apiKey) {
      const original = auth.apiKey;
      auth.apiKey = { ...original, resolve: async (input) => {
        const resolved = await original.resolve(input);
        if (resolved?.auth.apiKey) {
          resolved.auth.headers = { ...resolved.auth.headers, Authorization: `Bearer ${resolved.auth.apiKey}` };
        }
        return resolved;
      } };
    }
    const apis = [...new Set([...catalog.values()].map(model => model.api))];
    const api = Object.fromEntries(await Promise.all(apis.map(async (name) => {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`无效 API：${name}`);
      return [name, await import(`@earendil-works/pi-ai/api/${name}`)];
    })));
    models.setProvider(createProvider({ id, auth, models: [...catalog.values()], api }));
  }
  return models;
}
