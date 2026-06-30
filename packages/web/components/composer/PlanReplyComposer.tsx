'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, CornerDownLeft, PenLine } from 'lucide-react';
import { isComposerCompositionKeyEvent } from '@/lib/composerKeyboard';
import type { ChatSendOptions } from '@/lib/runModes';
import type { PlanReplyPrompt } from '@/lib/planOptions';

type PlanReplyAnswer = {
  question: string;
  optionId?: string;
  label: string;
};

export function PlanReplyComposer({
  prompt,
  running,
  onSubmit,
  onDismiss,
}: {
  prompt: PlanReplyPrompt;
  running: boolean;
  onSubmit: (text: string, options?: ChatSendOptions) => boolean;
  onDismiss: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const [customText, setCustomText] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<PlanReplyAnswer[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState(() => prompt.questions[0]?.options[0]?.id);
  const composingRef = useRef(false);
  const compositionCommitGuardRef = useRef(false);
  const compositionCommitGuardTimerRef = useRef<number | null>(null);
  const currentQuestion = prompt.questions[questionIndex];
  const selectedOption = currentQuestion?.options.find((option) => option.id === selectedOptionId) ?? currentQuestion?.options[0];
  const canSubmitCustom = customText.trim().length > 0;
  const hasQuestions = prompt.questions.length > 0;
  const showQuestionCount = prompt.questions.length > 1;
  const lastQuestion = questionIndex >= prompt.questions.length - 1;

  useEffect(() => {
    setCustomText('');
    setQuestionIndex(0);
    setAnswers([]);
    setSelectedOptionId(prompt.questions[0]?.options[0]?.id);
  }, [prompt.messageId]);

  useEffect(() => {
    return () => {
      if (compositionCommitGuardTimerRef.current) {
        window.clearTimeout(compositionCommitGuardTimerRef.current);
      }
    };
  }, []);

  const startComposition = () => {
    composingRef.current = true;
    compositionCommitGuardRef.current = false;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
      compositionCommitGuardTimerRef.current = null;
    }
  };

  const endComposition = () => {
    composingRef.current = false;
    compositionCommitGuardRef.current = true;
    if (compositionCommitGuardTimerRef.current) {
      window.clearTimeout(compositionCommitGuardTimerRef.current);
    }
    compositionCommitGuardTimerRef.current = window.setTimeout(() => {
      compositionCommitGuardRef.current = false;
      compositionCommitGuardTimerRef.current = null;
    }, 30);
  };

  const submitCustom = () => {
    const text = customText.trim();
    if (!text || running) return;
    if (currentQuestion) {
      submitQuestionAnswer({
        question: currentQuestion.question,
        label: `其它要求: ${text}`,
      });
      return;
    }
    if (onSubmit(`其它要求: ${text}`)) {
      setCustomText('');
    }
  };

  const submitQuestionAnswer = (answer: PlanReplyAnswer) => {
    if (running) return;
    const nextAnswers = [...answers.slice(0, questionIndex), answer];
    if (!lastQuestion) {
      const nextIndex = questionIndex + 1;
      setAnswers(nextAnswers);
      setQuestionIndex(nextIndex);
      setSelectedOptionId(prompt.questions[nextIndex]?.options[0]?.id);
      setCustomText('');
      return;
    }
    const response = formatPlanQuestionAnswers(nextAnswers);
    if (onSubmit(response)) {
      setCustomText('');
    }
  };

  const submitPrimary = () => {
    if (running) return;
    if (selectedOption) {
      submitQuestionAnswer({
        question: currentQuestion?.question ?? '',
        optionId: selectedOption.id,
        label: selectedOption.label,
      });
      return;
    }
    if (!hasQuestions && prompt.needsExecuteConfirmation) {
      onSubmit('执行', { runMode: 'normal' });
    }
  };

  return (
    <div className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
        <div className="min-w-0 text-sm font-semibold leading-6 text-foreground">
          {currentQuestion?.question ?? t('plan.defaultQuestion', { defaultValue: '是否按这个计划继续执行？' })}
        </div>
        {showQuestionCount ? (
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <ChevronLeft className="size-4" strokeWidth={1.75} />
            <span>{questionIndex + 1} of {prompt.questions.length}</span>
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </div>
        ) : null}
      </div>

      {currentQuestion ? (
        <div className="px-3 py-2">
          {currentQuestion.options.map((option, index) => {
            const selected = option.id === selectedOption?.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedOptionId(option.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm leading-5 transition ${
                  selected ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/70'
                }`}
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    selected ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {option.label}
                  {option.recommended ? <span className="ml-1 text-muted-foreground">(Recommended)</span> : null}
                </span>
                {selected ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground/65">
                    <ArrowUp className="size-3.5" strokeWidth={1.8} />
                    <ArrowDown className="size-3.5" strokeWidth={1.8} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <form
        className="flex items-center gap-2 border-t border-border bg-card py-3 pl-6 pr-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmitCustom) submitCustom();
          else submitPrimary();
        }}
      >
        <PenLine className="size-5 shrink-0 rounded-full border border-border bg-muted p-1 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={customText}
          onChange={(event) => setCustomText(event.target.value)}
          onCompositionStart={startComposition}
          onCompositionEnd={endComposition}
          onKeyDown={(event) => {
            if (isComposerCompositionKeyEvent(event, {
              composing: composingRef.current,
              commitGuard: compositionCommitGuardRef.current,
            })) {
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onDismiss(prompt.messageId);
            }
          }}
          placeholder={t('plan.adjustPlaceholder', { defaultValue: '否，请告知Zleap如何调整' })}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground/70"
        />
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => onDismiss(prompt.messageId)}
          className="hidden shrink-0 px-1 text-xs leading-none text-muted-foreground transition hover:text-foreground sm:inline"
        >
          {t('plan.ignore', { defaultValue: '忽略' })}&nbsp;<kbd className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-foreground">ESC</kbd>
        </button>
        <button
          type="submit"
          disabled={running || (!canSubmitCustom && hasQuestions && !selectedOption)}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {canSubmitCustom ? t('common.send', { defaultValue: '发送' }) : t('common.continue', { defaultValue: '继续' })}
          <CornerDownLeft className="size-3.5" strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}

function formatPlanQuestionAnswers(answers: PlanReplyAnswer[]): string {
  return [
    '计划问题回答:',
    ...answers.map((answer, index) => {
      const selected = answer.optionId ? `${answer.optionId}. ${answer.label}` : answer.label;
      return `${index + 1}. ${answer.question}\n   ${selected}`;
    }),
  ].join('\n');
}
