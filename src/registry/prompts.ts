// src/registry/prompts.ts
// Prompt text registry — re-exports from the canonical prompts file.
// This shim exists so every file under src/registry/ is self-contained
// (the registry layer imports prompt texts from here rather than reaching
// into src/prompts/ directly).

export {
  ANALYST_INSTRUCTIONS,
  instructionFor,
} from '../prompts/analyst-instructions';

export type {
  AnalystPromptId,
  AnalystInstruction,
} from '../prompts/analyst-instructions';