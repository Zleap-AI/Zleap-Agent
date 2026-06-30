import type { ModelConfigRecord } from '@zleap/core';
import { toEngineModel } from '@zleap/agent/conversation';
import { createSharedStore } from '@zleap/agent/conversation';

export type SelectableModel = {
  id: string;
  label: string;
  model: string;
  isDefault: boolean;
};

export async function listSelectableModels(): Promise<SelectableModel[]> {
  const store = await createSharedStore({ onWarn: () => undefined });
  if (!store) {
    return [];
  }
  try {
    const rows = await store.models.listModelConfigs();
    return rows
      .filter((row) => row.purpose !== 'embedding' && toEngineModel(row))
      .map((row) => toSelectable(row));
  } finally {
    await store.close().catch(() => undefined);
  }
}

function toSelectable(row: ModelConfigRecord): SelectableModel {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const display = typeof config.displayName === 'string' ? config.displayName : row.id;
  return {
    id: row.id,
    label: `${display} (${row.model})`,
    model: row.model,
    isDefault: config.isDefault === true,
  };
}

export function formatModelPickerList(models: SelectableModel[]): string {
  if (models.length === 0) {
    return '数据库中暂无模型配置。将进入手动配置向导，或在 Web 管理台添加模型。';
  }
  const lines = ['选择模型（输入编号，0 = 手动配置）：'];
  lines.push(`   0. 手动配置 OpenAI 兼容 API`);
  models.forEach((item, index) => {
    const mark = item.isDefault ? ' ★' : '';
    lines.push(`  ${String(index + 1).padStart(2)}. ${item.label}${mark}`);
  });
  return lines.join('\n');
}
