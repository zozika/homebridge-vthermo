// Browser copy of src/rebind.ts: after a device is paired again it gets a new Matter node id;
// find the same endpoint on the new node by unique id / serial number. Keep both in sync
// (test/rebind.test.mjs runs the same cases against both).
(function (root) {
  function findRebindTarget(reference, options, pairedNodeIds) {
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

    let match;
    if (candidates.length === 1) {
      match = candidates[0];
    } else {
      const byName = candidates.filter((candidate) => candidate.endpointName === reference.endpointName);
      match = byName.length === 1 ? byName[0] : undefined;
    }

    if (!match) {
      return undefined;
    }

    return reference.offset === undefined ? { ...match } : { ...match, offset: reference.offset };
  }

  root.VthermoRebind = { findRebindTarget };
})(typeof window !== "undefined" ? window : globalThis);
