/**
 * The refusal an install raises, in a module with no dependencies.
 *
 * It lives here rather than in `install.ts` because the low-level files —
 * where a package is allowed to be put, what its name may be — need to refuse
 * too, and importing the planner from a path helper would be a cycle. One
 * class, so `instanceof` and the web routes' name check both keep working.
 */
export class InstallRefusal extends Error {
  override readonly name = 'InstallRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
