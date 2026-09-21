// Pre-flight gate evaluation for the RC release (scripts/release-rc.mjs),
// kept pure and typed so the gate combinations are unit-testable offline.
// Gates: bun test green, tag uniqueness (local + GitHub release), clean
// tracked tree. Artifact validation lives in CI (release.yml builds its own
// artifacts); the local script only needs to decide whether TAGGING is safe.

export interface GateState {
  tag: string;
  testsGreen: boolean;
  /** Local git tag already exists (git rev-parse refs/tags/<tag>). */
  tagExistsLocal: boolean;
  /** Existing local tag points at HEAD (only meaningful with tagExistsLocal). */
  tagMatchesHead: boolean;
  /** A GitHub release already exists for the tag (gh release view). */
  releaseExists: boolean;
  /** No uncommitted changes to tracked files (git status --porcelain -uno). */
  treeClean: boolean;
  /** --resume: tolerate a local tag that still points at HEAD. */
  resume: boolean;
}

// Gate 2 evaluation is mode-aware: by default an existing local tag is an
// error; with --resume it is tolerated only when it still points at HEAD. A
// pre-existing GitHub release aborts in every mode.
export function evaluateGates(state: GateState): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!state.testsGreen) failures.push("gate 1: bun test is not green");
  if (state.releaseExists) {
    failures.push(`gate 2: GitHub release ${state.tag} already exists — never overwritten`);
  }
  if (state.resume) {
    if (state.tagExistsLocal && !state.tagMatchesHead) {
      failures.push(`gate 2 (--resume): tag ${state.tag} exists locally but does not point at HEAD`);
    }
  } else if (state.tagExistsLocal) {
    failures.push(`gate 2: tag ${state.tag} already exists locally — it is never overwritten`);
  }
  if (!state.treeClean) {
    failures.push("gate 3: working tree has uncommitted changes to tracked files — commit or clean first");
  }
  return { ok: failures.length === 0, failures };
}
