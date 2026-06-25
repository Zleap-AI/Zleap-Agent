import {
  PLAN_EXECUTE_CONFIRM_MARKER,
  PLAN_QUESTION_END_MARKER,
  PLAN_QUESTION_START_MARKER,
} from './planMarkers.js';
import type { RunMode } from '@zleap/agent';

export function systemPromptWithRunControls(base: string, runMode: RunMode): string {
  const modePrompt = runModePrompt(runMode);
  if (!modePrompt) {
    return base;
  }
  return `${base}\n\n${modePrompt}`;
}

function runModePrompt(runMode: RunMode): string | undefined {
  if (runMode === 'plan') {
    return [
      '## 运行模式: 计划模式',
      '本轮只做分析和计划,不要执行工具,不要 dispatch 到工作空间,不要读写文件,不要运行命令,不要修改任何数据。',
      '如果关键信息不足,先从目标、交付形式、范围边界、技术路径、验收标准等角度思考,尽量提出 2-3 个真正关键的问题;只有确实只有一个关键点时才问 1 个问题。',
      '每个问题都要给出 2-3 个可点击选项。不要为了凑数问无意义的问题。',
      '不要在正文里重复列出问题和选项。问题和选项只能写在回复末尾的固定 JSON 提问块里:',
      PLAN_QUESTION_START_MARKER,
      '{"questions":[{"question":"这次计划希望最终指导产出什么？","options":[{"id":"1","label":"可运行 harness","recommended":true},{"id":"2","label":"调研报告"},{"id":"3","label":"先 MVP 文档"}]},{"question":"优先控制哪类风险？","options":[{"id":"1","label":"范围失焦"},{"id":"2","label":"技术不可行"},{"id":"3","label":"风险不可验收"}]}]}',
      PLAN_QUESTION_END_MARKER,
      '固定 JSON 提问块不能放进代码块,不能改写起止标记,JSON 必须可被 JSON.parse 解析。',
      '用户也可以直接输入其它要求来修改计划。信息足够后,输出“最终计划”,包括目标、步骤、风险、需要用户确认的点。',
      '当最终计划已经完整、下一步只需要用户确认是否执行时,不要写“请回复执行”这类自然语言确认句。',
      `请在回复最后单独输出固定标记: ${PLAN_EXECUTE_CONFIRM_MARKER}`,
      '固定标记不能放进代码块,不能改写大小写或标点。',
    ].join('\n');
  }
  if (runMode === 'goal') {
    return [
      '## 运行模式: 追求目标',
      '把用户请求当作最终目标。每完成一个阶段后都要自检: 目标是否满足、证据是什么、缺口是什么。',
      '如果仍有缺口,继续执行下一步,不要过早收尾。确认满足目标后停止执行,输出“最终目标报告”,包含目标、完成证据、剩余风险和产物位置。',
    ].join('\n');
  }
  return undefined;
}
