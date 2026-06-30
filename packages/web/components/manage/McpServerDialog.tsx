'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { slugify } from '@/lib/utils';
import { patchJson, postJson } from '@/lib/api';
import type { McpServerView } from '@/lib/useResources';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm, ManagePreviewBlock } from './manage-ui';

type Transport = 'stdio' | 'sse' | 'http';
type Mode = 'paste' | 'manual';

type McpServerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  server?: McpServerView | null;
  onSaved: () => void;
};

const TRANSPORTS: Transport[] = ['stdio', 'sse', 'http'];

type DiscoveryResult = { ok: boolean; count: number; error?: string };

type ParsedConfig = { name?: string; transport: Transport; command: string; args: string; url: string; env: string };

/** KEY=VALUE lines ⇄ a plain env record (values may contain '='; only split once). */
function envToLines(env: unknown): string {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

function linesToEnv(lines: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of lines.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Parse a pasted MCP config — the standard shape used by Claude Desktop / Cursor:
 *   { "mcpServers": { "<name>": { command, args, env } | { url, type } } }
 * Also accepts a bare single-server object or a one-key `{ "<name>": {...} }`.
 */
function parsePastedConfig(raw: string): ParsedConfig | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  let name: string | undefined;
  let def = json as Record<string, unknown>;
  const servers = def.mcpServers;
  if (servers && typeof servers === 'object') {
    const first = Object.entries(servers as Record<string, unknown>)[0];
    if (!first || !first[1] || typeof first[1] !== 'object') return null;
    name = first[0];
    def = first[1] as Record<string, unknown>;
  } else if (!('command' in def) && !('url' in def)) {
    const entries = Object.entries(def);
    const first = entries[0];
    if (entries.length === 1 && first && first[1] && typeof first[1] === 'object') {
      name = first[0];
      def = first[1] as Record<string, unknown>;
    }
  }

  const command = typeof def.command === 'string' ? def.command : '';
  const url = typeof def.url === 'string' ? def.url : '';
  const typeField = typeof def.type === 'string' ? def.type : typeof def.transport === 'string' ? def.transport : '';
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string').join(' ') : '';
  const env = envToLines(def.env);

  let transport: Transport = 'stdio';
  if (command) transport = 'stdio';
  else if (url) transport = typeField === 'sse' ? 'sse' : 'http';
  else if (typeField === 'stdio' || typeField === 'sse' || typeField === 'http') transport = typeField;

  if (!command && !url) return null; // nothing actionable
  return { name, transport, command, args, url, env };
}

/**
 * Add or edit an MCP server. PASTE parses a standard `mcpServers` JSON into
 * the shared form state; MANUAL exposes the same fields for direct edits.
 */
export function McpServerDialog({ open, onOpenChange, avatarId, server, onSaved }: McpServerDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('paste');
  const [paste, setPaste] = useState('');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPaste('');
    if (server) {
      const draft = serverToDraft(server);
      setMode('manual');
      setName(server.name);
      setTransport(server.transport);
      setCommand(draft.command);
      setArgs(draft.args);
      setUrl(draft.url);
      setEnv(draft.env);
      return;
    }
    setMode('paste');
    setName('');
    setTransport('stdio');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnv('');
  }, [open, server]);

  // Live-parse the pasted JSON straight into the shared state (no extra button);
  // the Manual tab then reflects whatever was recognized, ready to tweak.
  const onPasteChange = (raw: string) => {
    setPaste(raw);
    const parsed = parsePastedConfig(raw);
    if (!parsed) return;
    if (parsed.name) setName(parsed.name);
    setTransport(parsed.transport);
    setCommand(parsed.command);
    setArgs(parsed.args);
    setUrl(parsed.url);
    setEnv(parsed.env);
  };

  const submit = async () => {
    const id = server?.id ?? slugify(name);
    if (!id) {
      toast.error(t('mcp.validationName', { defaultValue: 'A server name is required.' }));
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      toast.error(t('mcp.validationCommand', { defaultValue: 'A command is required for stdio servers.' }));
      return;
    }
    if (transport !== 'stdio' && !url.trim()) {
      toast.error(t('mcp.validationUrl', { defaultValue: 'A URL is required for sse/http servers.' }));
      return;
    }
    const envRecord = transport === 'stdio' ? linesToEnv(env) : {};
    const config =
      transport === 'stdio'
        ? {
            command: command.trim(),
            args: args.split(/\s+/).map((a) => a.trim()).filter(Boolean),
            ...(Object.keys(envRecord).length ? { env: envRecord } : {}),
          }
        : { url: url.trim() };
    setBusy(true);
    try {
      const payload = { avatarId, id, name: name.trim(), transport, config };
      const res = (await (server
        ? patchJson('/api/mcp/servers', payload)
        : postJson('/api/mcp/servers', payload))) as {
        discovery?: DiscoveryResult;
      };
      const discovery = res.discovery;
      if (server) {
        toast.success(t('mcp.updated', { defaultValue: 'Updated {{name}}', name: name.trim() }));
      } else if (discovery?.ok) {
        toast.success(t('mcp.created', { defaultValue: 'Added {{name}} — discovered {{count}} tools', name: name.trim(), count: discovery.count }));
      } else {
        toast.warning(
          t('mcp.createdNoTools', {
            defaultValue: 'Added {{name}}, but tool discovery failed: {{error}}. Fix the config and hit Refresh.',
            name: name.trim(),
            error: discovery?.error ?? 'unknown error',
          }),
        );
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const preview = parsePastedConfig(paste);
  const previewName = preview?.name || name;
  const previewEnvCount = preview ? Object.keys(linesToEnv(preview.env)).length : 0;

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      expandable
      title={server ? t('mcp.edit', { defaultValue: 'Edit MCP Server' }) : t('mcp.new', { defaultValue: 'Add MCP Server' })}
      description={
        server
          ? t('mcp.editDesc', { defaultValue: 'Update this MCP server. Leave environment variables empty to keep existing stored values.' })
          : t('mcp.newDesc', { defaultValue: 'Connect an MCP server; its tools are discovered and added to the catalog automatically.' })
      }
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={server ? t('common.save') : t('common.create')}
          busy={busy}
        />
      }
    >
      <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)} className="flex min-h-[360px] w-full flex-col gap-4">
        <TabsList className="grid w-full shrink-0 grid-cols-2">
          <TabsTrigger value="paste">{t('mcp.tabPaste', { defaultValue: 'Paste JSON' })}</TabsTrigger>
          <TabsTrigger value="manual">{t('mcp.tabManual', { defaultValue: 'Manual' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="mt-0 flex min-h-0 flex-col gap-3 outline-none">
          <Textarea
            value={paste}
            onChange={(e) => onPasteChange(e.target.value)}
            placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
            spellCheck={false}
            className="field-sizing-fixed h-44 max-h-44 min-h-44 resize-none overflow-x-auto overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre"
          />
          <div className="min-h-22">
            {preview ? (
              <ManagePreviewBlock className="flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-primary">
                  <Check />
                  {t('mcp.parsed', { defaultValue: 'Recognized' })}
                </div>
                <div className="text-muted-foreground">
                  <span className="font-medium text-foreground">{previewName || '—'}</span> · {preview.transport}
                </div>
                <div className="truncate font-mono text-muted-foreground">
                  {preview.command ? `${preview.command} ${preview.args}`.trim() : preview.url}
                </div>
                {previewEnvCount > 0 ? (
                  <div className="text-muted-foreground">{t('mcp.envCount', { defaultValue: '{{count}} env vars', count: previewEnvCount })}</div>
                ) : null}
              </ManagePreviewBlock>
            ) : paste.trim() ? (
              <p className="text-xs text-destructive">{t('mcp.pasteInvalid', { defaultValue: "Couldn't parse — expecting an mcpServers JSON." })}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('mcp.pasteHint', { defaultValue: 'Paste your mcpServers config; switch to Manual to fine-tune.' })}</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="manual" className="mt-0 outline-none">
          <ManageForm>
            <ManageField label={t('common.name')} htmlFor="mcp-name">
              <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Context7" />
            </ManageField>

            <ManageField label={t('mcp.transport', { defaultValue: 'Transport' })}>
              <Select value={transport} onValueChange={(value) => setTransport(value as Transport)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TRANSPORTS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ManageField>

            {transport === 'stdio' ? (
              <>
                <ManageField label={t('mcp.command', { defaultValue: 'Command' })} htmlFor="mcp-command">
                  <Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono text-xs" />
                </ManageField>
                <ManageField label={t('mcp.args', { defaultValue: 'Arguments' })} htmlFor="mcp-args">
                  <Textarea id="mcp-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @upstash/context7-mcp" className="field-sizing-fixed font-mono text-xs" rows={2} />
                </ManageField>
                <ManageField label={t('mcp.env', { defaultValue: 'Environment (KEY=VALUE per line)' })} htmlFor="mcp-env">
                  <Textarea id="mcp-env" value={env} onChange={(e) => setEnv(e.target.value)} placeholder="AI302_API_KEY=sk-..." className="field-sizing-fixed font-mono text-xs" rows={2} />
                </ManageField>
              </>
            ) : (
              <ManageField label={t('mcp.url', { defaultValue: 'URL' })} htmlFor="mcp-url">
                <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://host/mcp" className="font-mono text-xs" />
              </ManageField>
            )}
          </ManageForm>
        </TabsContent>
      </Tabs>

      <ManagePreviewBlock className="text-xs text-muted-foreground">
        {t('mcp.envHint', { defaultValue: 'Env values (tokens/keys) are stored to spawn the server and are never sent to the model.' })}
      </ManagePreviewBlock>
    </ManageDialog>
  );
}

function serverToDraft(server: McpServerView): ParsedConfig {
  const config = server.config ?? {};
  const command = typeof config.command === 'string' ? config.command : '';
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string').join(' ') : '';
  const url = typeof config.url === 'string' ? config.url : '';
  const rawEnv = config.env;
  const env = typeof rawEnv === 'string' && rawEnv === '[redacted]' ? '' : envToLines(rawEnv);
  return { name: server.name, transport: server.transport, command, args, url, env };
}
