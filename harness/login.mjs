import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function login(models, providerId, method) {
  const provider = models.getProvider(providerId);
  if (!provider) throw new Error(`未知渠道：${providerId}`);
  method ??= provider.auth.oauth ? 'oauth' : 'api_key';
  if (!['oauth', 'api_key'].includes(method) || !(method === 'oauth' ? provider.auth.oauth : provider.auth.apiKey)) {
    throw new Error(`${providerId} 不支持鉴权方式 ${method}。`);
  }
  if (!process.stdin.isTTY) throw new Error('登录需要交互式终端；API Key 也可以通过环境变量配置。');
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) {
    if (!hidden) process.stderr.write(chunk);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.on('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await models.login(providerId, method, {
      signal: controller.signal,
      prompt: async (prompt) => {
        console.error(prompt.message);
        if (prompt.type === 'select') {
          for (const option of prompt.options) console.error(`  ${option.id}: ${option.label}`);
        }
        hidden = prompt.type === 'secret';
        try {
          const answer = await rl.question(hidden ? '' : '> ', {
            signal: prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal,
          });
          return answer.trim();
        } finally {
          if (hidden) process.stderr.write('\n');
          hidden = false;
        }
      },
      notify: (event) => {
        if (event.type === 'auth_url') console.error(event.url, event.instructions ?? '');
        else if (event.type === 'device_code') console.error(event.verificationUri, event.userCode);
        else console.error(event.message);
      },
    });
    console.error(`已保存 ${providerId} 凭据。`);
  } finally {
    rl.close();
    process.removeListener('SIGTERM', cancel);
  }
}
