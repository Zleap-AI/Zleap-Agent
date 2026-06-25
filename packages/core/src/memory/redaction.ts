const GENERIC_COMPANY_TERMS = new Set([
  '上市公司',
  '境外上市公司',
  '科技公司',
  '上市科技公司',
  '境外上市科技公司',
  '目标公司',
  '客户公司',
  '项目公司',
  '主体公司',
]);

const TECH_ENTITY_ALLOWLIST = new Set([
  'API',
  'APIs',
  'Analyze',
  'Build',
  'CSS',
  'Debug',
  'Deploy',
  'Docker',
  'Edit',
  'GitHub',
  'GitLab',
  'HTML',
  'Homebrew',
  'JSON',
  'JavaScript',
  'LaTeX',
  'Linux',
  'Markdown',
  'Next.js',
  'Node',
  'Node.js',
  'OpenAI',
  'Open-Meteo',
  'PDF',
  'Pandoc',
  'Playwright',
  'PostgreSQL',
  'Postgres',
  'Python',
  'React',
  'Read',
  'Report',
  'Research',
  'Retry',
  'Review',
  'Run',
  'SQLite',
  'SOP',
  'Search',
  'Tailwind',
  'Test',
  'TypeScript',
  'Vercel',
  'Vue',
  'WeasyPrint',
  'Weasyprint',
  'Windows',
  'macOS',
]);

export type SanitizedExperienceMemory = {
  title: string;
  content: string;
  redacted: boolean;
};

export type ExperienceMemoryAssessment =
  | (SanitizedExperienceMemory & { accepted: true })
  | { accepted: false; code: string; reason: string };

export class ExperienceMemoryRejectedError extends Error {
  readonly code = 'experience_memory_rejected';
  readonly rejectionCode: string;

  constructor(reason: string, rejectionCode = 'experience_not_reusable') {
    super(reason);
    this.name = 'ExperienceMemoryRejectedError';
    this.rejectionCode = rejectionCode;
  }
}

export function assessExperienceMemory(input: { title: string; content: string }): ExperienceMemoryAssessment {
  const rawTitle = input.title.trim();
  const rawContent = input.content.trim();
  if (!rawTitle || !rawContent) {
    return { accepted: false, code: 'experience_empty', reason: 'experience requires a non-empty memory' };
  }

  const sanitized = sanitizeExperienceMemory({ title: rawTitle, content: rawContent });
  const raw = `${rawTitle}\n${rawContent}`;
  const clean = `${sanitized.title}\n${sanitized.content}`;

  if (looksLikeBusinessFactDump(raw, clean)) {
    return {
      accepted: false,
      code: 'experience_business_facts',
      reason: 'experience must be reusable process knowledge, not company research, financial facts, or one-off task results',
    };
  }

  if (looksLikeOneOffTaskSummary(raw, clean)) {
    return {
      accepted: false,
      code: 'experience_task_summary',
      reason: 'experience must describe a reusable workflow or pitfall, not what was completed in one task',
    };
  }

  if (!hasReusableProcessSignal(clean)) {
    return {
      accepted: false,
      code: 'experience_weak_process_signal',
      reason: 'experience must clearly describe a reusable workflow, failure pattern, validation habit, or recovery strategy',
    };
  }

  return { accepted: true, ...sanitized };
}

export function sanitizeExperienceMemory(input: { title: string; content: string }): SanitizedExperienceMemory {
  const title = sanitizeExperienceText(input.title);
  const content = sanitizeExperienceText(input.content);
  return {
    title,
    content,
    redacted: title !== input.title || content !== input.content,
  };
}

export function sanitizeExperienceText(text: string): string {
  let output = text;
  output = redactExampleParentheticals(output);
  output = redactCompanyNames(output);
  output = redactPrivateLocations(output);
  output = redactNetworkAndAccounts(output);
  output = redactEnglishProperNames(output);
  return output.replace(/\s{2,}/g, ' ').trim();
}

