// Types for reference-photos.mjs (imported by apps/web/vite.config.ts). The request and response
// are Node http objects; they are left opaque here because apps/web has no @types/node.
export const DEFAULT_ROOT: string;
export const EXPECTED_FOLDERS: string[];
export function handleReferenceRequest(req: object, res: object, url: URL, root?: string): boolean;
