import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_SPACE_IDS,
  type AvatarRecord,
  type AvatarVersionRecord,
  type CapabilityDefinitionRecord,
  type SpaceCapabilityBindingRecord,
  type SpaceRecord,
  type SpaceVersionRecord,
  type SuperAgentStorageAdapter,
} from '@zleap/core';
import { seedSuperAgentDefaults } from '../src/seed.js';

type Writes = {
  avatars: AvatarRecord[];
  avatarVersions: AvatarVersionRecord[];
  capabilities: CapabilityDefinitionRecord[];
  spaces: SpaceRecord[];
  spaceVersions: SpaceVersionRecord[];
  bindings: SpaceCapabilityBindingRecord[];
  transactions: number;
};

function fakeStore(writes: Writes): SuperAgentStorageAdapter {
  return {
    transaction: async (operation) => {
      writes.transactions += 1;
      return operation(fakeStore(writes));
    },
    avatars: {
      saveAvatar: async (record) => {
        writes.avatars.push(record);
      },
      saveAvatarVersion: async (record) => {
        writes.avatarVersions.push(record);
      },
      getAvatar: async () => undefined,
      getAvatarVersion: async () => undefined,
      listAvatars: async () => writes.avatars,
    },
    spaces: {
      saveSpace: async (record) => {
        writes.spaces.push(record);
      },
      saveSpaceVersion: async (record) => {
        writes.spaceVersions.push(record);
      },
      saveCapability: async (record) => {
        writes.capabilities.push(record);
      },
      bindCapability: async (record) => {
        writes.bindings.push(record);
      },
      getSpace: async () => undefined,
      getSpaceVersion: async () => undefined,
      listCapabilityBindings: async () => [],
      getSpaceSnapshot: async () => {
        throw new Error('not implemented');
      },
    },
    models: {
      saveModelConfig: async () => undefined,
      getModelConfig: async () => undefined,
      listModelConfigs: async () => [],
      deleteModelConfig: async () => undefined,
    },
    skills: {
      saveSkill: async () => undefined,
      getSkill: async () => undefined,
      listSkills: async () => [],
      deleteSkill: async () => undefined,
    },
    mcp: {
      saveServer: async () => undefined,
      getServer: async () => undefined,
      listServers: async () => [],
      deleteServer: async () => undefined,
      saveTool: async () => undefined,
      getTool: async () => undefined,
      listTools: async () => [],
    },
    threads: {
      createThread: async () => {
        throw new Error('not implemented');
      },
      getThread: async () => undefined,
      listThreads: async () => [],
    },
    sessions: {
      createSession: async () => {
        throw new Error('not implemented');
      },
      getSession: async () => undefined,
      appendEntry: async () => {
        throw new Error('not implemented');
      },
      setLeaf: async () => undefined,
      buildConversation: async () => [],
    },
    ledger: {
      saveRun: async () => undefined,
      saveWork: async () => undefined,
      saveWorkStep: async () => undefined,
      saveEvent: async () => undefined,
      listEvents: async () => [],
      saveArtifact: async () => undefined,
      saveArtifactReference: async () => undefined,
      saveCapabilitySnapshot: async () => undefined,
    },
    close: async () => undefined,
  };
}

describe('seedSuperAgentDefaults', () => {
  it('seeds the default avatar, spaces, capabilities, and bindings through the storage adapter', async () => {
    const writes: Writes = {
      avatars: [],
      avatarVersions: [],
      capabilities: [],
      spaces: [],
      spaceVersions: [],
      bindings: [],
      transactions: 0,
    };

    const seed = await seedSuperAgentDefaults(fakeStore(writes), { now: new Date('2026-01-02T03:04:05.000Z') });

    expect(writes.transactions).toBe(1);
    expect(writes.avatars).toHaveLength(1);
    expect(writes.avatars[0]?.id).toBe(DEFAULT_AVATAR_ID);
    // Spaces are global: id IS the slug, no avatar prefix.
    expect(writes.spaces.map((space) => space.id)).toEqual([...DEFAULT_SPACE_IDS]);
    expect(writes.spaces.map((space) => space.slug)).toEqual([...DEFAULT_SPACE_IDS]);
    expect(writes.spaceVersions).toHaveLength(DEFAULT_SPACE_IDS.length);
    expect(writes.capabilities.map((capability) => capability.id)).toEqual(
      expect.arrayContaining(['enterWorkspace', 'readMessage', 'task_manage', 'recall', 'read', 'bash', 'get_time', 'web_search', 'read_webpage']),
    );
    expect(writes.bindings).toEqual(expect.arrayContaining([expect.objectContaining({ spaceId: 'main', capabilityId: 'enterWorkspace' })]));
    expect(writes.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'ls' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'find' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'read' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'grep' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'write' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'edit' }),
      expect.objectContaining({ spaceId: 'cli', capabilityId: 'bash' }),
      expect.objectContaining({ spaceId: 'web-search', capabilityId: 'web_search' }),
      expect.objectContaining({ spaceId: 'web-search', capabilityId: 'read_webpage' }),
    ]));
    expect(writes.bindings.filter((binding) => binding.spaceId === 'main').map((binding) => binding.capabilityId)).toEqual([
      'enterWorkspace',
      'readMessage',
      'task_manage',
      'recall',
      'deliver',
    ]);
    expect(writes.bindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ spaceId: 'main', capabilityId: 'task_detail' }),
    ]));
    expect(seed.spaces).toHaveLength(DEFAULT_SPACE_IDS.length);
  });

  it('allows a custom avatar id for user-created default-like avatars', async () => {
    const writes: Writes = {
      avatars: [],
      avatarVersions: [],
      capabilities: [],
      spaces: [],
      spaceVersions: [],
      bindings: [],
      transactions: 0,
    };

    await seedSuperAgentDefaults(fakeStore(writes), { avatarId: 'custom-avatar' });

    // A custom avatar id only names the avatar record; spaces stay GLOBAL.
    expect(writes.avatars[0]?.id).toBe('custom-avatar');
    expect(writes.spaces[0]?.id).toBe('main');
    expect(writes.bindings[0]?.spaceId).toBe('main');
    expect(writes.spaces.map((space) => space.id)).toEqual([...DEFAULT_SPACE_IDS]);
  });
});
