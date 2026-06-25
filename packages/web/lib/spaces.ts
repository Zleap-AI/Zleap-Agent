import {
  BookOpen,
  Bot,
  Brain,
  Code,
  Compass,
  Database,
  FileText,
  FlaskConical,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  PenLine,
  Rocket,
  Search,
  Send,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type SpaceItem = {
  id: string;
  label: string;
  icon?: string;
  accent?: string;
  kind: 'main' | 'work';
  description: string;
  when: string;
  notFor?: string;
  status: 'ready' | 'planned';
  budget: {
    maxToolIterations: number;
    timeoutMs?: number;
  };
};

export type SpaceMeta = SpaceItem & {
  iconComponent: LucideIcon;
  accent: string;
};

/**
 * The single source of truth for space iconography. The config UI (icon picker)
 * and every renderer (sidebar, 调度台 tabs, chat space blocks) reference THIS map
 * — icons are never hand-written per surface, so a space stays visually identical
 * everywhere it appears. Keys are kebab-case lucide names stored on the record.
 */
export const SPACE_ICONS: Record<string, LucideIcon> = {
  compass: Compass,
  search: Search,
  terminal: Terminal,
  'pen-line': PenLine,
  globe: Globe,
  send: Send,
  bot: Bot,
  'book-open': BookOpen,
  sparkles: Sparkles,
  database: Database,
  code: Code,
  wrench: Wrench,
  'flask-conical': FlaskConical,
  rocket: Rocket,
  'message-square': MessageSquare,
  image: ImageIcon,
  'file-text': FileText,
  brain: Brain,
};

/** Ordered candidate list for the icon picker. */
export const SPACE_ICON_NAMES: string[] = Object.keys(SPACE_ICONS);

/** Built-in accent palette for the color picker (10 named swatches). */
export const SPACE_COLOR_OPTIONS: Array<{ value: string; name: string }> = [
  { value: '#b07d4b', name: 'Amber' },
  { value: '#2563eb', name: 'Blue' },
  { value: '#e11d48', name: 'Rose' },
  { value: '#d97706', name: 'Orange' },
  { value: '#0d9488', name: 'Teal' },
  { value: '#7c3aed', name: 'Violet' },
  { value: '#16a34a', name: 'Green' },
  { value: '#db2777', name: 'Pink' },
  { value: '#0891b2', name: 'Cyan' },
  { value: '#64748b', name: 'Slate' },
];

export const SPACE_COLORS: string[] = SPACE_COLOR_OPTIONS.map((option) => option.value);

export const DEFAULT_SPACE_ICON = 'compass';
export const DEFAULT_SPACE_ACCENT = SPACE_COLORS[0]!;
export const DEFAULT_MAX_TOOL_STEPS = 200;

/** Resolve a stored icon name to its component, falling back to the default. */
export function resolveSpaceIcon(name?: string): LucideIcon {
  return (name && SPACE_ICONS[name]) || SPACE_ICONS[DEFAULT_SPACE_ICON]!;
}

/** Human-readable label for an icon name ('flask-conical' → 'Flask Conical'). */
export function iconLabel(name: string): string {
  return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

const FALLBACK: SpaceMeta = {
  id: 'workspace',
  label: 'Workspace',
  icon: DEFAULT_SPACE_ICON,
  iconComponent: SPACE_ICONS[DEFAULT_SPACE_ICON]!,
  accent: '#64748b',
  kind: 'work',
  description: '',
  when: '',
  status: 'ready',
  budget: { maxToolIterations: DEFAULT_MAX_TOOL_STEPS },
};

export function spaceMeta(
  spaces: Array<{ id: string; label?: string; icon?: string; accent?: string }>,
  id: string,
  label?: string,
): SpaceMeta {
  const found = spaces.find((space) => space.id === id);
  return {
    ...FALLBACK,
    id,
    label: found?.label ?? label ?? FALLBACK.label,
    icon: found?.icon ?? FALLBACK.icon,
    iconComponent: resolveSpaceIcon(found?.icon),
    accent: found?.accent ?? FALLBACK.accent,
  };
}

export function parseDispatchCommand(text: string): { space: string; goal: string } | null {
  const match = /^\/([a-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(text.trim());
  if (!match) {
    return null;
  }
  return { space: match[1]!, goal: match[2]!.trim() };
}
