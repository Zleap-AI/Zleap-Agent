import type { Message } from '@zleap/ai';
import type { CompactionSummaryDetails, RunPersistenceBridge } from '../persistence/runBridge.js';

type CompactionReason = 'manual_compact' | 'event_refresh';
type CompactionSummaryKind = 'workspace_summary' | 'event_refresh';
type CompactionStatus = 'pending' | 'written' | 'rejected' | 'failed';

type CompactionDurableSourceRef = NonNullable<ReturnType<RunPersistenceBridge['activeMainSessionWindowRef']>>;

export type CompactionSourceMetadata = {
  sourceId: string;
  sourceRefs: unknown[];
  durableSourceRef?: CompactionDurableSourceRef;
};

export type CompactionPersistenceInput = {
  spaceId?: string;
  summaryKind?: CompactionSummaryKind;
  summary?: string;
  foldStart: number;
  foldEnd: number;
  foldedMessages: number;
  foldedCharacters: number;
  foldedTurns: Message[];
  conversationId?: string;
  reason: CompactionReason;
  fromHook: boolean;
  firstKeptEntryId?: string;
  tokensAfter?: number;
  tailTokens?: number;
  triggerTokens?: number;
  compactionAttempt?: number;
};

export type CompactionServiceDeps = {
  runPersistence: Pick<RunPersistenceBridge, 'recordCompactionMemoryAudit' | 'recordCompactionSessionEntry'>;
  /** B 线抽取：把回落的对话片段抽取成 record 事件。返回 record id；
   *  `undefined` = 记忆未配置(unavailable)。抛错 = 抽取失败。 */
  ingestRecords: (input: { messages: Message[]; conversationId?: string; sourceId: string }) => Promise<string[] | undefined>;
  resolveSource: (input: { spaceId?: string; conversationId?: string; foldStart: number; foldEnd: number }) => CompactionSourceMetadata;
  buildDetails: (foldedTurns: Message[]) => CompactionSummaryDetails;
  estimateTokens: (foldedTurns: Message[], characters: number) => number;
};

export class CompactionService {
  constructor(private readonly deps: CompactionServiceDeps) {}

  async persistEventCandidate(input: CompactionPersistenceInput): Promise<string | undefined> {
    const summary = input.summary ?? renderEventRefreshEntry(input);
    const summaryDetails = this.deps.buildDetails(input.foldedTurns);
    const { sourceId, sourceRefs, durableSourceRef } = this.deps.resolveSource(input);
    const recordSessionCompaction = async (entry: {
      memoryStatus: CompactionStatus;
      memoryReason?: string;
      memoryId?: string;
      error?: unknown;
    }) => {
      return this.deps.runPersistence.recordCompactionSessionEntry({
        spaceId: input.spaceId,
        summaryKind: input.summaryKind ?? 'event_refresh',
        summary: summary ?? '',
        summaryDetails,
        sourceId,
        conversationId: input.conversationId,
        foldStart: input.foldStart,
        foldEnd: input.foldEnd,
        foldedMessages: input.foldedMessages,
        summarizedMessages: input.foldEnd,
        sourceRefs,
        firstKeptEntryId: input.firstKeptEntryId ?? durableSourceRef?.leafEntryId,
        charactersBefore: input.foldedCharacters,
        tokensBefore: this.deps.estimateTokens(input.foldedTurns, input.foldedCharacters),
        tokensAfter: input.tokensAfter,
        tailTokens: input.tailTokens,
        triggerTokens: input.triggerTokens,
        compactionAttempt: input.compactionAttempt,
        reason: input.reason,
        fromHook: input.fromHook,
        memoryStatus: entry.memoryStatus,
        memoryReason: entry.memoryReason,
        memoryId: entry.memoryId,
        error: entry.error,
      });
    };
    if (input.foldedMessages <= 0) {
      await this.deps.runPersistence.recordCompactionMemoryAudit({
        status: 'rejected',
        sourceId,
        conversationId: input.conversationId,
        foldedMessages: input.foldedMessages,
        summarizedMessages: input.foldEnd,
        sourceRefs,
        reason: 'empty_window',
        fromHook: input.fromHook,
      });
      return undefined;
    }
    let recordIds: string[] | undefined;
    try {
      recordIds = await this.deps.ingestRecords({ messages: input.foldedTurns, conversationId: input.conversationId, sourceId });
    } catch (error) {
      await this.deps.runPersistence.recordCompactionMemoryAudit({
        status: 'failed',
        sourceId,
        conversationId: input.conversationId,
        foldedMessages: input.foldedMessages,
        summarizedMessages: input.foldEnd,
        sourceRefs,
        error,
        fromHook: input.fromHook,
      });
      return recordSessionCompaction({ memoryStatus: 'failed', error });
    }
    if (recordIds === undefined) {
      await this.deps.runPersistence.recordCompactionMemoryAudit({
        status: 'rejected',
        sourceId,
        conversationId: input.conversationId,
        foldedMessages: input.foldedMessages,
        summarizedMessages: input.foldEnd,
        sourceRefs,
        reason: 'memory_service_unavailable',
        fromHook: input.fromHook,
      });
      return recordSessionCompaction({ memoryStatus: 'rejected', memoryReason: 'memory_service_unavailable' });
    }
    await this.deps.runPersistence.recordCompactionMemoryAudit({
      status: 'written',
      sourceId,
      conversationId: input.conversationId,
      foldedMessages: input.foldedMessages,
      summarizedMessages: input.foldEnd,
      sourceRefs,
      memoryId: recordIds[0],
      fromHook: input.fromHook,
    });
    return recordSessionCompaction({ memoryStatus: 'written', memoryId: recordIds[0] });
  }
}

function renderEventRefreshEntry(input: CompactionPersistenceInput): string {
  return [
    'Event refresh:',
    `- Extracted messages ${input.foldStart}-${input.foldEnd} into item/event memory.`,
    `- Extracted messages: ${input.foldedMessages}.`,
  ].join('\n');
}
