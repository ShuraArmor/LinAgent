/**
 * 会话账本子系统入口。
 * 见 types.ts 顶部注释了解设计动机。
 */

export type {
  Ledger, LedgerCore, LedgerSuggested, LedgerItem, LedgerPatch, PatchReport, Preset,
} from './types.ts';

export {
  createEmptyLedger, allocateItemId, normalizeLedger, enumerateItemArrays, itemCount,
} from './ledger.ts';

export { applyPatches, parsePath } from './patcher.ts';

export type { LedgerStore } from './store.ts';
export { MemoryLedgerStore, FileLedgerStore } from './store.ts';

export type { ArchiveStore, ArchiveSegment } from './archive.ts';
export { MemoryArchiveStore, FileArchiveStore, makeHandle, parseHandle } from './archive.ts';

export type { CompressionTriggerConfig } from './trigger.ts';
export {
  DEFAULT_TRIGGER, buildTriggerConfig, usableTokens, triggerTokens,
  shouldCompress, pickTailStartIndex, estimateTextTokens,
} from './trigger.ts';

export type { CompressionInput, CompressionOutput, CompressTraceData } from './compressor.ts';
export { tryCompress, compressTraceData } from './compressor.ts';

export type { RouteRule, ConsolidateReport, ConsolidateOptions } from './consolidator.ts';
export {
  consolidateLedgerToMemory, consolidateStable, inspectRoute,
  INCREMENTAL_MIN_VALUE, BACKSTOP_MIN_VALUE, MIN_STABLE_AGE,
} from './consolidator.ts';

export { updateLedgerTool } from './tool.ts';

export type { PresetSelection } from './preset.ts';
export { pickPreset, mergePresets, loadPresetsFromDir } from './preset.ts';
export { BUILTIN_PRESETS, DEFAULT_PRESET } from './presets.ts';
export type { ConversationClass, CompressionPolicy, RecallBias, Disposition, MessageFeature, LedgerShape } from './class-policy.ts';
export {
  resolveClass, classFromPresetName, compressionPolicyFor, recallBiasFor, featureOf, disposeOf,
  deriveClassFromStructure, classFromShape, emergentClass,
} from './class-policy.ts';

export type { EmergenceReport, EmergenceOptions } from './emergence.ts';
export { analyzeEmergence, renderEmergenceReport } from './emergence.ts';

export type { KindFeedback, FeedbackState, ControllerConfig, FeedbackStore } from './feedback.ts';
export {
  emptyFeedback, recordRecall, biasMap, normalizeFeedback,
  MemoryFeedbackStore, FileFeedbackStore, FeedbackController, DEFAULT_CONTROLLER,
} from './feedback.ts';

export {
  buildLedgerInstruction, renderLedgerForPrompt, renderPresetFewShot,
} from './prompt.ts';

export type { PrimitiveKind, ValueContext } from './primitive.ts';
export {
  kindOf, valueOf, isPrimitiveKind, allItemArrays, renderLedgerWithPrimitives,
} from './primitive.ts';
