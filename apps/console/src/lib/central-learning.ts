export type CentralAction =
  | 'provider'
  | 'saveProvider'
  | 'configure'
  | 'start'
  | 'pause'
  | 'evidence'
  | 'tasks'
  | 'create'
  | 'edit'
  | 'retire'
  | 'try'
  | 'trial'
  | 'import'
  | 'progress'
  | 'export'
  | 'rollback'
  | 'usage';
export type CentralRequest = {
  workspaceId: string;
  bundleId?: string;
  action: CentralAction;
  id?: string;
  evaluation?: string;
  payload?: string;
  filename?: string;
  mediaType?: string;
};
export type Provider = { baseUrl: string | null; allowedModels: string[]; hasKey: boolean };
export type TaskCard = {
  taskId: string;
  addedRevision: number;
  input: unknown;
  grader:
    | { type: 'exact'; expected: unknown }
    | { type: 'criteria'; criteria: string[]; reference?: unknown };
  source: string;
  sourceFile?: string;
  sourceRow?: number;
  split: string;
  admission: string;
  admissionReason?: string;
  confirmedBy?: string;
  flagReason?: string;
};
export type ImportStatus = {
  importId: string;
  rows: number;
  converted: number;
  pending: number;
  setAside?: number;
};
export type Trial = {
  trialId: string;
  status: string;
  output?: string;
  gatewayLog?: unknown;
  verdict?: { passed: boolean; reasons?: unknown };
};
export type Usage = {
  day: string;
  rounds: number;
  rollouts: number;
  optimizerTokens: number;
  judgeTokens: number;
  taskTokens: number;
};
export const splitDeficit = (count: number) => Math.max(0, 20 - count);
export const mediaTypes: Record<string, string> = {
  csv: 'text/csv',
  jsonl: 'application/x-ndjson',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};
