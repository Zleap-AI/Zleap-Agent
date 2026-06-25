import { CONFIG_PATH } from '@zleap/host';
import { modelSourceLabel, type CliContext } from './context.js';

export function formatConfigSummary(ctx: CliContext): string {
  const modelName = ctx.model?.displayName ?? ctx.model?.model ?? '未配置';
  const db = ctx.persistence.databaseUrl
    ? ctx.dbReachable
      ? '已连接'
      : '不可达'
    : '未配置';
  return [
    '配置摘要',
    `  模型       ${modelName}`,
    `  来源       ${modelSourceLabel(ctx.modelSource)}`,
    `  配置文件   ${CONFIG_PATH}`,
    `  数据库     ${db}`,
    `  已初始化   ${ctx.config.onboarded ? '是' : '否'}`,
    '',
    '修改：zleap config list · zleap init · /model',
  ].join('\n');
}
