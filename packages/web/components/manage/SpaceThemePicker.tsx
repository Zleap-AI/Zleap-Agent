'use client';

import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SPACE_COLOR_OPTIONS, SPACE_ICON_NAMES, iconLabel, resolveSpaceIcon } from '@/lib/spaces';

type SpaceThemePickerProps = {
  icon: string;
  accent: string;
  onIconChange: (icon: string) => void;
  onAccentChange: (accent: string) => void;
};

/**
 * Color + icon selectors for a space's theme, rendered as full-width dropdowns so
 * they line up with the rest of the form. Both lists are driven by the shared
 * registry in lib/spaces.ts (the same one every renderer reads), so what you pick
 * here is exactly what the sidebar, workspace-console tabs, and chat blocks will show.
 */
export function SpaceThemePicker({ icon, accent, onIconChange, onAccentChange }: SpaceThemePickerProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="space-y-1.5">
        <Label>{t('space.color')}</Label>
        <Select value={accent} onValueChange={onAccentChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPACE_COLOR_OPTIONS.map((color) => (
              <SelectItem key={color.value} value={color.value}>
                <span className="size-3.5 rounded-full" style={{ backgroundColor: color.value }} />
                {color.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t('space.icon')}</Label>
        <Select value={icon} onValueChange={onIconChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPACE_ICON_NAMES.map((name) => {
              const Icon = resolveSpaceIcon(name);
              return (
                <SelectItem key={name} value={name}>
                  <Icon className="size-4" style={{ color: accent }} />
                  {iconLabel(name)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
