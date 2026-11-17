/** Package-private access to the client's one authenticated HTTP implementation. */
type RetainedMutation = (path: string, body: string, key: string) => Promise<unknown>;
const mutations = new WeakMap<object, RetainedMutation>();

export function registerEvaluationMutation(client: object, mutation: RetainedMutation): void {
  mutations.set(client, mutation);
}
export function evaluationMutationFor(client: object): RetainedMutation {
  const mutation = mutations.get(client);
  if (!mutation) throw new TypeError('Unsupported evaluation transport');
  return mutation;
}
