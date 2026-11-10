import {readFileSync} from 'node:fs';

const defaultPath = new URL('../config/windows.json', import.meta.url);
const template = 'config/windows.example.json';

function displayPath(file) {
  return file instanceof URL ? 'config/windows.json' : String(file);
}

function invalid(file, message) {
  return new Error(`Invalid Windows config ${displayPath(file)}: ${message}`);
}

export function loadWindowsConfig(file = defaultPath) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Windows config not found: ${displayPath(file)}. Create it from the template:\n  Copy-Item ${template} config/windows.json\nThen set command, args, env, and cwd for this machine.`);
    }
    throw new Error(`Cannot read Windows config ${displayPath(file)}: ${error.message}`);
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw invalid(file, `invalid JSON: ${error.message}`);
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid(file, 'the top-level value must be an object');
  if (typeof config.command !== 'string' || !config.command.trim()) throw invalid(file, 'command must be a non-empty string');
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))) throw invalid(file, 'args must be an array of strings');
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) throw invalid(file, 'env must be an object');
  if (typeof config.cwd !== 'string' || !config.cwd.trim()) throw invalid(file, 'cwd must be a non-empty string');
  return config;
}
