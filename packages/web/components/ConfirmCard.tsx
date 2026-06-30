'use client';

import { CheckCircle2, Clock, RotateCcw, ShieldAlert, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ToolApprovalRequest } from '../lib/types';

type ConfirmCardProps = {
  request: ToolApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
  onDismiss?: () => void;
};

/** HITL approval prompt for a high-risk tool call. */
export function ConfirmCard({ request, onApprove, onDeny, onDismiss }: ConfirmCardProps) {
  const { t } = useTranslation();
  const status = request.status ?? 'waiting';
  const waiting = status === 'waiting';
  const config = statusConfig(status, t);
  const detail = request.preview?.trim() || (request.args && request.args !== '()' ? request.args : undefined);

  return (
    <div
      className={`animate-pop-in overflow-hidden rounded-xl border bg-card shadow-sm ${waiting ? 'border-primary/25 ring-1 ring-primary/10' : 'border-border'}`}
    >
      <div className="flex items-start gap-3 border-b border-border/60 bg-muted/30 px-4 py-3">
        <div className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${config.iconWrap}`}>
          <config.icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{config.label}</span>
            <Badge variant="secondary" className="h-5 max-w-full truncate font-mono text-2xs font-normal">
              {request.name}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{request.message ?? config.description}</p>
        </div>
        {!waiting && onDismiss ? (
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 -mt-1 size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            aria-label={t('common.close', { defaultValue: '关闭' })}
            title={t('common.close', { defaultValue: '关闭' })}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      {detail ? (
        <div className="max-h-28 overflow-auto border-b border-border/60 px-4 py-2.5">
          <pre className="whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed text-muted-foreground">{detail}</pre>
        </div>
      ) : null}

      {waiting ? (
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onDeny}>
            {t('chat.approval.deny', { defaultValue: '拒绝' })}
          </Button>
          <Button size="sm" onClick={onApprove}>
            {t('chat.approval.approve', { defaultValue: '批准运行' })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function statusConfig(status: NonNullable<ToolApprovalRequest['status']>, t: (key: string, opts?: { defaultValue?: string }) => string) {
  switch (status) {
    case 'approved':
      return {
        label: t('chat.approval.approved', { defaultValue: '已批准' }),
        description: t('chat.approval.approvedDesc', { defaultValue: '审批已提交，工具将继续执行。' }),
        icon: CheckCircle2,
        iconWrap: 'bg-primary/10 text-primary',
      };
    case 'rejected':
      return {
        label: t('chat.approval.rejected', { defaultValue: '已拒绝' }),
        description: t('chat.approval.rejectedDesc', { defaultValue: '审批已拒绝，工具不会执行。' }),
        icon: XCircle,
        iconWrap: 'bg-destructive/10 text-destructive',
      };
    case 'timeout':
      return {
        label: t('chat.approval.timeout', { defaultValue: '审批超时' }),
        description: t('chat.approval.timeoutDesc', { defaultValue: '等待时间过长，本次审批已按拒绝处理。' }),
        icon: Clock,
        iconWrap: 'bg-muted text-muted-foreground',
      };
    case 'expired':
      return {
        label: t('chat.approval.expired', { defaultValue: '审批已失效' }),
        description: t('chat.approval.expiredDesc', { defaultValue: '运行状态已经变化，这次审批不能再提交。' }),
        icon: Clock,
        iconWrap: 'bg-muted text-muted-foreground',
      };
    case 'retry':
      return {
        label: t('chat.approval.retry', { defaultValue: '需要重试' }),
        description: t('chat.approval.retryDesc', { defaultValue: '审批提交失败或内容已变化，请重新发起。' }),
        icon: RotateCcw,
        iconWrap: 'bg-accent text-accent-foreground',
      };
    case 'waiting':
    default:
      return {
        label: t('chat.approval.waiting', { defaultValue: '等待审批' }),
        description: t('chat.approval.waitingDesc', { defaultValue: '该工具可能修改你的机器或调用外部服务，请选择是否运行。' }),
        icon: ShieldAlert,
        iconWrap: 'bg-primary/10 text-primary',
      };
  }
}
