import { createDefaultSuperAgentSeed, type SuperAgentSeed, type SuperAgentStorageAdapter } from '@zleap/core';

export type SeedSuperAgentDefaultsOptions = {
  now?: Date;
  avatarId?: string;
  seed?: SuperAgentSeed;
};

export async function seedSuperAgentDefaults(
  store: SuperAgentStorageAdapter,
  options: SeedSuperAgentDefaultsOptions = {},
): Promise<SuperAgentSeed> {
  const seed = options.seed ?? createDefaultSuperAgentSeed({ now: options.now, avatarId: options.avatarId });

  await store.transaction(async (tx) => {
    await tx.avatars.saveAvatar(seed.avatar);
    await tx.avatars.saveAvatarVersion(seed.avatarVersion);

    for (const capability of seed.capabilities) {
      await tx.spaces.saveCapability(capability);
    }

    for (const space of seed.spaces) {
      const existing = await tx.spaces.getSpace(space.space.id);
      if (!existing) {
        await tx.spaces.saveSpace(space.space);
        await tx.spaces.saveSpaceVersion(space.version);
        for (const binding of space.bindings) {
          await tx.spaces.bindCapability(binding);
        }
        continue;
      }

      const existingVersion = await tx.spaces.getSpaceVersion(space.space.id, existing.currentVersion);
      if (!existingVersion) {
        await tx.spaces.saveSpaceVersion({ ...space.version, version: existing.currentVersion });
      }
      const existingBindings = await tx.spaces.listCapabilityBindings({ spaceId: space.space.id, version: existing.currentVersion });
      const existingBindingKeys = new Set(
        existingBindings.map((binding) => `${binding.capabilityType}:${binding.capabilityId}`),
      );
      for (const binding of space.bindings) {
        if (!existingBindingKeys.has(`${binding.capabilityType}:${binding.capabilityId}`)) {
          await tx.spaces.bindCapability({
            ...binding,
            id: `${space.space.id}:${existing.currentVersion}:${binding.capabilityType}:${binding.capabilityId}`,
            spaceVersion: existing.currentVersion,
          });
        }
      }
    }
  });

  return seed;
}
