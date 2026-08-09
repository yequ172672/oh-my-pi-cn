const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FORK_RELEASE_TAG_PREFIX = "omp-cn-v";

export function isStableForkVersion(version: string): boolean {
	return STABLE_VERSION_PATTERN.test(version);
}

export function parseStableForkReleaseTag(tag: string): string {
	if (!tag.startsWith(FORK_RELEASE_TAG_PREFIX)) {
		throw new Error(`Fork release tag must start with ${FORK_RELEASE_TAG_PREFIX}`);
	}
	const version = tag.slice(FORK_RELEASE_TAG_PREFIX.length);
	if (!isStableForkVersion(version)) {
		throw new Error(`Fork release tag must contain a stable X.Y.Z version: ${tag}`);
	}
	return version;
}
