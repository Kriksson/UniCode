export type Item = {
  id: string; type: string; turnId?: string; text?: string; content?: { type: string; text?: string }[];
  command?: string; aggregatedOutput?: string; status?: string; exitCode?: number;
  server?: string; tool?: string; changes?: { path: string; diff?: string }[];
  summary?: string[]; error?: { message: string }; phase?: string;
  inProgress?: boolean;
  commandActions?: { type: string; name?: string; path?: string; query?: string }[];
  questions?: { title: string; options?: string[] | null }[] | null;
};
export type Turn = { id: string; status: string; items: Item[]; error?: { message: string } };
export type Thread = {
  id: string; name?: string; preview?: string; cwd: string; createdAt: number;
  updatedAt: number; turns?: Turn[]; model?: string;
  historyMode?: 'legacy' | 'paginated';
};
export type Meta = {
  name?: string; folderId?: string | null; pinned?: boolean; cwd?: string;
  draft?: boolean; createdAt?: number; updatedAt?: number;
  model?: string; effort?: string; access?: State['access'];
};
export type State = {
  version: 1; folders: { id: string; name: string }[]; chats: Record<string, Meta>;
  hidden: string[]; selectedId: string | null; cwd: string | null; model: string;
  drafts?: Record<string, string>;
  effort?: string;
  access?: 'read-only' | 'workspace-write' | 'danger-full-access';
};
export type Model = { id: string; model: string; displayName: string; isDefault: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string; description: string }[]; defaultReasoningEffort?: string; };
export type Question = { id: string; header?: string; question: string; options?: { label: string; description: string }[] };
export type ServerRequest = {
  id: string | number; method: string;
  params: { threadId: string; turnId: string; itemId?: string; command?: string; reason?: string;
    cwd?: string; grantRoot?: string; permissions?: unknown; questions?: Question[];
    message?: string; url?: string; requestedSchema?: unknown; };
};
export type HistoryCursor = { kind: 'items' | 'turns'; token: string };
export type HistoryPage = { thread?: Thread; items: Item[]; cursor: HistoryCursor | null };
export type Runtime = { items: Item[]; busy: boolean; turnId?: string; error?: string; loaded?: boolean; activity?: string;
  historyCursor?: HistoryCursor | null; loadingOlder?: boolean; historyError?: string;
  historyOffset?: number; historyVersion?: number; answeredQuestionIds?: string[];
};
export type Event = {
  type: string; message?: any; messages?: any[]; threadId?: string; localId?: string; thread?: Thread; id?: string | number;
};
export type Chat = Thread & Meta & { title: string };

declare global {
  interface Window {
    codex: {
      bootstrap(): Promise<{ state: State; home: string; threads: { data: Thread[]; nextCursor: string | null }; models: Model[]; authenticated: boolean; requests: ServerRequest[]; defaults?: { model: string; effort: string } }>;
      save(state: State): Promise<void>;
      list(cursor?: string | null, searchTerm?: string | null): Promise<{ data: Thread[]; nextCursor: string | null }>;
      history(id: string, cursor?: HistoryCursor | null): Promise<HistoryPage>;
      send(value: { id?: string; localId: string; text: string; cwd: string; model: string; effort?: string; access?: State['access'] }): Promise<{ thread: Thread; turn: Turn }>;
      steer(value: { id: string; turnId: string; text: string }): Promise<unknown>;
      interrupt(value: { id: string; turnId: string }): Promise<unknown>;
      chooseFolder(): Promise<string | null>;
      answer(value: { id: string | number; decision?: string; answers?: Record<string, string[]> }): Promise<void>;
      login(): Promise<unknown>;
      external(url: string): Promise<void>;
      openLink(value: { href: string; cwd?: string }): Promise<void>;
      deleteChat(id: string): Promise<void>;
      deleteFrom(value: { id: string; turnId: string }): Promise<HistoryPage>;
      window(action: string): Promise<void>;
      onEvent(callback: (event: Event) => void): () => void;
    };
  }
}
