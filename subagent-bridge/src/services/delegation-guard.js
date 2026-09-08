const MAX_DELEGATION_DEPTH = 1;

export function createDelegationGuard(maxDepth = MAX_DELEGATION_DEPTH) {
  return {
    check(delegationDepth, caller) {
      if (delegationDepth >= maxDepth) {
        return {
          allowed: false,
          error: `delegation depth exceeded: current ${delegationDepth}, max ${maxDepth}`
        };
      }
      return { allowed: true, nextDepth: delegationDepth + 1 };
    },

    enrichRequest(request, backend, caller) {
      return {
        ...request,
        executionId: request.executionId,
        backend,
        delegationDepth: 0,
        caller
      };
    }
  };
}

export function getMaxDelegationDepth() {
  return MAX_DELEGATION_DEPTH;
}
