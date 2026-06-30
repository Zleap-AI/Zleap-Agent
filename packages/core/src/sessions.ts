import type { Session } from './types.js';

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  register(session: Session): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  appendRun(sessionId: string, runId: string, updatedAt: Date): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (!session.runIds.includes(runId)) {
      session.runIds.push(runId);
    }
    session.updatedAt = updatedAt;
  }
}
