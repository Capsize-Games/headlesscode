/**
 * SHIM — replaces zoo-code/src/services/skills/SkillsManager.ts.
 *
 * The real SkillsManager scans global/project skills directories. The vendored
 * `core/prompts/sections/skills.ts` only reads `getSkillsForMode(mode)`, which
 * this stub satisfies with an empty list (no skills registered headlessly).
 * Skill loading is out of scope for Phase 1.
 */

export interface SkillLike {
	name: string
	description: string
	path: string
}

export class SkillsManager {
	getSkillsForMode(_mode: string): SkillLike[] {
		return []
	}
}
