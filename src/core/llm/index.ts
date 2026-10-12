// LLM client, providers, model registry (owner: agent-core). Entry points per SPEC §2.1.

export { createLlmClient, prepareMessages } from './client';
export type { ExtendedLlmClient, LlmClientOptions } from './client';
export { createModelRegistry, DEFAULT_CONTEXT_LENGTH, variantFromName, supportsThinkingFromName } from './registry';
export type { ModelRegistryImpl, RegistryOptions } from './registry';
export { LlmError, isLlmError, isContextOverflow, classifyHttpError } from './errors';
export type { LlmErrorKind } from './errors';
export { StreamParser, TRUNCATED_TOOL_CALL_ERROR, repairJson } from './parser';
export type { ToolCallEvent } from './parser';
export { parseTextToolCalls, coerceValue } from './textToolCalls';
export { normalizeBaseUrl, getDialect, setDialect, detectDialect, resetEndpointStates } from './dialect';
export type { Dialect } from './dialect';
export { SseParser, readSse } from './sse';
