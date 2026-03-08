import { isSimpleChat } from './heuristics.js';

export type MessageIntent = 'chat' | 'command' | 'complex';

/**
 * Three-path router: classify incoming message.
 * - "command": starts with /
 * - "chat": simple greeting/question (no job needed)
 * - "complex": requires template selection and job execution
 */
export function routeMessage(text: string): MessageIntent {
  const trimmed = text.trim();

  // 1. Slash commands — free (no LLM call)
  if (trimmed.startsWith('/')) {
    return 'command';
  }

  // 2. Simple chat detection — heuristics only
  if (isSimpleChat(trimmed)) {
    return 'chat';
  }

  // 3. Everything else → complex (template selection via LLM)
  return 'complex';
}
