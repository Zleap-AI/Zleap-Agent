import type { CustomModelConfig } from '@zleap/ai';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, type CliConfig } from '@zleap/host';
import type { ModelWizard } from '../state/types.js';

export type WizardNotify = (text: string) => void;

/** Advance one step of the model wizard (shared by TUI and `zleap init`). */
export async function advanceModelWizard(options: {
  wizard: ModelWizard;
  text: string;
  notify: WizardNotify;
}): Promise<{ wizard: ModelWizard | null; config?: CliConfig }> {
  const { wizard, text, notify } = options;

  if (wizard.step === 'protocol') {
    const protocol = text.trim() === 'anthropic' ? 'anthropic' : 'openai';
    const hint =
      protocol === 'anthropic'
        ? '输入 base_url（回车 = https://api.anthropic.com/v1）'
        : '输入 base_url，例如 https://host/v1';
    notify(hint);
    return { wizard: { step: 'baseUrl', draft: { ...wizard.draft, protocol } } };
  }

  if (wizard.step === 'baseUrl') {
    const baseUrl = text.trim() || (wizard.draft.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : '');
    notify('输入 api_key。');
    return { wizard: { step: 'apiKey', draft: { ...wizard.draft, baseUrl } } };
  }

  if (wizard.step === 'apiKey') {
    notify('输入 model 名称。');
    return { wizard: { step: 'model', draft: { ...wizard.draft, apiKey: text } } };
  }

  const model: CustomModelConfig = {
    protocol: wizard.draft.protocol,
    baseUrl: wizard.draft.baseUrl ?? '',
    apiKey: wizard.draft.apiKey ?? '',
    model: text,
    id: text,
    displayName: text,
  };
  const existing = await loadConfig();
  const nextConfig: CliConfig = { ...existing, model };
  await saveConfig(nextConfig);
  notify(`已保存模型：${model.model}`);
  return { wizard: null, config: nextConfig };
}

/** Run the model wizard interactively via readline (for `zleap init`). */
export async function runModelWizardReadline(): Promise<CliConfig> {
  const rl = createInterface({ input, output });
  let wizard: ModelWizard | null = { step: 'protocol', draft: {} };
  output.write('选择 API 协议：anthropic / openai（回车 = openai）\n> ');
  try {
    while (wizard) {
      const line = await rl.question('');
      const result = await advanceModelWizard({
        wizard,
        text: line,
        notify: (text) => output.write(`${text}\n> `),
      });
      wizard = result.wizard;
      if (result.config) {
        return result.config;
      }
    }
    return loadConfig();
  } finally {
    rl.close();
  }
}

export function modelWizardStartHint(): string {
  return '选择 API 协议：anthropic / openai（回车 = openai）';
}
