import * as path from "node:path";
import { XMLParser } from "../packages/utils/src/xml";

const SITE_URL = "https://yequ172672.github.io/oh-my-pi-cn/";
const repoRoot = path.resolve(import.meta.dir, "..");
const siteRoot = path.join(repoRoot, "website");

interface SiteSnapshot {
	canonical: string | null;
	ids: Set<string>;
	imagesWithoutAlt: string[];
	jsonLd: string;
	lang: string | null;
	links: string[];
	meta: Map<string, string>;
	resources: string[];
	title: string;
}

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} 必须是对象`);
	return value as Record<string, unknown>;
}

async function readRequired(relativePath: string): Promise<string> {
	const file = Bun.file(path.join(repoRoot, relativePath));
	invariant(await file.exists(), `缺少必需文件：${relativePath}`);
	return file.text();
}

async function collectSiteSnapshot(html: string): Promise<SiteSnapshot> {
	const snapshot: SiteSnapshot = {
		canonical: null,
		ids: new Set<string>(),
		imagesWithoutAlt: [],
		jsonLd: "",
		lang: null,
		links: [],
		meta: new Map<string, string>(),
		resources: [],
		title: "",
	};

	const rewriter = new HTMLRewriter()
		.on("html", {
			element(element: HTMLRewriterTypes.Element): void {
				snapshot.lang = element.getAttribute("lang");
			},
		})
		.on("[id]", {
			element(element: HTMLRewriterTypes.Element): void {
				const id = element.getAttribute("id");
				if (id) snapshot.ids.add(id);
			},
		})
		.on("title", {
			text(text: HTMLRewriterTypes.TextChunk): void {
				snapshot.title += text.text;
			},
		})
		.on("meta", {
			element(element: HTMLRewriterTypes.Element): void {
				const key = element.getAttribute("name") ?? element.getAttribute("property");
				const content = element.getAttribute("content");
				if (key && content) snapshot.meta.set(key, content);
			},
		})
		.on("link", {
			element(element: HTMLRewriterTypes.Element): void {
				const href = element.getAttribute("href");
				if (element.getAttribute("rel") === "canonical") snapshot.canonical = href;
				if (href) snapshot.resources.push(href);
			},
		})
		.on("a", {
			element(element: HTMLRewriterTypes.Element): void {
				const href = element.getAttribute("href");
				if (href) snapshot.links.push(href);
			},
		})
		.on("img", {
			element(element: HTMLRewriterTypes.Element): void {
				const src = element.getAttribute("src") ?? "<missing src>";
				if (!element.getAttribute("alt")) snapshot.imagesWithoutAlt.push(src);
				snapshot.resources.push(src);
			},
		})
		.on("script[src]", {
			element(element: HTMLRewriterTypes.Element): void {
				const src = element.getAttribute("src");
				if (src) snapshot.resources.push(src);
			},
		})
		.on('script[type="application/ld+json"]', {
			text(text: HTMLRewriterTypes.TextChunk): void {
				snapshot.jsonLd += text.text;
			},
		});

	await rewriter.transform(new Response(html)).text();
	return snapshot;
}

async function validateRelativeResource(reference: string): Promise<void> {
	if (!reference.startsWith("./")) return;
	const resolved = path.resolve(siteRoot, reference.slice(2));
	invariant(resolved.startsWith(`${siteRoot}${path.sep}`), `站点资源越出 website 目录：${reference}`);
	invariant(await Bun.file(resolved).exists(), `站点引用不存在的资源：${reference}`);
}

async function validateRepositoryBlobLink(reference: string): Promise<void> {
	const prefix = "https://github.com/yequ172672/oh-my-pi-cn/blob/main/";
	if (!reference.startsWith(prefix)) return;
	const parsed = new URL(reference);
	const relativePath = decodeURIComponent(parsed.pathname.slice("/yequ172672/oh-my-pi-cn/blob/main/".length));
	const resolved = path.resolve(repoRoot, relativePath);
	invariant(resolved.startsWith(`${repoRoot}${path.sep}`), `仓库链接越出项目目录：${reference}`);
	invariant(await Bun.file(resolved).exists(), `站点链接到不存在的仓库文件：${reference}`);
}

async function validateHtml(): Promise<void> {
	const html = await readRequired("website/index.html");
	const snapshot = await collectSiteSnapshot(html);

	invariant(snapshot.lang === "zh-CN", "网站 html.lang 必须为 zh-CN");
	invariant(
		snapshot.title.includes("oh-my-pi-cn") && snapshot.title.includes("Oh My Pi 中文版"),
		"网站标题缺少统一项目身份",
	);
	invariant(snapshot.canonical === SITE_URL, `canonical 必须为 ${SITE_URL}`);
	invariant(snapshot.meta.get("description")?.includes("omp-cn"), "meta description 必须包含 omp-cn");
	invariant(snapshot.meta.get("og:url") === SITE_URL, "Open Graph URL 与 canonical 不一致");
	invariant(snapshot.meta.get("og:title")?.includes("Oh My Pi 中文版"), "Open Graph 标题缺少中文项目名");
	invariant(snapshot.meta.get("og:image") === `${SITE_URL}og-social.jpg`, "Open Graph 图片必须使用站点绝对 URL");
	invariant(snapshot.meta.get("twitter:card") === "summary_large_image", "Twitter card 必须为大图模式");
	invariant(snapshot.imagesWithoutAlt.length === 0, `图片缺少 alt：${snapshot.imagesWithoutAlt.join(", ")}`);
	invariant(snapshot.jsonLd.trim().length > 0, "缺少 SoftwareApplication 结构化数据");

	const jsonLd = asRecord(JSON.parse(snapshot.jsonLd) as unknown, "JSON-LD");
	invariant(jsonLd["@type"] === "SoftwareApplication", "JSON-LD 类型必须为 SoftwareApplication");
	invariant(jsonLd.url === SITE_URL, "JSON-LD URL 与 canonical 不一致");
	invariant(jsonLd.codeRepository === "https://github.com/yequ172672/oh-my-pi-cn", "JSON-LD repository 身份错误");

	for (const link of snapshot.links) {
		invariant(link !== "#", "站点包含无目标的 # 链接");
		if (link.startsWith("#")) invariant(snapshot.ids.has(link.slice(1)), `页内链接缺少目标：${link}`);
		await validateRelativeResource(link);
		await validateRepositoryBlobLink(link);
	}
	for (const resource of snapshot.resources) await validateRelativeResource(resource);
}

async function validateManifestAndDiscovery(): Promise<void> {
	const manifest = asRecord(JSON.parse(await readRequired("website/site.webmanifest")) as unknown, "site.webmanifest");
	invariant(manifest.lang === "zh-CN", "site.webmanifest lang 必须为 zh-CN");
	invariant(manifest.start_url === "./", "site.webmanifest start_url 必须保持项目 Pages 相对路径");

	const sitemap = asRecord(new XMLParser().parse(await readRequired("website/sitemap.xml")), "sitemap.xml");
	const urlset = asRecord(sitemap.urlset, "sitemap.xml urlset");
	const url = asRecord(urlset.url, "sitemap.xml url");
	invariant(url.loc === SITE_URL, "sitemap URL 与 canonical 不一致");

	const robots = await readRequired("website/robots.txt");
	const sitemapDirective = robots
		.split(/\r?\n/u)
		.map(line => line.trim())
		.find(line => line.toLowerCase().startsWith("sitemap:"));
	invariant(sitemapDirective === `Sitemap: ${SITE_URL}sitemap.xml`, "robots.txt sitemap 指向错误");

	const socialImage = Bun.file(path.join(siteRoot, "og-social.jpg"));
	invariant(await socialImage.exists(), "缺少网站社交分享图 og-social.jpg");
	invariant(socialImage.size > 20_000, "网站社交分享图尺寸异常");
	invariant(socialImage.size < 1_000_000, "网站社交分享图超过 GitHub 1 MB 上限");

	const siteScript = await readRequired("website/site.js");
	new Bun.Transpiler({ loader: "js" }).transformSync(siteScript);

	for (const manifestPath of ["package.json", "packages/coding-agent/package.json"]) {
		const packageManifest = asRecord(JSON.parse(await readRequired(manifestPath)) as unknown, manifestPath);
		invariant(packageManifest.homepage === SITE_URL, `${manifestPath} homepage 与项目网站不一致`);
	}
}

async function validateYamlSurfaces(): Promise<void> {
	const yamlFiles = [
		".github/workflows/pages.yml",
		".github/ISSUE_TEMPLATE/config.yml",
		".github/ISSUE_TEMPLATE/bug_report.yml",
		".github/ISSUE_TEMPLATE/feature_request.yml",
		".github/ISSUE_TEMPLATE/question.yml",
	];
	for (const yamlFile of yamlFiles) asRecord(Bun.YAML.parse(await readRequired(yamlFile)), yamlFile);

	const workflow = asRecord(Bun.YAML.parse(await readRequired(".github/workflows/pages.yml")), "Pages workflow");
	const permissions = asRecord(workflow.permissions, "Pages workflow permissions");
	invariant(permissions.pages === "write" && permissions["id-token"] === "write", "Pages workflow 缺少发布权限");
	const jobs = asRecord(workflow.jobs, "Pages workflow jobs");
	const deploy = asRecord(jobs.deploy, "Pages workflow deploy job");
	invariant(deploy.environment !== undefined, "Pages workflow 缺少 github-pages environment");
}

await validateHtml();
await validateManifestAndDiscovery();
await validateYamlSurfaces();

console.log("Community site validation passed");
