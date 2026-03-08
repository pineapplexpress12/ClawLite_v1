/**
 * Fast keyword/pattern detection to identify simple chat messages.
 * No LLM call needed — pure heuristics.
 */

const CHAT_PATTERNS: RegExp[] = [
  // Greetings
  /^(hey|hi|hello|howdy|yo|sup|what'?s up|good (morning|afternoon|evening))/i,
  // Gratitude
  /\b(thanks|thank you|thx|appreciated|great job|nice)\b/i,
  // Conversational — questions about the agent
  /\b(how are you|how'?s it going|what'?s new|tell me about yourself)\b/i,
  /\b(who are you|what are you|what can you do|what do you do)\b/i,
  /\b(your name|your capabilities|your features|how do you work)\b/i,
  /\b(help me|can you help|what should i|any ideas|any suggestions)\b/i,
  /\b(tell me (about|more)|explain|describe)\b/i,
  // Questions about the system, config, models, setup
  /\b(which model|what model|what llm|which llm|what api|which api)\b/i,
  /\b(you using|you use|you set|you configured|you connected|you running)\b/i,
  /\b(your model|your config|your setup|your system|your settings)\b/i,
  /\b(are you connected|are you set up|are you configured|are you ready)\b/i,
  // Questions about past work
  /\b(did you|what did|remember when|last time)\b/i,
  // Simple factual questions
  /^(what is|what'?s|who is|who are|where is|when is|how do i|how does|why is|why do|can you|could you|would you|do you|are you)\b/i,
  // Opinions and preferences
  /\b(what do you think|what'?s your|in your opinion|do you like|do you know)\b/i,
  // Acknowledgments
  /^(ok|okay|sure|got it|understood|cool|nice|good|great|awesome|perfect)\s*[.!?]*$/i,
  // Farewells
  /^(bye|goodbye|see you|later|good night|gn)\s*[.!?]*$/i,
  // Messages ending with ? that reference "you" — conversational about the agent
  /\byou\b.*[?]\s*$/i,
  // Short-to-medium messages ending with ? are likely conversational
  /^[^/].{0,120}[?]\s*$/,
];

/**
 * Detect if a message is simple chat (no job/template needed).
 * Returns true for greetings, thanks, simple questions, etc.
 */
export function isSimpleChat(text: string): boolean {
  const trimmed = text.trim();

  // Empty or very short messages are chat
  if (trimmed.length === 0) return true;
  if (trimmed.length <= 5 && !trimmed.startsWith('/')) return true;

  // Check keyword patterns
  return CHAT_PATTERNS.some(p => p.test(trimmed));
}
