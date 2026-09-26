import fs from 'node:fs';
import path from 'node:path';

export function sessionFile(runDir) {
  const dir = path.join(runDir, 'sessions');
  try {
    const names = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();
    if (!names.length) return null;
    const file = path.join(dir, names.includes('session.jsonl') ? 'session.jsonl' : names.at(-1));
    const relative = path.relative(fs.realpathSync(runDir), fs.realpathSync(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return file;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function loadSession(runDir) {
  const file = sessionFile(runDir);
  if (!file) throw new Error('该轮次没有保存的会话，无法继续。');
  const source = fs.readFileSync(file, 'utf8');
  const events = source.trim().split('\n').map(line => JSON.parse(line));
  const header = events[0];
  if (header?.type !== 'session' || !header.id) throw new Error('会话记录缺少有效的会话头。');
  let entries = events.slice(1);
  // Older harness runs used Pi's tree-shaped JSONL. Keep its active branch,
  // and leave the original file untouched when creating the current log format.
  if (header.version === 3) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const branch = [];
    for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : null) {
      if (branch.includes(entry)) throw new Error('会话分支存在循环。');
      branch.push(entry);
    }
    entries = branch.reverse();
    if (entries.some(entry => !['message', 'model_change', 'thinking_level_change'].includes(entry.type))) {
      throw new Error('此历史会话包含非标准上下文，无法直接继续。');
    }
  }
  const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
  if (!messages.some(message => message.role === 'user')) throw new Error('会话未保存初始任务，无法继续。');
  const savedPrompt = path.join(runDir, 'system-prompt.txt');
  const systemPrompt = header.systemPrompt ?? (fs.existsSync(savedPrompt)
    ? fs.readFileSync(savedPrompt, 'utf8') : ` \nCurrent working directory: ${path.join(runDir, 'work').replaceAll('\\', '/')}\n`);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let turns = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    turns++;
    for (const key of Object.keys(usage)) usage[key] += message.usage?.[key] ?? 0;
  }
  const requests = events.reduce((count, event) => event.type === 'http_request' ? Math.max(count, event.number) : count, 0);
  return { file, header, messages, systemPrompt, turns, requests, usage, needsNewline: !source.endsWith('\n') };
}
