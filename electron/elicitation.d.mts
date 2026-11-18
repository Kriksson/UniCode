export type ElicitationField = {
  key: string; label: string; required: boolean; type: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  description?: string; default?: unknown; options?: { value: string; label: string }[];
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; format?: string;
};
export function elicitationForm(params: { mode?: string; requestedSchema?: unknown; url?: string }): {
  mode: 'form' | 'url'; url?: string; fields: ElicitationField[];
};
export function elicitationResponse(params: { mode?: string; requestedSchema?: unknown; url?: string }, decision: string, content?: unknown): {
  action: string; content: unknown; _meta: null;
};
