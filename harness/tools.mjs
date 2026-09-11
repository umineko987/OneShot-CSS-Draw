import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  BACKGROUND_CONTEXT, withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { processImage } from './images.mjs';

export function createTools(cwd, sessionEnv) {
  const shellEnv = { ...process.env };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) delete shellEnv[key];
  Object.assign(shellEnv, sessionEnv, { AI_AGENT: 'pi', PI_CODING_AGENT: 'true' });
  const env = new NodeExecutionEnv({ cwd, shellEnv });
  const definitions = [
    createReadTool({ imageProcessor: processImage, autoResizeImages: true }),
    createWriteTool(), createEditTool(), createBashTool(),
  ];
  // The core and CLI tools share implementations but the bash wording differs.
  // Keep the model-facing schema/description exactly as in the old harness.
  const bash = definitions[3];
  bash.description = 'Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.';
  bash.parameters.properties.command.description = 'Shell command to execute';
  const tools = definitions.map(tool => ({
    name: tool.name, label: tool.label, description: tool.description,
    parameters: tool.parameters, prepareArguments: tool.prepareArguments,
    execute: (id, params, signal, onUpdate) => tool.execute(
      id, params, onUpdate ?? (() => {}), { env }, undefined,
      signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
    ),
  }));
  return { tools, cleanup: () => env.cleanup(BACKGROUND_CONTEXT) };
}
