/**
 * Detect if a message is a COMPLEX action request (needs template/workflow/tools).
 * If this returns true, the message goes to the complex handler.
 * Everything else goes to the lightweight chat handler.
 */

const ACTION_PATTERNS: RegExp[] = [
  // Email actions
  /\b(check|read|show|list|get|fetch)\s+(my\s+)?(inbox|email|mail|unread|messages)\b/i,
  /\b(draft|write|compose|reply|respond|send)\s+(a\s+|an\s+)?(email|mail|reply|response|message to)\b/i,
  /\b(send|forward|email)\s+(it|that|this|the)\b/i,
  /\bsend\s+(to|this|that|the|it)\b/i,

  // Calendar actions
  /\b(check|show|list|get|what'?s on)\s+(my\s+)?(calendar|schedule|events|meetings|today|tomorrow)\b/i,
  /\b(schedule|create|book|set up|arrange)\s+(a\s+)?(meeting|event|call|appointment)\b/i,

  // Research actions
  /\b(research|look up|look into|find out|investigate|search|dig into)\s/i,
  /\b(deep research|find information|gather data)\b/i,

  // Content/publishing actions
  /\b(draft|write|create|generate)\s+(\d+\s+)?(tweets?|posts?|content|article|blog)\b/i,
  /\b(post|publish|share)\s+(to|on)\s+(twitter|x|linkedin|social)\b/i,

  // File/document actions
  /\b(create|generate|make)\s+(a\s+|an\s+)?(invoice|report|document|pdf|spreadsheet)\b/i,
  /\b(upload|download|share|attach)\s+(a\s+|the\s+)?(file|document|pdf|image)\b/i,

  // Agent/tool building actions
  /\b(build|create|set up|configure|make)\s+(a\s+|an\s+|me\s+a\s+)?(agent|tool|workflow|sub-?agent|team)\b/i,
  /\b(install|add|connect|enable|disable)\s+(a\s+|the\s+)?(tool|plugin|skill|integration|service)\b/i,
  /\b(i need|i want|set me up|get me)\s+(a|an|to)\b.*\b(agent|tool|manager|system|automation)\b/i,

  // Config change actions (via natural language, not slash commands)
  /\b(change|update|set|switch|modify)\s+(my\s+|the\s+)?(model|tier|config|budget|provider|settings)\b/i,
  /\bstrong\s+should\s+be\b/i,
  /\b(fast|balanced|strong)\s+(tier|model)\s+(should|to|=)\b/i,

  // Connection/setup actions
  /\b(connect|link|pair|authenticate|set up|configure)\s+(gws|google|gmail|calendar|drive|workspace|twitter|whatsapp|telegram|discord|slack)\b/i,

  // Management actions
  /\b(pause|resume|delete|stop|start|restart)\s+(the\s+)?(agent|sub-?agent|job|task|workflow)\b/i,
  /\b(check|show|what'?s)\s+(the\s+)?(status|budget|progress)\b/i,

  // Explicit action verbs at start of message
  /^(check|send|draft|write|create|build|research|schedule|book|set|update|change|install|connect|upload|download|generate|make|run|execute|find|search|list|show|get|fetch|delete|remove|pause|resume)\s/i,
];

/**
 * Detect if a message is simple chat (no action needed).
 * ONLY returns true for clearly conversational messages.
 * When in doubt, returns false (routes to complex, which can fall back to chat).
 */
export function isSimpleChat(text: string): boolean {
  const trimmed = text.trim();

  // Empty = chat
  if (trimmed.length === 0) return true;

  // Very short non-slash messages that are just acknowledgments
  if (/^(ok|okay|sure|got it|yes|no|yep|nope|cool|nice|great|awesome|thanks|thank you|thx|bye|hello|hi|hey|yo|sup)[\s.!?]*$/i.test(trimmed)) {
    return true;
  }

  // If it matches ANY action pattern, it's NOT chat
  if (ACTION_PATTERNS.some(p => p.test(trimmed))) {
    return false;
  }

  // Pure greetings
  if (/^(hey|hi|hello|howdy|good (morning|afternoon|evening|night))[\s,!.?]*$/i.test(trimmed)) {
    return true;
  }

  // Pure farewells
  if (/^(bye|goodbye|see you|later|good night|gn)[\s!.?]*$/i.test(trimmed)) {
    return true;
  }

  // Short conversational questions about the agent itself (identity, not action)
  if (/^(who are you|what are you|what'?s your name|how are you|what'?s up)[\s?.!]*$/i.test(trimmed)) {
    return true;
  }

  // Default: NOT chat. Let the complex handler decide.
  // The complex handler can fall back to chat if template confidence is low.
  // This is safer than accidentally routing action requests to chat.
  return false;
}
