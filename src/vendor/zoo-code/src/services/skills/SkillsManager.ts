export interface SkillLike {
	name: string
	description: string
	path: string
	source?: string
	digest?: string
}

export class SkillsManager {
	constructor(private readonly skills: readonly SkillLike[] = []) {}

	getSkillsForMode(_mode: string): SkillLike[] {
		return [...this.skills]
	}

	getSkillByName(name: string): SkillLike | undefined {
		return this.skills.find((skill) => skill.name === name)
	}
}
