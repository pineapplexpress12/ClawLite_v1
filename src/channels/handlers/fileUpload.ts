import { storeFileArtifact } from '../../db/artifacts.js';
import { storeTurn } from '../../session/sessionManager.js';
import { logger } from '../../core/logger.js';

export interface Attachment {
  filename?: string;
  mimeType: string;
  type: 'document' | 'image' | 'audio' | 'video';
  buffer?: Buffer;
  url?: string;
  size: number;
}

export interface FileUploadContext {
  channelName: string;
  chatId: string;
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Handle file attachments — download, store as artifact, acknowledge.
 */
export async function handleFileUpload(
  attachments: Attachment[],
  ctx: FileUploadContext,
): Promise<string[]> {
  const artifactIds: string[] = [];

  for (const attachment of attachments) {
    try {
      const artifactId = storeFileArtifact({
        type: `upload_${attachment.type}`,
        title: attachment.filename ?? `upload_${Date.now()}`,
        filePath: '', // Path set by storage layer
        fileSize: attachment.size,
        mimeType: attachment.mimeType,
      });

      artifactIds.push(artifactId);

      // Store reference in session
      storeTurn(
        ctx.chatId,
        ctx.channelName,
        'user',
        `[Uploaded file: ${attachment.filename ?? 'file'} (${attachment.mimeType}, ${formatBytes(attachment.size)})]`,
      );
    } catch (err) {
      logger.error('File upload failed', {
        filename: attachment.filename,
        error: (err as Error).message,
      });
    }
  }

  if (artifactIds.length > 0) {
    const names = attachments.map(a => a.filename ?? a.type).join(', ');
    await ctx.sendMessage(
      `Received: ${names}\nWhat would you like me to do with ${attachments.length > 1 ? 'these files' : 'this file'}?`,
    );
  }

  return artifactIds;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
