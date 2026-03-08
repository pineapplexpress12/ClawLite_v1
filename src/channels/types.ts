import type { Attachment } from './handlers/fileUpload.js';

/**
 * Inbound message from any channel.
 */
export interface InboundMessage {
  channelName: string;
  chatId: string;
  userId: string;
  text: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Outbound message to send via a channel.
 */
export interface OutboundMessage {
  text: string;
  parseMode?: 'plain' | 'markdown' | 'html';
  replyTo?: string;
}

/**
 * Approval request sent to user for confirmation.
 */
export interface ApprovalRequest {
  approvalId: string;
  chatId: string;
  actionType: string;
  title: string;
  preview: string;
  actions: ApprovalAction[];
}

/**
 * User's response to an approval request.
 */
export interface ApprovalAction {
  approvalId: string;
  action: 'approve' | 'reject' | 'revise';
  payload?: Record<string, unknown>;
}

/**
 * Channel adapter interface — implemented by each messaging platform.
 */
export interface ChannelAdapter {
  name: string;

  /** Start the adapter (connect, start polling, etc.) */
  start(): Promise<void>;

  /** Stop the adapter gracefully */
  stop(): Promise<void>;

  /** Send a text message to a chat */
  sendMessage(chatId: string, message: OutboundMessage): Promise<void>;

  /** Send a typing indicator */
  sendTypingIndicator?(chatId: string): Promise<void>;

  /** Send an approval request with buttons */
  sendApprovalRequest?(request: ApprovalRequest): Promise<void>;

  /** Register message handler */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;

  /** Register approval action handler */
  onApprovalAction?(handler: (action: ApprovalAction) => Promise<void>): void;
}
