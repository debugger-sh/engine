export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type BackendOptions = {
  testDir: string;
  testOutputDir: string;
  fsNode: Record<string, Json>;
};

export interface Backend {
  send(req: Json): Promise<Json>;
  onEvent(cb: (e: Json) => void): void;
  shutdown(): Promise<void>;
}
