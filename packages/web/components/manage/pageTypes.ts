import type { ReactNode } from 'react';
import type { Resources } from '@/lib/useResources';
import type { Conversation as ManagedConversation } from '@/lib/useConversations';

export type PageKey = 'task' | 'gateway' | 'model' | 'tool' | 'skill' | 'memory' | 'artifact' | 'avatar' | 'space';

export type PageProps = {
  resources: Resources;
  avatarId: string;
  currentProjectId?: string;
  conversations?: ManagedConversation[];
  onCreateTaskConversation?: (title: string, projectId?: string) => string;
  onOpenTaskConversation?: (input: { conversationId: string; title: string; prompt?: string; avatarId?: string; projectId?: string }) => void;
  /** Open the full-screen edit page for an avatar/space (reuses the existing EditPage). */
  onEdit?: (kind: 'avatar' | 'space', id: string) => void;
  onChanged: () => void;
  onBack?: () => void;
};

export type ResourcePage = (props: PageProps) => ReactNode;
