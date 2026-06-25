import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { stopServe, zleapHome, zleapLayout } from '@zleap/host';

export type UninstallOptions = {
  gui?: boolean;
  full?: boolean;
  yes?: boolean;
};

export async function runUninstallCommand(options: UninstallOptions = {}): Promise<number> {
  if (options.gui) {
    process.stdout.write(
      'GUI 模式：请手动将 Zleap 从「应用程序」文件夹拖到废纸篓。\n' +
        'CLI runtime 与数据库未删除；如需一并移除请运行：zleap uninstall\n',
    );
    return 0;
  }

  const layout = zleapLayout();
  const home = zleapHome();

  if (options.full) {
    if (!options.yes) {
      const rl = createInterface({ input, output });
      const answer = await rl.question(`将删除整个 ${home}（含数据库）。输入 yes 确认：`);
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        process.stdout.write('已取消。\n');
        return 1;
      }
    }
    await stopServe().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    process.stdout.write(`已删除 ${home}\n`);
    return 0;
  }

  await stopServe().catch(() => undefined);
  for (const target of [layout.current, layout.previous, layout.binDir]) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
      process.stdout.write(`已删除 ${target}\n`);
    }
  }
  for (const file of [layout.metadataPath, layout.installStatePath, layout.bootstrapStatePath]) {
    if (existsSync(file)) {
      await rm(file, { force: true });
      process.stdout.write(`已删除 ${file}\n`);
    }
  }
  process.stdout.write(`用户数据与 Postgres 目录已保留（${home}）。\n`);
  return 0;
}