function redactExampleParentheticals(text: string): string {
  return text
    .replace(/[（(]\s*(?:如|例如|比如|e\.g\.|eg|such as)\s*[^）)]{1,80}[）)]/giu, '（如同类对象）')
    .replace(/(?:如|例如|比如)\s+[A-Z][A-Za-z0-9&._-]{2,}(?=(?:的|、|，|,|\s|$))/g, '$1某同类对象');
}

function redactCompanyNames(text: string): string {
  return text.replace(
    /[\u3400-\u9fffA-Za-z0-9·&._-]{2,80}(?:股份有限公司|有限责任公司|集团有限公司|有限公司|集团|公司)/gu,
    (match) => {
      if (isGenericCompanyTerm(match)) {
        return match;
      }
      const prefix = leadingContextPrefix(match);
      return `${prefix}[公司]`;
    },
  );
}

function isGenericCompanyTerm(value: string): boolean {
  if (GENERIC_COMPANY_TERMS.has(value)) {
    return true;
  }
  for (const term of GENERIC_COMPANY_TERMS) {
    if (value.endsWith(term)) {
      return true;
    }
  }
  return false;
}

function leadingContextPrefix(value: string): string {
  const prefixes = ['面向', '校验', '区分', '绘制', '复盘', '调研', '分析', '关于', '针对', '检查', '确认', '记录', '查询', '如'];
  return prefixes.find((prefix) => value.startsWith(prefix)) ?? '';
}

function redactPrivateLocations(text: string): string {
  return text
    .replace(/(?:\/Users|\/home|\/var\/folders|\/private|\/tmp|\/opt\/homebrew)\/[^\s，。；;,)）"'`]+/g, '[本地路径]')
    .replace(/[A-Za-z]:\\[^\s，。；;,)）"'`]+/g, '[本地路径]');
}

function redactNetworkAndAccounts(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱]')
    .replace(/https?:\/\/[^\s，。；;,)）"'`]+/giu, '[链接]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s，。；;,)）"'`]+/giu, '$1=[已脱敏]');
}

function redactEnglishProperNames(text: string): string {
  return text.replace(/\b[A-Z][A-Za-z0-9][A-Za-z0-9._-]{2,}\b/g, (match) =>
    TECH_ENTITY_ALLOWLIST.has(match) ? match : '[具体名称]');
}

function looksLikeBusinessFactDump(raw: string, clean: string): boolean {
  const text = `${raw}\n${clean}`;
  const hasBusinessSubject = /(?:估值|营收|收入|利润|融资|股价|市值|财务|二级交易|SEC|上市|工商|主体|创始人|投资人|广告作弊|做空报告|监管调查|诉讼|洗钱指控)/i.test(text);
  if (!hasBusinessSubject) {
    return false;
  }
  const hasPreciseFact = /(?:\d{4}\s*年|[$￥¥]|美元|美金|亿元|百万|千万|\/股|%|[0-9]+(?:\.[0-9]+)?\s*(?:亿|万|M|B|million|billion))/i.test(text);
  const hasResearchObject = /(?:\[具体名称\]|\[公司\]|公司|品牌|客户|项目|目标对象|调研对象)/.test(text);
  return hasPreciseFact || hasResearchObject;
}

function looksLikeOneOffTaskSummary(raw: string, clean: string): boolean {
  const text = `${raw}\n${clean}`;
  if (/(?:完成|已完成|生成|输出|保存|最终形成|本次|这次)\S{0,40}(?:调研|报告|PDF|文件|网页|页面|数据|结果)/.test(text)) {
    return true;
  }
  if (/(?:使用|用了)\s*\d+\+?\s*组关键词/.test(text)) {
    return true;
  }
  return /(?:信息来源包括|最终形成|输出为|保存为|报告交付|调研报告)/.test(text);
}

function hasReusableProcessSignal(text: string): boolean {
  return /(?:流程|方法|策略|模式|SOP|checklist|清单|优先|先|再|最后|遇到|如果|当.*时|避免|确保|验证|复核|回退|兜底|恢复|失败|错误|异常|重试|限流|缓存|降级|排查|修复|复用|workflow|process|lesson|practice|pitfall|fallback|retry|validate|debug|deploy|test|dry[- ]?run|write tasks|CI|API|PDF|Python|macOS|finally|loading)/i.test(text);
}
