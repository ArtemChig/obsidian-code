// The node tsconfig (which includes tests/**) has no @renderer/* path and is a composite project, so renderer
// modules cannot be type-resolved there. Vitest resolves @renderer/* via the alias in vite.shared.ts; the node
// type-check sees these imports as 'any'. Renderer tests are type-checked for real with
//   npx tsc --noEmit -p tests/unit/ui-foundation/tsconfig.json
// (that config excludes this file). Owner: ui-foundation.
declare module '@renderer/*';
