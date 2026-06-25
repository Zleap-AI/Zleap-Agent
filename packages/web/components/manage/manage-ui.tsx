'use client';

import { useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Maximize, Minimize, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

type BadgeVariant = ComponentProps<typeof Badge>['variant'];

export function ManagePageShell({
  icon,
  title,
  subtitle,
  toolbar,
  onBack,
  actions,
  wide = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  toolbar?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const goBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    window.history.back();
  };

  return (
    <div className="soft-scroll h-full overflow-y-auto">
      <div className="sticky top-0 flex items-center gap-3 border-b border-border bg-background/85 px-5 py-3 backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={goBack} title={t('common.back')} aria-label={t('common.back')}>
          <ArrowLeft />
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn('mx-auto px-6 py-8', wide ? 'max-w-6xl' : 'max-w-3xl')}>
        {toolbar ? <div className="mb-6">{toolbar}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function ManageSearchBar({
  value,
  onChange,
  placeholder,
  right,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  right?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <InputGroup className="h-8 flex-1 rounded-lg bg-background">
        <InputGroupAddon align="inline-start" className="pl-2.5 pr-0 text-muted-foreground">
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          size="sm"
          className="h-8 text-[13px] placeholder:text-muted-foreground/70"
        />
        {value ? (
          <InputGroupAddon align="inline-end" className="pr-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange('')}
              title={t('common.clear', { defaultValue: '清除' })}
              aria-label={t('common.clear', { defaultValue: '清除' })}
            >
              <X />
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {right}
    </div>
  );
}

export function ManageSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-3 mt-6 text-sm font-semibold text-foreground first:mt-0', className)}>{children}</div>;
}

export function ManageEmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border py-14 text-center text-[13px] text-muted-foreground">
      {icon ? <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div> : null}
      {children}
    </div>
  );
}

export function ManageList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-0.5', className)}>{children}</div>;
}

export function ManageListRow({
  title,
  leading,
  badges,
  meta,
  actions,
  persistent,
  expanded,
  disabled,
  active,
  indent = 0,
  onOpen,
  className,
}: {
  title: ReactNode;
  leading?: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  persistent?: ReactNode;
  expanded?: boolean;
  disabled?: boolean;
  active?: boolean;
  indent?: boolean | number;
  onOpen?: () => void;
  className?: string;
}) {
  const interactive = Boolean(onOpen);
  const hasActions = actions !== undefined;
  const hasMeta = meta !== undefined;
  const hasPersistent = persistent !== undefined;
  const trailing = hasPersistent ? persistent : meta;
  const hasTrailing = trailing !== undefined;
  const indentPx = indent === true ? 18 : typeof indent === 'number' ? indent : 0;
  const trailingWidth = hasPersistent ? 'w-12' : hasMeta ? 'w-36' : '';
  const actionPlacement = hasPersistent ? 'right-14 w-28' : hasMeta ? 'right-2 w-36' : 'right-2 w-32';
  const style = indentPx ? ({ paddingLeft: 12 + indentPx } satisfies CSSProperties) : undefined;

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={expanded}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative flex h-9 items-center gap-2.5 rounded-lg border border-transparent px-2.5 text-[13px] transition-colors',
        interactive && 'cursor-pointer text-left',
        (interactive || hasActions) && 'hover:bg-muted/70 focus-within:bg-muted/70',
        active && 'bg-muted/70',
        disabled && 'opacity-55',
        className,
      )}
      style={style}
    >
      {leading ? <span className="flex h-5 shrink-0 items-center justify-center gap-1 text-muted-foreground [&_svg]:size-3.5">{leading}</span> : null}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        {badges}
      </div>
      {hasTrailing ? (
        <div
          className={cn('shrink-0 truncate text-right text-xs text-muted-foreground', trailingWidth, hasPersistent && 'flex items-center justify-end')}
          onClick={hasPersistent ? (event) => event.stopPropagation() : undefined}
        >
          {trailing}
        </div>
      ) : null}
      {hasActions ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-0 flex items-center justify-end gap-1 bg-muted pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
            hasPersistent ? 'rounded-lg pr-1' : 'rounded-r-lg',
            actionPlacement,
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function ManageStatusBadge({
  children,
  variant = 'secondary',
  className,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <Badge variant={variant} className={cn('h-5 px-1.5 text-[10px] font-normal', className)}>
      {children}
    </Badge>
  );
}

export function ManageDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'default',
  expandable = false,
  defaultExpanded = false,
  bodyClassName,
  contentClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'default' | 'editor';
  expandable?: boolean;
  defaultExpanded?: boolean;
  bodyClassName?: string;
  contentClassName?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    if (open) setExpanded(defaultExpanded);
  }, [defaultExpanded, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'grid max-h-[min(640px,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-md',
          size === 'editor' && 'max-h-[min(720px,calc(100vh-2rem))] sm:max-w-[720px]',
          expanded && 'h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] sm:max-w-[min(1120px,calc(100vw-2rem))]',
          contentClassName,
        )}
      >
        {expandable ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-9 top-2"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? t('common.collapse', { defaultValue: '还原' }) : t('common.expand', { defaultValue: '放大' })}
            aria-label={expanded ? t('common.collapse', { defaultValue: '还原' }) : t('common.expand', { defaultValue: '放大' })}
          >
            {expanded ? <Minimize /> : <Maximize />}
          </Button>
        ) : null}
        <DialogHeader className={cn('border-b border-border p-4', expandable ? 'pr-20' : 'pr-10')}>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <ScrollArea className="min-h-0 overflow-hidden">
          <div className={cn('flex flex-col gap-4 p-4', bodyClassName)}>{children}</div>
        </ScrollArea>
        {footer ? <DialogFooter className="m-0 shrink-0 rounded-none border-t bg-muted/50 px-4 py-3">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Standard manage dialog footer: ghost cancel + primary confirm, fixed at bottom. */
export function ManageDialogFooterActions({
  onCancel,
  onConfirm,
  cancelLabel,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  cancelLabel?: ReactNode;
  confirmLabel?: ReactNode;
  busy?: boolean;
  confirmDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        {cancelLabel ?? t('common.cancel')}
      </Button>
      <Button onClick={onConfirm} disabled={busy || confirmDisabled}>
        {confirmLabel ?? t('common.save', { defaultValue: '保存' })}
      </Button>
    </>
  );
}

export function ManageDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  badge,
  actions,
  children,
  footer,
  width = 'default',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'fixed inset-y-0 right-0 left-auto top-0 grid h-svh max-h-none max-w-none translate-x-0 translate-y-0 gap-0 rounded-none rounded-l-xl p-0 sm:max-w-none',
          footer ? 'grid-rows-[auto_minmax(0,1fr)_auto]' : 'grid-rows-[auto_minmax(0,1fr)]',
          width === 'narrow' && 'w-[min(420px,calc(100vw-1rem))]',
          width === 'default' && 'w-[min(520px,calc(100vw-1rem))]',
          width === 'wide' && 'w-[min(560px,calc(100vw-1rem))]',
        )}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate">{title}</DialogTitle>
                {badge}
              </div>
              {subtitle ? <DialogDescription className="mt-1 truncate">{subtitle}</DialogDescription> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-5 p-4">{children}</div>
        </ScrollArea>
        {footer ? <DialogFooter className="m-0 shrink-0 rounded-none border-t bg-muted/50 px-4 py-3">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

export function ManageForm({ className, ...props }: ComponentProps<typeof FieldGroup>) {
  return <FieldGroup className={cn('gap-4', className)} {...props} />;
}

export function ManageField({
  label,
  htmlFor,
  description,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Field className={className}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function ManageDetailGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-2', className)}>{children}</div>;
}

export function ManageDetailItem({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm text-foreground">{value || '-'}</div>
    </div>
  );
}

export function ManagePreviewBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg bg-muted/35 p-3 text-sm leading-relaxed text-foreground', className)}>{children}</div>;
}

export function ManageSeparator({ className }: { className?: string }) {
  return <Separator className={className} />;
}
