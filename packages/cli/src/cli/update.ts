export type UpdateCommandOptions = {
  version?: string;
  checkOnly?: boolean;
};

export async function runUpdateCommand(options: UpdateCommandOptions = {}): Promise<number> {
  const target = options.version?.trim();
  if (options.checkOnly) {
    process.stdout.write('Zleap CLI 更新由 npm 管理；Desktop 更新由 Tauri updater 或新版安装包管理。\n');
    process.stdout.write('运行 `npm outdated -g @zleap-ai/cli` 可检查 CLI npm 版本。\n');
    return 0;
  }

  process.stdout.write('Zleap 不再通过 CLI 自建下载 runtime。\n');
  process.stdout.write(
    target
      ? `CLI 更新请运行：npm install -g @zleap-ai/cli@${target}\n`
      : 'CLI 更新请运行：npm update -g @zleap-ai/cli\n',
  );
  process.stdout.write('Desktop 更新请安装新版 Zleap，或使用后续 Tauri updater。\n');
  return 0;
}
