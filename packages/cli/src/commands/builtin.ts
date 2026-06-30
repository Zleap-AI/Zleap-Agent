export type BuiltinCommand =
  | '/exit'
  | '/quit'
  | '/help'
  | '/status'
  | '/model'
  | '/mode'
  | '/plan'
  | '/normal'
  | '/goal'
  | '/permissions'
  | '/execute'
  | '/clear'
  | '/new'
  | '/memory'
  | '/context'
  | '/compact'
  | '/resume'
  | '/sessions'
  | '/spaces'
  | '/config'
  | '/doctor'
  | '/connect'
  | '/channels'
  | '/serve'
  | '/stop'
  | '/abort';

const COMMANDS = new Set<string>([
  '/exit',
  '/quit',
  '/help',
  '/status',
  '/model',
  '/mode',
  '/plan',
  '/normal',
  '/goal',
  '/permissions',
  '/execute',
  '/clear',
  '/new',
  '/memory',
  '/context',
  '/compact',
  '/resume',
  '/sessions',
  '/spaces',
  '/config',
  '/doctor',
  '/connect',
  '/channels',
  '/serve',
  '/stop',
  '/abort',
]);

export function parseBuiltinCommand(input: string): BuiltinCommand | undefined {
  const command = input.trim().split(/\s+/, 1)[0];
  return COMMANDS.has(command) ? (command as BuiltinCommand) : undefined;
}

export function parseConnectChannel(input: string): string | undefined {
  const parts = input.trim().split(/\s+/);
  if (parts[0] !== '/connect' || parts.length < 2) {
    return undefined;
  }
  return parts[1];
}
