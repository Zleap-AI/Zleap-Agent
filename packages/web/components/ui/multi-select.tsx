'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type MultiSelectOption = {
  value: string;
  label: string;
  hint?: string;
};

type MultiSelectProps = {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
};

/** A capability picker: searchable popover with checkable options and chips for
 *  the current selection. Used to mount tools/skills onto a Space. */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'Select…',
  emptyText = 'Nothing available.',
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const byValue = React.useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-9 w-full justify-between font-normal text-muted-foreground"
          >
            {selected.length > 0 ? `${selected.length} selected` : placeholder}
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command>
            <CommandInput placeholder="Search…" className="h-9" />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const active = selected.includes(option.value);
                  return (
                    <CommandItem key={option.value} value={`${option.label} ${option.value}`} onSelect={() => toggle(option.value)}>
                      <Check className={cn('mr-2 size-4', active ? 'opacity-100' : 'opacity-0')} />
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.hint ? <span className="ml-2 text-xs text-muted-foreground">{option.hint}</span> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((value) => (
            <Badge key={value} variant="secondary" className="h-6 gap-1 px-2.5 pr-1.5 text-xs font-normal">
              {byValue.get(value)?.label ?? value}
              <button
                type="button"
                onClick={() => toggle(value)}
                className="rounded-xs opacity-60 transition hover:opacity-100"
                aria-label={`Remove ${value}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
