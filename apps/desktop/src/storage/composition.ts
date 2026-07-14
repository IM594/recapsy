/**
 * Infrastructure factories reserved for the Electron composition root.
 *
 * Capability consumers must import storage ports and behavior from
 * `storage/public.ts`; exposing the Node adapter there would load `node:sqlite`
 * in runtimes that only consume storage types.
 */
export { createNodeSqliteDatabase } from './node-sqlite-driver';
