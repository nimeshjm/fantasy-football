import type { LlmAuditSink } from '../../src/ai/decide';
import type { LlmUsage } from '../../src/ai/provider';
import type { AttemptRecord, GateRecord } from './types';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export class RecordingAuditSink implements LlmAuditSink {
  private readonly attemptRecords: AttemptRecord[] = [];
  private readonly gateRecords: GateRecord[] = [];

  record(entry: Parameters<LlmAuditSink['record']>[0]): void {
    let usage: LlmUsage | undefined;
    if (
      isFiniteNumber(entry.meteredPromptTokens) &&
      isFiniteNumber(entry.meteredCompletionTokens) &&
      isFiniteNumber(entry.meteredNeurons)
    ) {
      usage = {
        promptTokens: entry.meteredPromptTokens,
        completionTokens: entry.meteredCompletionTokens,
        neurons: entry.meteredNeurons,
      };
      if (isFiniteNumber(entry.cachedTokens)) {
        usage.cachedTokens = entry.cachedTokens;
      }
    }

    this.attemptRecords.push({
      attempt: entry.attempt,
      outcome: entry.outcome,
      reason: entry.reason,
      rawResponse: entry.rawResponse,
      estNeuronsIn: entry.estNeuronsIn,
      estNeuronsOut: entry.estNeuronsOut,
      usage,
    });
  }

  recordGate(entry: Parameters<NonNullable<LlmAuditSink['recordGate']>>[0]): void {
    this.gateRecords.push({
      attempt: entry.attempt,
      accept: entry.accept,
      source: entry.source,
      overrideReason: entry.overrideReason,
      llmScore: entry.llmScore,
      deterministicScore: entry.deterministicScore,
    });
  }

  attempts(): AttemptRecord[] {
    return this.attemptRecords;
  }

  /** The transfer path gates once per retry, so this can hold several. */
  gates(): GateRecord[] {
    return this.gateRecords;
  }

  gate(): GateRecord | undefined {
    return this.gateRecords[this.gateRecords.length - 1];
  }
}
