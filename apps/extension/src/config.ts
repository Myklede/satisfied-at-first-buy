// Build-time constants (apps/extension/build.mjs defines them; see README there).
declare const __FIT_AGENT_API__: string;
declare const __FIT_AGENT_WEB__: string;

/** Local Fit Agent service. Loopback only; the extension never calls anything else. */
export const API_BASE: string = __FIT_AGENT_API__;
/** Local web app for "See 3D / X-ray". */
export const WEB_ORIGIN: string = __FIT_AGENT_WEB__;
