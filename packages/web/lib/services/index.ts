/**
 * Service layer — the single place components reach the backend through.
 * Components import domain functions from here instead of inlining `fetch`.
 * Standard fetch/error semantics live in `@/lib/api` (getJson/postJson/...).
 */
export * from './types';
export * from './workspace';
export * from './runtimeContext';
export * from './resources';
export * from './projects';
export * from './artifacts';
export * from './models';
