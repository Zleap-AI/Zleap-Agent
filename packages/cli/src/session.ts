import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '@zleap/host';
import type { DisplayMessage } from './state/types.js';

/**
 * Local, dependency-free conversation persistence so a session survives a
 * restart. The whole display transcript (user/assistant/tool/space/system) is
 * written to a single rolling file and re-rendered verbatim on /resume. This is
 * intentionally separate from durable memory (Postgres): it works fully offline
 * and captures the literal conversation, not vector-recalled work artifacts.
 */
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');
const LAST_SESSION_PATH = join(SESSIONS_DIR, 'last.json');

type SessionFile = {
  version: 1;
  savedAt: string;
  messages: DisplayMessage[];
};

/** Best-effort write of the current transcript; never throws into the UI. */
export async function saveSession(messages: DisplayMessage[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const payload: SessionFile = { version: 1, savedAt: new Date().toISOString(), messages };
    await writeFile(LAST_SESSION_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // Persistence is a convenience; a failure must not disrupt the session.
  }
}

/** Load the most recent transcript, or null if none/corrupt. */
export async function loadLastSession(): Promise<DisplayMessage[] | null> {
  try {
    const raw = await readFile(LAST_SESSION_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionFile>;
    if (!parsed || !Array.isArray(parsed.messages)) {
      return null;
    }
    const messages = parsed.messages.filter(isDisplayMessage);
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  }
}

/** Remove the saved session so a later --resume/`/resume` finds nothing. */
export async function clearLastSession(): Promise<void> {
  try {
    await rm(LAST_SESSION_PATH, { force: true });
  } catch {
    // Best-effort; a missing file is already the desired state.
  }
}

function isDisplayMessage(value: unknown): value is DisplayMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Record<string, unknown>;
  return typeof message.id === 'number' && typeof message.role === 'string';
}
