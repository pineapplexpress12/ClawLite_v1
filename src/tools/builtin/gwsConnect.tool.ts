import { z } from 'zod';
import { spawn, execSync } from 'node:child_process';
import type { ToolDefinition, ToolContext } from '../sdk/types.js';

const schema = z.object({});

function isGwsInstalled(): boolean {
  try {
    execSync('gws --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installGws(): { success: boolean; error?: string } {
  try {
    execSync('npm install -g @googleworkspace/cli', {
      stdio: 'pipe',
      timeout: 120000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function runGwsCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('gws', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      console.log('[GWS STDOUT]', d.toString().trim());
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      console.log('[GWS STDERR]', d.toString().trim());
    });

    // Give 30 seconds for the auth flow — the URL should appear in stdout within a few seconds
    const timeout = setTimeout(() => {
      resolve({ code: -1, stdout, stderr });
    }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

function extractOAuthUrl(text: string): string | null {
  const urlPatterns = [
    /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"']+/,
    /https:\/\/accounts\.google\.com\/[^\s"']+/,
    /https?:\/\/[^\s"']*google[^\s"']*oauth[^\s"']*/i,
    /https?:\/\/[^\s"']*google[^\s"']*auth[^\s"']*/i,
    /(https?:\/\/[^\s"']+)/,  // fallback: any URL
  ];

  for (const pattern of urlPatterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Build the result for a gws auth login attempt.
 * Extracts OAuth URL from stdout/stderr and returns it for the agent to present as a clickable link.
 */
function buildAuthResult(
  authResult: { code: number; stdout: string; stderr: string },
  steps: string[],
): Record<string, unknown> {
  if (authResult.code === 0) {
    return {
      status: 'connected',
      message: 'Google Workspace is now connected! I can access Gmail, Calendar, and Drive. Try "check my inbox" now.',
      steps,
    };
  }

  const oauthUrl = extractOAuthUrl(authResult.stdout) || extractOAuthUrl(authResult.stderr);

  if (oauthUrl || authResult.code === -1) {
    return {
      status: 'auth_url',
      message: oauthUrl
        ? `Click this link to authorize Google Workspace:\n\n${oauthUrl}\n\nAfter authorizing, say "check my inbox" to verify.`
        : 'The OAuth flow started but I couldn\'t capture the login URL. Check your browser, or try "connect gws" again.',
      url: oauthUrl,
      steps,
    };
  }

  return {
    status: 'error',
    message: 'Something went wrong during Google Workspace connection.',
    error: authResult.stderr || authResult.stdout,
    steps,
  };
}

export const GwsConnectTool: ToolDefinition<typeof schema> = {
  name: 'gws_connect',
  description: 'Install and connect Google Workspace (Gmail, Calendar, Drive). Installs the gws CLI if needed, then starts OAuth login which opens the user\'s browser. Call this when GWS is not connected.',
  version: '1.0.0',
  permissions: [],
  risk: 'medium',
  requiredSecrets: [],
  schema,
  jsonSchema: { type: 'object', properties: {} },

  async handler(_params, _ctx: ToolContext) {
    const steps: string[] = [];

    // Step 1: Check if gws is installed
    if (!isGwsInstalled()) {
      steps.push('gws CLI not found — installing @googleworkspace/cli...');
      const install = installGws();
      if (!install.success) {
        return {
          status: 'install_failed',
          message: 'Failed to install the Google Workspace CLI.',
          error: install.error,
          steps,
        };
      }
      steps.push('gws CLI installed successfully.');
    } else {
      steps.push('gws CLI is already installed.');
    }

    // Step 2: Run gws auth login (opens browser)
    steps.push('Starting Google OAuth...');
    const result = await runGwsCommand(['auth', 'login']);

    if (result.code === 0) {
      return {
        status: 'connected',
        message: 'Google Workspace is now connected! I can access Gmail, Calendar, and Drive. Try "check my inbox" now.',
        steps,
      };
    }

    // If auth login fails because of missing client credentials, try to find and copy client_secret
    if (result.stderr.includes('client') || result.stderr.includes('credentials') || result.stderr.includes('OAuth') || result.stderr.includes('auth setup') || result.stderr.includes('project')) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const searchPaths = [
        process.cwd(),
        `${process.cwd()}/.clawlite`,
        `${homeDir}/Desktop`,
        `${homeDir}/Downloads`,
        `${homeDir}/Documents`,
      ];

      let clientSecretFound = '';
      for (const dir of searchPaths) {
        try {
          const files = execSync(`ls "${dir}" 2>/dev/null`, { encoding: 'utf-8' }).split('\n');
          const match = files.find(f => f.includes('client_secret') && f.endsWith('.json'));
          if (match) {
            clientSecretFound = `${dir}/${match.trim()}`;
            break;
          }
        } catch { /* directory doesn't exist or can't be listed */ }
      }

      if (clientSecretFound) {
        steps.push(`Found OAuth client file: ${clientSecretFound}`);
        try {
          execSync(`mkdir -p "${homeDir}/.config/gws"`);
          execSync(`cp "${clientSecretFound}" "${homeDir}/.config/gws/client_secret.json"`);
          steps.push('Copied client_secret.json to ~/.config/gws/');

          // Retry auth login — capture URL
          steps.push('Retrying Google OAuth login...');
          const retry = await runGwsCommand(['auth', 'login']);
          return buildAuthResult(retry, steps);
        } catch (copyErr) {
          steps.push(`Failed to copy: ${(copyErr as Error).message}`);
        }
      }

      // Try gws auth setup as a fallback
      steps.push('Trying gws auth setup...');
      const setup = await runGwsCommand(['auth', 'setup']);

      if (setup.code === 0 || setup.stdout.includes('success')) {
        steps.push('Project setup complete. Now running OAuth login...');
        const loginRetry = await runGwsCommand(['auth', 'login']);
        return buildAuthResult(loginRetry, steps);
      }

      // gcloud might be missing
      if (setup.stderr.includes('gcloud')) {
        return {
          status: 'needs_gcloud',
          message: 'Google Cloud SDK (gcloud) is needed for initial setup but isn\'t installed. Here\'s what to do:\n\n1. Go to https://cloud.google.com/sdk/docs/install\n2. Install gcloud for your OS\n3. Then say "connect google workspace" again and I\'ll finish the setup.',
          steps,
        };
      }

      // No client_secret found anywhere
      if (!clientSecretFound) {
        return {
          status: 'needs_client_secret',
          message: 'Google OAuth client credentials are needed. I searched your Desktop, Downloads, and project folder but didn\'t find a client_secret.json file. If you have one, tell me the file path and I\'ll set it up.',
          steps,
          searchedPaths: searchPaths,
        };
      }
    }

    // All other cases: extract URL from the initial attempt
    return buildAuthResult(result, steps);
  },

  async mockHandler() {
    return { status: 'dry_run', action: 'gws_connect' };
  },
};
