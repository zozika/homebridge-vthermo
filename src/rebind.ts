import type { MatterEndpointReference, MatterOption } from "./matter-model.js";

/**
 * After a device or bridge is paired again it gets a new Matter node id, so every saved reference
 * to it points at a node that no longer exists. The bridged devices themselves keep their unique
 * id / serial number, so we can find the same endpoint on the new node.
 *
 * Returns the replacement reference, or undefined when the reference is still valid or no single
 * unambiguous match exists. The calibration offset is carried over.
 *
 * Keep in sync with the copy in homebridge-ui/public/rebind.js (tested against the same cases).
 */
export function findRebindTarget(
  reference: MatterEndpointReference,
  options: readonly MatterOption[],
  pairedNodeIds: ReadonlySet<string>,
): MatterEndpointReference | undefined {
  if (pairedNodeIds.has(reference.nodeId)) {
    return undefined;
  }

  const { uniqueId, serialNumber } = reference;
  if (!uniqueId && !serialNumber) {
    return undefined;
  }

  const candidates = options
    .map((option) => option.reference)
    .filter((candidate) => candidate.clusterType === reference.clusterType
      && pairedNodeIds.has(candidate.nodeId)
      && ((uniqueId && candidate.uniqueId === uniqueId) || (serialNumber && candidate.serialNumber === serialNumber)));

  let match: MatterEndpointReference | undefined;
  if (candidates.length === 1) {
    match = candidates[0];
  } else {
    // Several endpoints of one device (e.g. a double switch): the endpoint name decides.
    const byName = candidates.filter((candidate) => candidate.endpointName === reference.endpointName);
    match = byName.length === 1 ? byName[0] : undefined;
  }

  if (!match) {
    return undefined;
  }

  return reference.offset === undefined ? { ...match } : { ...match, offset: reference.offset };
}

/**
 * Replaces, in place, every reference that can be rebound. Returns how many were changed; the
 * optional `nodeMoves` map collects old node id -> new node id (e.g. to move fixed addresses).
 */
export function rebindInPlace(
  references: Array<MatterEndpointReference | undefined>,
  options: readonly MatterOption[],
  pairedNodeIds: ReadonlySet<string>,
  nodeMoves?: Map<string, string>,
): number {
  let changed = 0;
  for (const reference of references) {
    if (!reference) {
      continue;
    }

    const target = findRebindTarget(reference, options, pairedNodeIds);
    if (!target) {
      continue;
    }

    nodeMoves?.set(reference.nodeId, target.nodeId);
    for (const key of Object.keys(reference) as Array<keyof MatterEndpointReference>) {
      delete reference[key];
    }
    Object.assign(reference, target);
    changed += 1;
  }

  return changed;
}
