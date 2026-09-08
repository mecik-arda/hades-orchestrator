export function createAdapter(id, capabilities) {
  return {
    id,
    capabilities,
    async healthCheck() {
      return {
        installed: true,
        version: "1.0.0",
        authValid: true,
        executable: id
      };
    },
    async execute(request) {
      throw new Error(`Adapter '${id}' execute() not implemented`);
    },
    async cancel(executionId) {
    }
  };
}
