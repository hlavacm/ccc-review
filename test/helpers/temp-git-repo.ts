import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTempDir, removeDir } from "./temp-dir.ts";

// Config isolation comes from test/setup.ts; only commit identity is set here.
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "CCC Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "CCC Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export class TemporaryGitRepository {
	readonly root: string;
	private readonly parent: string;

	private constructor(root: string, parent: string) {
		this.root = root;
		this.parent = parent;
	}

	/** `name` creates the repo in a subdirectory, e.g. to test unusual root paths. */
	static async create(name?: string): Promise<TemporaryGitRepository> {
		const parent = await makeTempDir("cccr-repo-");
		const root = name === undefined ? parent : join(parent, name);
		await mkdir(root, { recursive: true });
		const repo = new TemporaryGitRepository(root, parent);
		repo.git("init", "-q", "-b", "main");
		return repo;
	}

	git(...args: string[]): string {
		return execFileSync("git", args, {
			cwd: this.root,
			env: GIT_ENV,
			encoding: "utf8",
		});
	}

	async write(path: string, content: string): Promise<void> {
		const file = join(this.root, path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}

	async commitFile(path: string, content: string, message = `add ${path}`) {
		await this.write(path, content);
		this.git("add", "--", path);
		this.git("commit", "-q", "-m", message);
	}

	async dispose(): Promise<void> {
		await removeDir(this.parent);
	}
}
