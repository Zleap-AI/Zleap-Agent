import type { UserRole } from "../types";

export type RequestActor = {
  actorId: string;
  actorRole: UserRole;
};

export function parseActor(input: { actorId?: unknown; actorRole?: unknown }, source = "Request"): RequestActor {
  const actorId = typeof input.actorId === "string" ? input.actorId.trim() : "";
  if (!actorId) throw new Error(`${source} requires explicit actorId.`);
  if (input.actorRole !== "user" && input.actorRole !== "creator") {
    throw new Error(`${source} requires actorRole to be user or creator.`);
  }
  return {
    actorId,
    actorRole: input.actorRole
  };
}

export function parseActorFromSearchParams(params: URLSearchParams, source = "Request"): RequestActor {
  return parseActor({
    actorId: params.get("actorId"),
    actorRole: params.get("actorRole")
  }, source);
}
