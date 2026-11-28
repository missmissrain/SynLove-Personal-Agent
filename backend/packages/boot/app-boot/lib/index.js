import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as yaml from "js-yaml";
import { Context, Service } from "@deepseek-ai/cordis";
import Loader, { EntryGroup, EntryTree, isJsExpr } from "@deepseek-ai/cordis-plugin-loader";
import { access, constants, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import Group from "@deepseek-ai/cordis-plugin-group";
import { dshHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import { watch } from "chokidar";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { imports, resolve as resolve$1 } from "resolve.exports";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
//#region ../../../vendor/include/src/index.ts
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	predicate: isJsExpr,
	represent: (data) => data["__jsExpr"]
});
/**
* The entry-list YAML dialect: `!!js` scalars round-trip as expression nodes
* the Loader evaluates at entry activation. Exported so config tooling
* (`dsh --dump-config`) parses and prints exactly the dialect this include
* mounts.
*/
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
const schema = entryListSchema;
const writable = {
	".json": "application/json",
	".yaml": "application/yaml",
	".yml": "application/yaml"
};
const supported = new Set(Object.keys(writable));
const WRITE_RETRY_LIMIT = 10;
const WRITE_RETRY_DELAY_MS = 50;
function retryableWriteError(error) {
	const code = error?.code;
	return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}
/**
* Apply patch lists to an entry list — THE patch semantics of this include,
* shared by mounting (`applyPatches`) and offline config tooling
* (`dsh --dump-config`) so a dump can never drift from what boots. The input
* is never mutated: patching shared entry objects would bake earlier patch
* values into the cached parse, so repeated application (config hot-reloads)
* could never revert a removed or changed patch. Inserted entries are indexed
* as they are added, so a later patch in the same list can target a row an
* earlier patch inserted. A patch that matches nothing warns and is skipped.
* @param data - the parsed entry list (JSON-safe plain data).
* @param patches - the patch list to apply, in order.
* @param warn - sink for skipped-patch diagnostics (printf-style, `%C` = code).
* @returns a detached entry list with every applicable patch applied.
*/
function applyEntryPatches(data, patches, warn) {
	if (!patches?.length) return [...data];
	data = structuredClone(data);
	const entryMap = /* @__PURE__ */ new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) {
					warn("patch insert: entry %C not found", id);
					continue;
				}
				if (!target.group) {
					warn("patch insert: entry %C is not a group", id);
					continue;
				}
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) {
			warn("patch: id is required for non-insert patches");
			continue;
		}
		const target = entryMap.get(id);
		if (!target) {
			warn("patch: entry %C not found", id);
			continue;
		}
		if (name && name !== target.name) {
			warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
			continue;
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
/** Loader entry tree backed by a YAML or JSON file. */
var Include = class extends EntryTree {
	config;
	static inject = ["loader"];
	static [EntryGroup.key] = true;
	filename;
	type;
	readonly;
	content;
	data;
	writeTask;
	pendingWrite;
	writeQueue = Promise.resolve();
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false;
		this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl));
		const ext = extname(this.filename);
		if (!supported.has(ext)) throw new Error(`extension "${ext}" not supported`);
		this.type = writable[ext];
		this.readonly = !this.type;
		this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href;
		ctx.on("internal/update", (config, _, next) => {
			if (config.path !== this.config.path) return next();
			this.config = config;
			this.root.update(this.applyPatches(this.data, config.patches)).catch((error) => {
				this.ctx.logger.warn("config update at %C failed", this.filename);
				this.ctx.logger.warn(error);
			});
		});
	}
	async checkAccess() {
		if (!this.type) return;
		try {
			await access(this.filename, constants.W_OK);
		} catch {
			this.readonly = true;
		}
	}
	async read(forced = false) {
		const content = await readFile(this.filename, "utf8");
		if (!forced && this.content === content) return false;
		let data;
		if (this.type === "application/yaml") data = yaml.load(content, { schema: entryListSchema });
		else if (this.type === "application/json") data = JSON.parse(content);
		else {
			const module = await import(
				/* @vite-ignore */
				this.filename
);
			data = module.default || module;
		}
		if (!Array.isArray(data)) throw new TypeError(`config file must be a top-level array of entries: ${this.filename}`);
		this.content = content;
		this.data = data;
		await this.checkAccess();
		return true;
	}
	applyPatches(data, patches = this.config.patches) {
		return applyEntryPatches(data, patches, (message, ...args) => {
			this.ctx.root.logger?.("loader").warn(message, ...args);
		});
	}
	async *[Service.init]() {
		try {
			await this.read();
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			if (this.config.initial) {
				await this._writeFile(this.config.initial);
				await this.read(true);
			} else throw new Error(`config file not found: ${this.filename}`);
		}
		yield () => this.stop();
		await this.root.update(this.applyPatches(this.data));
	}
	async stop() {
		try {
			await this.flushWrite();
		} finally {
			this.root.stop();
			await this.flushWrite();
		}
	}
	/**
	* Re-read the file and refresh child entries when content changed. An
	* unreadable or unparsable file logs a warning and keeps the last good
	* tree: a hot-reload of a live app must never take the process down.
	*/
	async refresh() {
		try {
			if (!await this.read()) return;
			await this.root.update(this.applyPatches(this.data));
		} catch (error) {
			this.ctx.logger.warn("config reload at %C failed; keeping the running tree", this.filename);
			this.ctx.logger.warn(error);
		}
	}
	async _writeFile(config) {
		if (this.readonly) throw new Error(`cannot overwrite readonly config`);
		if (this.type === "application/yaml") this.content = yaml.dump(config, { schema });
		else if (this.type === "application/json") this.content = JSON.stringify(config, null, 2);
		await writeFile(this.filename + ".tmp", this.content);
		for (let retry = 0;; retry++) try {
			await rename(this.filename + ".tmp", this.filename);
			return;
		} catch (error) {
			if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error;
			await setTimeout$1((retry + 1) * WRITE_RETRY_DELAY_MS);
		}
	}
	writeFile(config) {
		clearTimeout(this.writeTask);
		this.pendingWrite = config;
		this.writeTask = setTimeout(() => {
			this.flushWrite();
		}, 0);
	}
	flushWrite() {
		clearTimeout(this.writeTask);
		this.writeTask = void 0;
		const config = this.pendingWrite;
		this.pendingWrite = void 0;
		if (config === void 0) return this.writeQueue;
		const run = this.writeQueue.then(() => this._writeFile(config), () => this._writeFile(config));
		this.writeQueue = run;
		run.catch((error) => {
			this.ctx.root.logger?.("loader").warn("failed to write config file %C", this.filename);
			this.ctx.root.logger?.("loader").warn(error);
		});
		return run;
	}
	/** Schedule a write of the current root entry data. */
	write() {
		this.context.emit("loader/config-update");
		return this.writeFile(this.root.data);
	}
};
//#endregion
//#region lib/types/watch-config.js
/** Exact-path watching for live profile patch files outside Cordis module roots. */
const registrations = /* @__PURE__ */ new WeakMap();
async function findWatchRoot(filename) {
	let root = dirname(filename);
	let depth = 0;
	while (true) try {
		if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`);
		const canonicalRoot = await realpath(root);
		return {
			filename: resolve(canonicalRoot, relative(root, filename)),
			root: canonicalRoot,
			depth
		};
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const parent = dirname(root);
		if (parent === root) throw error;
		root = parent;
		depth += 1;
	}
}
/**
* Watch one patch path, including missing parents, and serialize refresh callbacks.
* @param ctx Context that owns watcher disposal and receives refresh failures.
* @param filename Absolute patch-file path.
* @param options Deployment watcher options inherited from the HMR configuration.
* @param refresh Callback for additions, changes, and removals.
* @returns A disposer that closes the watcher and drains its current refresh.
* @throws When path resolution, watcher startup, or effect registration fails.
*/
async function watchConfig(ctx, filename, options, refresh) {
	const target = await findWatchRoot(filename);
	const paths = registrations.get(ctx) ?? /* @__PURE__ */ new Set();
	registrations.set(ctx, paths);
	if (paths.has(target.filename)) throw new Error(`config path already registered: ${filename}`);
	const { cwd: _cwd, ignored: _ignored, ...watchOptions } = options;
	const watcher = watch(target.root, {
		...watchOptions,
		depth: target.depth,
		ignoreInitial: false
	});
	paths.add(target.filename);
	const state = { dirty: false };
	let running;
	const onChange = (path) => {
		const observed = resolve(path);
		if (observed !== filename && observed !== target.filename) return;
		state.dirty = true;
		if (running) return;
		running = (async () => {
			while (state.dirty) {
				state.dirty = false;
				try {
					await refresh();
				} catch (reason) {
					const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
					ctx.logger.warn("config reload at %C failed", filename);
					ctx.logger.warn(error);
				}
			}
		})().finally(() => {
			running = void 0;
		});
	};
	watcher.on("add", onChange);
	watcher.on("change", onChange);
	watcher.on("unlink", onChange);
	const ready = Promise.withResolvers();
	let pending = true;
	watcher.once("ready", () => {
		pending = false;
		ready.resolve();
	});
	watcher.on("error", (error) => {
		if (pending) {
			pending = false;
			ready.reject(error);
		} else ctx.logger.warn(error);
	});
	const dispose = async () => {
		await watcher.close();
		paths.delete(target.filename);
		await running;
	};
	try {
		await ready.promise;
		return ctx.effect(() => dispose, "app-boot.watchConfig()");
	} catch (error) {
		await dispose();
		throw error;
	}
}
//#endregion
//#region lib/types/profile-resolution/legacy-links.js
/** Legacy profile-link inspection shared by the disk materializer and runtime resolver. */
/** Profile-private package links projected into its pnpm-managed node_modules. */
const PROFILE_MODULE_FALLBACK_DIR = ".dsh-module-fallback";
/**
* Return whether the process reads application modules from pkg's virtual filesystem.
* @returns whether pkg owns the module filesystem.
*/
function isPackagedExecutable() {
	return process.pkg !== void 0;
}
/**
* Resolve a directory through the active carrier's filesystem implementation.
* @param path - directory path to canonicalize.
* @returns the canonical directory path.
*/
function realModuleDirectory(path) {
	return isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path);
}
/**
* Resolve a link target without following the final path component.
* @param path - candidate path whose parent is canonicalized.
* @returns the canonical candidate, or undefined when its parent is absent.
*/
function canonicalLinkPath(path) {
	try {
		return join(realModuleDirectory(dirname(path)), basename(path));
	} catch (error) {
		/* v8 ignore next 2 -- a non-ENOENT realpath failure requires a host filesystem fault */
		if (error.code === "ENOENT") return void 0;
		/* v8 ignore next -- see the host-filesystem exception above */
		throw error;
	}
}
/**
* Return whether a symlink or junction points at the same path as `target`.
* @param link - symlink or junction to inspect.
* @param target - expected target path.
* @returns whether both paths identify the same entry.
*/
function symlinkPointsTo(link, target) {
	const canonicalActual = canonicalLinkPath(resolve(dirname(link), readlinkSync(link)));
	const canonicalTarget = canonicalLinkPath(resolve(target));
	return canonicalActual !== void 0 && canonicalActual === canonicalTarget;
}
/**
* Return whether an observed profile package must not claim local precedence.
* @param profileDir - profile directory containing the package projection.
* @param packageName - bare package name to inspect.
* @returns whether the entry is a managed fallback link or disappeared during inspection.
*/
function isProfileModuleFallbackLink(profileDir, packageName) {
	const link = join(profileDir, "node_modules", packageName);
	const target = join(profileDir, PROFILE_MODULE_FALLBACK_DIR, "node_modules", packageName);
	try {
		return lstatSync(link).isSymbolicLink() && symlinkPointsTo(link, target);
	} catch (error) {
		/* v8 ignore next 2 -- a vanished candidate cannot claim local precedence */
		if (error.code === "ENOENT") return true;
		/* v8 ignore next -- non-ENOENT lstat/readlink failures require a host filesystem fault */
		throw error;
	}
}
//#endregion
//#region lib/types/profile.js
/**
* Profile discovery, initialization, and patch-layer composition for the
* `dsh --profile` launcher family.
*
* A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
* `package.json` (out-of-tree plugin dependencies plus the profile manifest
* `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
* (the user's own patch layer, applied after every bundle layer). Bundles are
* npm packages whose manifest declares
* `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; the tree is
* composed by applying each bundle's patch list in `dsh.profile.bundles` order over
* an empty entry list, then the profile's own patches, then any launcher
* layers (`--patch` files and flag-derived patches).
*
* Module resolution is two-anchor by construction: a bundle name resolves
* first from the dsh installation (the launcher's own package), then from the
* profile directory. Pnpm-managed entries in the profile's `node_modules`
* resolve first. Dsh-owned links add packages carried only by selected
* bundles, while `$DSH_HOME/profiles/node_modules` supplies the installation
* dependency closure through Node's ordinary parent-walk. Plain Node uses
* symlinks for that shared fallback; packaged executables use ESM proxies so
* external plugins retain the installation's module instances.
* @module @deepseek-ai/dsh-app-boot/profile
*/
/** Directory under the Harness home holding every profile. */
const PROFILES_DIR = "profiles";
/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
/**
* Resolve a profile's directory under the Harness home.
* @param name - the profile name (`dsh --profile <name>`).
* @param home - the Harness home; defaults to {@link resolveDshHome}.
* @returns the absolute profile directory (which may not exist yet).
*/
function resolveProfileDir(name, home = resolveDshHome()) {
	if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "node_modules") throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`);
	return join(home, PROFILES_DIR, name);
}
/** The shipped profile templates auto-initialized on first use, by name. */
const PROFILE_TEMPLATES = {
	acp: {
		bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],
		patchReload: "startup"
	},
	web: {
		bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
		patchReload: "live"
	},
	headless: {
		bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
		patchReload: "startup"
	},
	sdk: {
		bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
		patchReload: "startup"
	},
	"sdk-minimal": {
		bundles: ["@deepseek-ai/dsh-sdk-minimal"],
		patchReload: "startup"
	}
};
/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES = { headless: [
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless"
] };
/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
const DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"];
/** Custom profiles retain the historical live patch-file behavior. */
const DEFAULT_PROFILE_PATCH_RELOAD = "live";
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
/**
* Initialize a profile directory: manifest, empty user patch layer, and the
* pnpm settings out-of-tree plugins need. Existing files are never touched,
* so re-running is a no-op on an initialized profile.
* @param dir - the profile directory from {@link resolveProfileDir}.
* @param bundles - the initial `dsh.profile.bundles` layer list.
* @param patchReload - user patch-file lifecycle; custom profiles default to live reload.
*/
function initProfile(dir, bundles, patchReload = DEFAULT_PROFILE_PATCH_RELOAD) {
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) {
		const manifest = {
			name: `dsh-profile-${basename(dir)}`,
			private: true,
			dependencies: {},
			dsh: { profile: {
				bundles: [...bundles],
				patchReload
			} }
		};
		writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
	}
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
	const workspacePath = join(dir, "pnpm-workspace.yaml");
	if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
}
function readModuleProxyRecord(link) {
	try {
		return JSON.parse(readFileSync(join(link, "package.json"), "utf8"));
	} catch {
		return;
	}
}
/** Ensure `link` is a symlink to `target`, replacing a wrong link or a dsh-managed packaged proxy. */
function ensureSymlink(link, target) {
	let stat;
	try {
		stat = lstatSync(link);
	} catch {
		stat = void 0;
	}
	if (stat !== void 0) {
		if (!stat.isSymbolicLink()) {
			if ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error(`dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`);
			rmSync(link, { recursive: true });
			stat = void 0;
		}
		if (stat !== void 0) {
			if (symlinkPointsTo(link, target)) return;
			unlinkSync(link);
		}
	}
	try {
		symlinkSync(target, link, "junction");
	} catch (error) {
		/* v8 ignore next 4 */
		if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;
	}
}
/** Add one profile-owned fallback link without replacing a pnpm-managed entry. */
function ensureProfileSymlink(link, target) {
	try {
		lstatSync(link);
		return;
	} catch (error) {
		/* v8 ignore next -- a non-ENOENT lstat failure requires a host filesystem fault */
		if (error.code !== "ENOENT") throw error;
	}
	ensureSymlink(link, target);
}
/** Package names represented by owned symlinks below one fallback node_modules. */
function ownedPackageNames(modulesDir) {
	return readdirSync(modulesDir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith("@") && entry.isDirectory()) return readdirSync(join(modulesDir, entry.name), { withFileTypes: true }).filter((child) => child.isSymbolicLink()).map((child) => `${entry.name}/${child.name}`);
		return entry.isSymbolicLink() ? [entry.name] : [];
	});
}
/** Remove an obsolete owned target and its profile projection when still connected. */
function removeProfileSymlink(profileModulesDir, ownedModulesDir, packageName) {
	const ownedLink = join(ownedModulesDir, packageName);
	const profileLink = join(profileModulesDir, packageName);
	try {
		if (lstatSync(profileLink).isSymbolicLink() && symlinkPointsTo(profileLink, ownedLink)) unlinkSync(profileLink);
	} catch (error) {
		/* v8 ignore next -- a non-ENOENT lstat failure requires a host filesystem fault */
		if (error.code !== "ENOENT") throw error;
	}
	try {
		unlinkSync(ownedLink);
	} catch (error) {
		/* v8 ignore next -- concurrent identical cleanup may remove the link first */
		if (error.code !== "ENOENT") throw error;
	}
}
/** Resolve one available explicit package export under Node ESM import conditions. */
function packageEntryFromPackage(packageName, packageDir, declared, subpath) {
	let candidates;
	try {
		candidates = resolve$1({
			name: packageName,
			exports: declared
		}, subpath);
	} catch (error) {
		if (error.message.startsWith("No known conditions for ")) return void 0;
		const specifier = subpath === "." ? packageName : packageName + subpath.slice(1);
		throw new Error(`dsh: cannot resolve ESM export ${specifier} from installed package ${packageName}`, { cause: error });
	}
	for (const candidate of candidates ?? []) {
		const target = candidate;
		const entry = resolve(packageDir, target);
		const relativeEntry = relative(packageDir, entry);
		if (!target.startsWith("./") || /^\.\.(?:[\\/]|$)/u.test(relativeEntry)) throw new Error(`dsh: installed package ${packageName} export ${subpath} resolves outside its package: ${target}`);
		if (existsSync(entry) && statSync(entry).isFile()) return pathToFileURL(entry).href;
	}
}
/** Resolve every explicit ESM runtime export that an out-of-tree plugin can import. */
function packageProxySource(packageName, packageDir) {
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	if (typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error(`dsh: installed package ${packageName} must declare a non-empty version`);
	const declared = manifest.exports;
	if (declared === void 0) {
		const main = typeof manifest.main === "string" && manifest.main.length > 0 ? manifest.main : void 0;
		const entry = join(packageDir, main ?? "index");
		try {
			const resolved = createRequire(join(packageDir, "package.json")).resolve(entry);
			return {
				version: manifest.version,
				targets: { ".": pathToFileURL(resolved).href }
			};
		} catch (error) {
			if (main === void 0 && (manifest.bin !== void 0 || manifest.types !== void 0 || manifest.typings !== void 0)) return {
				version: manifest.version,
				targets: {}
			};
			throw new Error(`dsh: installed package ${packageName} main entry is missing at ${entry}`, { cause: error });
		}
	}
	const subpaths = declared !== null && typeof declared === "object" && !Array.isArray(declared) && Object.keys(declared).some((key) => key.startsWith(".")) ? Object.keys(declared).filter((key) => key === "." || key.startsWith("./") && !key.includes("*") && !key.endsWith("/") && key !== "./package.json") : ["."];
	const targets = {};
	for (const subpath of subpaths) {
		const target = packageEntryFromPackage(packageName, packageDir, declared, subpath);
		if (target !== void 0) targets[subpath] = target;
	}
	return {
		version: manifest.version,
		targets
	};
}
/**
* Materialize a real package proxy whose exports retain pkg's virtual module
* URL. Files outside the executable cannot traverse a symlink into
* `/snapshot`, while an ESM re-export can import that URL and preserves the
* executable's single module instance for out-of-tree plugin peers.
*/
function ensureModuleProxy(link, packageName, version, targets) {
	const manifest = {
		name: packageName,
		version,
		private: true,
		type: "module",
		exports: Object.fromEntries(Object.keys(targets).map((subpath, index) => [subpath, `./entry-${index}.js`])),
		dsh: { moduleFallback: { targets } }
	};
	let stat;
	try {
		stat = lstatSync(link);
	} catch {
		stat = void 0;
	}
	if (stat?.isSymbolicLink()) {
		unlinkSync(link);
		stat = void 0;
	}
	if (stat !== void 0) {
		const existing = readModuleProxyRecord(link);
		if (existing?.dsh?.moduleFallback?.targets === void 0) throw new Error(`dsh: ${link} exists and is not a dsh-managed module proxy; remove it so dsh can manage the installation fallback`);
		if (existing.version === version && JSON.stringify(existing.dsh.moduleFallback.targets) === JSON.stringify(targets) && Object.keys(targets).every((_, index) => existsSync(join(link, `entry-${index}.js`)))) return;
		rmSync(link, { recursive: true });
	}
	mkdirSync(link, { recursive: true });
	writeFileSync(join(link, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
	for (const [index, target] of Object.values(targets).entries()) {
		const specifier = JSON.stringify(target);
		writeFileSync(join(link, `entry-${index}.js`), `export * from ${specifier}\nimport * as target from ${specifier}\nexport default target.default\n`);
	}
}
/** Read one package manifest used while traversing a module-fallback dependency graph. */
function readModuleFallbackManifest(anchor) {
	return JSON.parse(readFileSync(anchor, "utf8"));
}
/** Return dependency names that may be imported by a loader-visible plugin. */
function profileDependencyNames(manifest) {
	return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
}
/** Resolve the installation generation that every profile must find through the fallback directory. */
function resolveModuleFallbackEntries(installAnchor, materialize = true) {
	const appManifest = readModuleFallbackManifest(installAnchor);
	const links = /* @__PURE__ */ new Map();
	const declarers = /* @__PURE__ */ new Map();
	const versions = /* @__PURE__ */ new Map();
	/* v8 ignore next -- a real app manifest always declares its name */
	if (appManifest.name !== void 0) {
		links.set(appManifest.name, dirname(installAnchor));
		declarers.set(appManifest.name, installAnchor);
		versions.set(appManifest.name, appManifest.version);
	}
	const queue = [{
		anchor: installAnchor,
		manifest: appManifest
	}];
	for (let next = queue.shift(); next !== void 0; next = queue.shift())
 /* v8 ignore next -- a real app manifest always declares dependencies */
	for (const dep of profileDependencyNames(next.manifest)) {
		if (links.has(dep)) continue;
		const dir = packageDirFromAnchor(next.anchor, dep);
		if (dir === void 0) continue;
		links.set(dep, dir);
		declarers.set(dep, next.anchor);
		const manifestPath = join(dir, "package.json");
		const manifest = readModuleFallbackManifest(manifestPath);
		versions.set(dep, manifest.version);
		queue.push({
			anchor: manifestPath,
			manifest
		});
	}
	return {
		entries: !materialize ? [] : !isPackagedExecutable() ? [...links].map(([packageName, packageDir]) => ({
			kind: "symlink",
			packageName,
			packageDir
		})) : [...links].flatMap(([packageName, packageDir]) => {
			const source = packageProxySource(packageName, packageDir);
			return Object.keys(source.targets).length === 0 ? [] : [{
				kind: "proxy",
				packageName,
				version: source.version,
				targets: source.targets
			}];
		}),
		packageNames: new Set(links.keys()),
		packageDirs: links,
		declarers,
		versions
	};
}
/** Return whether one existing fallback entry already matches its resolved installation generation. */
function moduleFallbackEntryCurrent(modulesDir, entry) {
	const link = join(modulesDir, entry.packageName);
	try {
		const stat = lstatSync(link);
		if (entry.kind === "symlink") return stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir;
		if (!stat.isDirectory()) return false;
		const existing = readModuleProxyRecord(link);
		return existing?.version === entry.version && JSON.stringify(existing.dsh?.moduleFallback?.targets) === JSON.stringify(entry.targets) && Object.keys(entry.targets).every((_, index) => existsSync(join(link, `entry-${index}.js`)));
	} catch {
		return false;
	}
}
/** Return whether every required fallback entry is already ready for this installation. */
function moduleFallbackCurrent(modulesDir, entries) {
	return entries.every((entry) => moduleFallbackEntryCurrent(modulesDir, entry));
}
/**
* Maintain module fallbacks for one profile launch. The shared
* `$DSH_HOME/profiles/node_modules` mirrors the dsh installation dependency
* closure. Plain Node writes symlinks; a packaged executable writes ESM
* proxies under a cross-process lock because operating-system links cannot
* enter pkg's virtual filesystem. Missing packages carried only by selected
* bundles are linked through a profile-owned directory into that profile's
* `node_modules`; pnpm-managed entries remain authoritative, and another
* profile's links cannot change its resolution.
* @param options - installation anchor, optional loaded profile, and Harness home.
* @returns the computed fallback generation after optional materialization.
*/
async function healProfilesModuleFallback(options) {
	const { installAnchor, profile, home = resolveDshHome(), materialize = true } = options;
	const profilesDir = join(home, PROFILES_DIR);
	const modulesDir = join(profilesDir, "node_modules");
	if (materialize) mkdirSync(modulesDir, { recursive: true });
	const { entries, packageNames, packageDirs, declarers, versions } = resolveModuleFallbackEntries(installAnchor, materialize);
	if (materialize && !moduleFallbackCurrent(modulesDir, entries)) await withFileLock(modulesDir, () => {
		if (!moduleFallbackCurrent(modulesDir, entries)) healProfilesModuleFallbackLocked(entries, modulesDir);
		return Promise.resolve();
	});
	const profileDeclarers = /* @__PURE__ */ new Map();
	const profileVersions = /* @__PURE__ */ new Map();
	const localPackageNames = profile === void 0 ? [] : installedProfilePackageNames(profile);
	const profilePackages = profile === void 0 ? /* @__PURE__ */ new Map() : healProfileModuleFallback(profile, packageNames, materialize, profileDeclarers, profileVersions);
	return Object.freeze({
		profilesDir,
		profileDir: profile?.dir,
		localPackageNames: Object.freeze(localPackageNames),
		entries: Object.freeze([...[...packageDirs].map(([name, packageDir]) => Object.freeze({
			name,
			packageDir,
			version: versions.get(name),
			declarer: declarers.get(name),
			scope: "installation"
		})), ...[...profilePackages].map(([name, packageDir]) => Object.freeze({
			name,
			packageDir,
			version: profileVersions.get(name),
			declarer: profileDeclarers.get(name),
			scope: "profile"
		}))])
	});
}
/** Return installed direct dependencies that Node resolves before profile fallback. */
function installedProfilePackageNames(profile) {
	let manifest;
	try {
		manifest = readModuleFallbackManifest(join(profile.dir, "package.json"));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	return profileDependencyNames(manifest).filter((name) => {
		if (!existsSync(join(join(profile.dir, "node_modules", name), "package.json"))) return false;
		return !isProfileModuleFallbackLink(profile.dir, name);
	});
}
/**
* Compute a profile resolution generation without materializing links or proxies.
* @param options - installation anchor, profile, and optional Harness home.
* @returns the complete immutable generation.
*/
function createProfileResolutionGeneration(options) {
	return healProfilesModuleFallback({
		...options,
		materialize: false
	});
}
/** Heal one module-fallback generation while the cross-process writer lock is held. */
function healProfilesModuleFallbackLocked(entries, modulesDir) {
	for (const entry of entries) {
		const link = join(modulesDir, entry.packageName);
		mkdirSync(dirname(link), { recursive: true });
		if (entry.kind === "proxy") ensureModuleProxy(link, entry.packageName, entry.version, entry.targets);
		else ensureSymlink(link, entry.packageDir);
	}
}
/** Collect the first resolvable package directory for each dependency name. */
function dependencyClosure(anchors, reserved, exclude, declarers, versions) {
	const links = /* @__PURE__ */ new Map();
	const visited = new Set(reserved);
	for (const anchor of anchors) {
		const canonicalAnchor = join(realModuleDirectory(dirname(anchor)), basename(anchor));
		const manifest = readModuleFallbackManifest(canonicalAnchor);
		/* v8 ignore next -- an installable package manifest always declares its name */
		if (manifest.name === void 0) continue;
		if (!visited.has(manifest.name)) {
			visited.add(manifest.name);
			links.set(manifest.name, dirname(canonicalAnchor));
			declarers?.set(manifest.name, canonicalAnchor);
			versions?.set(manifest.name, manifest.version);
		}
		const queue = [{
			anchor: canonicalAnchor,
			manifest
		}];
		for (let next = queue.shift(); next !== void 0; next = queue.shift())
 /* v8 ignore next -- an installable package manifest always declares dependencies or peers */
		for (const dep of profileDependencyNames(next.manifest)) {
			if (visited.has(dep)) continue;
			const dir = packageDirFromAnchor(next.anchor, dep, exclude);
			if (dir === void 0) continue;
			visited.add(dep);
			links.set(dep, dir);
			declarers?.set(dep, next.anchor);
			const manifestPath = join(dir, "package.json");
			const dependencyManifest = readModuleFallbackManifest(manifestPath);
			versions?.set(dep, dependencyManifest.version);
			queue.push({
				anchor: manifestPath,
				manifest: dependencyManifest
			});
		}
	}
	return links;
}
/** Reconcile packages carried only by selected bundles into one profile. */
function healProfileModuleFallback(profile, installationPackageNames, materialize = true, declarers, versions) {
	const profileModulesDir = join(profile.dir, "node_modules");
	const ownedModulesDir = join(profile.dir, PROFILE_MODULE_FALLBACK_DIR, "node_modules");
	if (materialize) {
		mkdirSync(profileModulesDir, { recursive: true });
		mkdirSync(ownedModulesDir, { recursive: true });
	}
	const bundleLinks = dependencyClosure(profile.layers.filter((layer) => !installationPackageNames.has(layer.packageName)).map((layer) => join(layer.packageDir, "package.json")), installationPackageNames, (candidate, packageName) => {
		const profileLink = join(profileModulesDir, packageName);
		if (canonicalLinkPath(candidate) !== canonicalLinkPath(profileLink)) return false;
		try {
			return lstatSync(profileLink).isSymbolicLink() && symlinkPointsTo(profileLink, join(ownedModulesDir, packageName));
		} catch (error) {
			/* v8 ignore next 2 -- a non-ENOENT lstat failure requires a host filesystem fault */
			if (error.code === "ENOENT") return true;
			/* v8 ignore next -- see the host-filesystem exception above */
			throw error;
		}
	}, declarers, versions);
	for (const layer of profile.layers) bundleLinks.delete(layer.packageName);
	if (!materialize) return bundleLinks;
	for (const packageName of ownedPackageNames(ownedModulesDir)) if (!bundleLinks.has(packageName)) removeProfileSymlink(profileModulesDir, ownedModulesDir, packageName);
	for (const [packageName, target] of bundleLinks) {
		const ownedLink = join(ownedModulesDir, packageName);
		mkdirSync(dirname(ownedLink), { recursive: true });
		ensureSymlink(ownedLink, target);
		const profileLink = join(profileModulesDir, packageName);
		mkdirSync(dirname(profileLink), { recursive: true });
		ensureProfileSymlink(profileLink, ownedLink);
	}
	return bundleLinks;
}
/**
* Read a profile's manifest.
* @param binName - the diagnostic prefix on the thrown error.
* @param dir - the profile directory.
* @returns the parsed manifest.
*/
function readProfileManifest(binName, dir) {
	const path = join(dir, "package.json");
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`);
	}
	const parsed = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`);
	return parsed;
}
/**
* Write a profile's manifest back (2-space JSON, trailing newline).
* @param dir - the profile directory.
* @param manifest - the manifest value to persist.
*/
function writeProfileManifest(dir, manifest) {
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
}
/** Return whether two bundle lists have the same values in the same order. */
function sameBundles(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
/**
* Normalize an exact installation-owned bundle tuple to its shipped template,
* or add the shipped reload default to an exact current tuple. A changed value
* is written back during profile loading while every other manifest field is
* preserved; any other bundle list is user-owned and remains untouched.
*/
function normalizeShippedProfile(name, dir, manifest) {
	const installationOwned = INSTALLATION_OWNED_PROFILE_TUPLES[name];
	const template = PROFILE_TEMPLATES[name];
	const bundles = manifest.dsh?.profile?.bundles;
	if (template === void 0 || bundles === void 0) return manifest;
	const isRetiredTuple = installationOwned !== void 0 && sameBundles(bundles, installationOwned);
	const isCurrentTuple = sameBundles(bundles, template.bundles);
	const needsReloadDefault = manifest.dsh?.profile?.patchReload === void 0 && isCurrentTuple;
	if (!isRetiredTuple && !needsReloadDefault) return manifest;
	const normalized = {
		...manifest,
		dsh: {
			...manifest.dsh,
			profile: {
				...manifest.dsh?.profile,
				bundles: [...template.bundles],
				patchReload: manifest.dsh?.profile?.patchReload ?? template.patchReload
			}
		}
	};
	writeProfileManifest(dir, normalized);
	return normalized;
}
/**
* Resolve a package's root directory from one anchor without depending on the
* package exporting `./package.json` (`require.resolve` would need that):
* probe the require resolution paths for a directory holding the named
* manifest. This is Node's own node_modules lookup order, so the result
* matches what the Loader would import from the same anchor, and
* `existsSync` follows the symlinks pnpm's isolated layout uses.
*/
function packageDirFromAnchor(anchor, packageName, exclude = () => false) {
	/* v8 ignore next */
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json")) && !exclude(candidate, packageName)) return candidate;
	}
}
/**
* Resolve one bundle package's directory: installation anchor first, then the
* profile directory. The installation-first order is the contract that
* `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
* the same installation as the running dsh, never from a profile-local copy.
* Resolution does not require the package to export `./package.json`.
* @param binName - the diagnostic prefix on the thrown error.
* @param packageName - the bundle's package name from `dsh.profile.bundles`.
* @param installAnchor - absolute path of a file inside the dsh app package (its package.json).
* @param profileDir - the profile directory (second anchor).
* @returns the bundle package's absolute directory.
*/
function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
	for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
		const dir = packageDirFromAnchor(anchor, packageName);
		if (dir !== void 0) return dir;
	}
	throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsh installation or ${profileDir}; run 'dsh plugin --profile ${basename(profileDir)} install' if its dependency is not installed`);
}
/**
* Load an already initialized profile directory without resolving it through
* the shared Harness home. This is used by application-owned profiles whose
* package project and lifecycle belong to that application.
* @param binName - the diagnostic prefix on thrown errors.
* @param dir - absolute profile package directory.
* @param installAnchor - absolute path of the owning dsh app's package.json.
* @param options - `userLayer: false` skips reading `cordis.patch.yml`.
* @returns the resolved bundle layers and optional user patch layer.
*/
function loadProfileDirectory(binName, dir, installAnchor, options = {}) {
	const manifest = readProfileManifest(binName, dir);
	const bundles = manifest.dsh?.profile?.bundles ?? [];
	const rawPatchReload = manifest.dsh?.profile?.patchReload;
	if (rawPatchReload !== void 0 && rawPatchReload !== "live" && rawPatchReload !== "startup") throw new Error(`${binName}: profile manifest ${join(dir, "package.json")} dsh.profile.patchReload must be "live" or "startup"`);
	const patchReload = rawPatchReload ?? "live";
	const layers = bundles.map((packageName) => {
		const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
		const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
		if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
		const patchPath = join(packageDir, declared);
		return {
			packageName,
			packageDir,
			patchPath,
			patches: loadOverlayPatches(binName, patchPath)
		};
	});
	const patchPath = join(dir, PROFILE_PATCH_FILENAME);
	const patches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];
	return {
		name: basename(dir),
		dir,
		layers,
		patchPath,
		patches,
		patchReload
	};
}
/**
* Load a profile: resolve every `dsh.profile.bundles` entry to its patch
* layer and parse the profile's own patch file. A listed bundle without a
* `dsh.bundle` manifest fails loud — naming a bundle-less package as a layer
* is a misconfiguration, not "no patches".
* @param binName - the diagnostic prefix on thrown errors.
* @param name - the profile name.
* @param installAnchor - absolute path of the dsh app's package.json (first resolution anchor).
* @param home - the Harness home; defaults to {@link resolveDshHome}.
* @param options - `userLayer: false` skips reading `cordis.patch.yml`, so a
* bundles-only consumer (`--dump-default-config`, a recovery diagnostic)
* cannot fail on a broken user layer.
* @returns the loaded profile (empty `patches` when the user layer is skipped).
*/
function loadProfile(binName, name, installAnchor, home = resolveDshHome(), options = {}) {
	const dir = resolveProfileDir(name, home);
	if (!existsSync(join(dir, "package.json"))) {
		const template = PROFILE_TEMPLATES[name];
		if (template === void 0) throw new Error(`${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'dsh plugin --profile ${name} add <package>'`);
		initProfile(dir, template.bundles, template.patchReload);
	}
	normalizeShippedProfile(name, dir, readProfileManifest(binName, dir));
	return loadProfileDirectory(binName, dir, installAnchor, options);
}
/**
* Compose patch layers into the effective entry list over an empty root —
* the same single `applyEntryPatches` call the boot include makes, so flag
* derivation and config dumps see exactly what mounts.
* @param layers - patch lists in application order.
* @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
* @returns the composed entry list.
*/
function composeEntries(layers, warn = () => {}) {
	return applyEntryPatches([], structuredClone(layers.flat()), (message, ...args) => {
		let index = 0;
		warn(message.replace(/%C/g, () => JSON.stringify(args[index++])));
	});
}
//#endregion
//#region lib/types/profile-resolution/resolver.js
/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */
const WORKER_RESOLUTION_KEY = "@deepseek-ai/dsh-app-boot/profile-resolution";
const EMPTY_ATTRIBUTES = Object.freeze({});
/**
* Split a bare request into its package name without allocating path segments.
* @param request - module specifier to classify.
* @returns the bare package name, or undefined for non-package requests.
*/
function barePackageName(request) {
	if (!request || request[0] === "." || request[0] === "/" || request[0] === "\\" || request[0] === "#" || request.includes(":") || isBuiltin(request)) return;
	const first = request.indexOf("/");
	if (request[0] !== "@") return first < 0 ? request : request.slice(0, first);
	if (first < 0) return;
	const second = request.indexOf("/", first + 1);
	return second < 0 ? request : request.slice(0, second);
}
function canonicalPath(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
function prefixes(path) {
	const configured = resolve(path) + sep;
	const canonical = canonicalPath(path) + sep;
	return canonical === configured ? [configured] : [configured, canonical];
}
function compileGeneration(generation) {
	const profilePaths = prefixes(generation.profilesDir);
	const profile = generation.profileDir === void 0 ? [] : prefixes(generation.profileDir);
	return {
		entries: new Map(generation.entries.map((entry) => [entry.name, entry])),
		profilesDir: generation.profilesDir,
		profileDir: generation.profileDir,
		profilePaths,
		profileUrls: profilePaths.map((path) => pathToFileURL(path).href),
		profile,
		activeProfileUrls: profile.map((path) => pathToFileURL(path).href),
		localPackageNames: new Set(generation.localPackageNames),
		shared: new Set(profilePaths.map((prefix) => join(prefix, "node_modules"))),
		esmRoutes: /* @__PURE__ */ new Map(),
		cjsRoutes: /* @__PURE__ */ new Map()
	};
}
function startsWithin(path, roots) {
	for (const root of roots) if (path.startsWith(root)) return true;
	return false;
}
function nativePackageDir(parent, name) {
	for (const searchPath of createRequire(parent).resolve.paths(name)) {
		const candidate = join(searchPath, name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}
function localPackageCandidate(searchPath, name, flavor) {
	const candidate = join(searchPath, name);
	const stat = statSync(candidate, { throwIfNoEntry: false });
	return (flavor === "esm" ? stat?.isDirectory() === true : stat !== void 0 || [
		".js",
		".json",
		".node"
	].some((extension) => existsSync(candidate + extension))) ? {
		packageDir: candidate,
		canBeManagedLink: stat !== void 0
	} : void 0;
}
function selfReferenceName(parent) {
	let current = dirname(parent);
	while (true) {
		const manifestPath = join(current, "package.json");
		if (existsSync(manifestPath)) {
			let manifest;
			try {
				manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			} catch (_error) {
				return null;
			}
			return typeof manifest.name === "string" && manifest.exports != null ? manifest.name : false;
		}
		/* v8 ignore next -- scoped module requests normally find an owning manifest before node_modules. */
		if (basename(current) === "node_modules") return false;
		const next = dirname(current);
		if (next === current) return false;
		current = next;
	}
}
function packageImportsTarget(parent, request, conditions) {
	let current = dirname(parent);
	while (true) {
		const manifestPath = join(current, "package.json");
		if (existsSync(manifestPath)) {
			let manifest;
			try {
				manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			} catch (_error) {
				/* v8 ignore next -- native resolution cannot report MODULE_NOT_FOUND after an invalid scope manifest */
				return;
			}
			try {
				const target = imports(manifest, request, {
					conditions: [...conditions],
					unsafe: true
				})?.[0];
				return target !== void 0 && barePackageName(target) !== void 0 ? {
					specifier: target,
					parentURL: pathToFileURL(manifestPath).href
				} : void 0;
			} catch (_error) {
				/* v8 ignore next -- native resolution cannot report MODULE_NOT_FOUND before selecting a valid mapping */
				return;
			}
		}
		if (basename(current) === "node_modules") return void 0;
		const next = dirname(current);
		/* v8 ignore next -- a MODULE_NOT_FOUND package-import target always has an owning package scope */
		if (next === current) return void 0;
		current = next;
	}
}
function packageSearchPaths(entry, request, cjs) {
	const name = barePackageName(request);
	/* v8 ignore next -- fallback routes are created only for bare package requests */
	if (name === void 0) return cjs._nodeModulePaths(dirname(entry.declarer));
	const suffix = sep + name.split("/").join(sep);
	return entry.packageDir.endsWith(suffix) ? [entry.packageDir.slice(0, -suffix.length)] : cjs._nodeModulePaths(dirname(entry.declarer));
}
function localCandidateOwnsResolution(candidate, resolved, request, name) {
	if (startsWithin(resolved, prefixes(candidate))) return true;
	if (sameResolution(candidate, resolved)) return true;
	if ([
		".js",
		".json",
		".node"
	].some((extension) => sameResolution(candidate + extension, resolved))) return true;
	/* v8 ignore next -- a bounded native lookup can escape a candidate only through its root legacy main */
	if (request !== name) return false;
	try {
		const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		/* v8 ignore next -- a bounded native lookup outside the package directory requires a legacy main */
		if (typeof manifest.main !== "string") return false;
		return sameResolution(createRequire(join(candidate, "package.json")).resolve(resolve(candidate, manifest.main)), resolved);
	} catch (_error) {
		/* v8 ignore next -- this helper runs only after the same native resolution succeeded */
		return false;
	}
}
function isUnselectedPackageMiss(error) {
	const failure = error;
	return failure.code === "MODULE_NOT_FOUND" && failure.path === void 0;
}
function sameResolution(left, right) {
	if (left === right) return true;
	const leftPath = left.startsWith("file:") ? fileURLToPath(left) : left;
	const rightPath = right.startsWith("file:") ? fileURLToPath(right) : right;
	return canonicalPath(leftPath) === canonicalPath(rightPath);
}
/** One mutable pointer to immutable generation data. */
var ResolutionRouter = class {
	current;
	constructor(generation) {
		this.current = compileGeneration(generation);
	}
	replace(generation) {
		const entries = new Map(generation.entries.map((entry) => [entry.name, entry]));
		if (generation.profilesDir !== this.current.profilesDir || generation.profileDir !== this.current.profileDir) throw new Error("profile resolution: a generation cannot change its profile scope");
		for (const [name, current] of this.current.entries) {
			const next = entries.get(name);
			if (next === void 0 || !sameResolution(current.packageDir, next.packageDir) || !sameResolution(current.declarer, next.declarer) || current.version !== next.version || current.scope !== next.scope) throw new Error(`profile resolution: replacing ${JSON.stringify(name)} requires a process restart`);
		}
		const localPackageNames = new Set(generation.localPackageNames);
		for (const name of this.current.localPackageNames) if (!localPackageNames.has(name)) throw new Error(`profile resolution: removing local package ${JSON.stringify(name)} requires a process restart`);
		for (const name of localPackageNames) if (!this.current.localPackageNames.has(name) && this.current.entries.has(name)) throw new Error(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`);
		this.current = compileGeneration(generation);
	}
	routeScoped(request, parentRoutes, generation, flavor, nativeResolve, cacheable = false) {
		const { parent, profilesDir, requests } = parentRoutes;
		const name = barePackageName(request);
		if (name === void 0) return void 0;
		if (parentRoutes.selfReferenceName === void 0) parentRoutes.selfReferenceName = selfReferenceName(parent);
		if (parentRoutes.selfReferenceName === name || parentRoutes.selfReferenceName === null) {
			const state = { route: { kind: "native" } };
			requests.set(request, state);
			return state;
		}
		const target = generation.entries.get(name);
		const candidates = [];
		const localSearchPaths = [];
		for (const searchPath of createRequire(parent).resolve.paths(name)) {
			if (generation.shared.has(resolve(searchPath))) break;
			localSearchPaths.push(searchPath);
			const candidate = localPackageCandidate(searchPath, name, flavor);
			if (candidate !== void 0) {
				if (!(candidate.canBeManagedLink && generation.profile.some((prefix) => candidate.packageDir === join(prefix, "node_modules", name) && isProfileModuleFallbackLink(prefix.slice(0, -1), name)))) candidates.push(candidate);
			}
		}
		if (candidates.length > 0) if (flavor === "cjs" && nativeResolve !== void 0) try {
			const resolved = nativeResolve(localSearchPaths);
			const selected = candidates.find((candidate) => localCandidateOwnsResolution(candidate.packageDir, resolved, request, name));
			if (selected !== void 0) {
				const state = {
					route: {
						kind: "native",
						packageDir: selected.packageDir
					},
					packageDir: selected.packageDir,
					...cacheable ? { cjs: resolved } : {}
				};
				requests.set(request, state);
				return state;
			}
		} catch (error) {
			if (!isUnselectedPackageMiss(error)) throw error;
		}
		else {
			const selected = candidates[0];
			const state = {
				route: {
					kind: "native",
					packageDir: selected.packageDir
				},
				packageDir: selected.packageDir
			};
			requests.set(request, state);
			return state;
		}
		const eligible = target?.scope === "installation" || target?.scope === "profile" && parentRoutes.activeProfile;
		const after = join(dirname(profilesDir), "package.json");
		const route = eligible ? {
			kind: "fallback",
			entry: target,
			after
		} : {
			kind: "after-fallback",
			parent: after
		};
		const state = { route };
		if (route.kind === "fallback") requests.set(request, state);
		return state;
	}
	routeLocalPackage(request, parentRoutes, generation) {
		const name = barePackageName(request);
		if (name === void 0 || !parentRoutes.activeProfile || !generation.localPackageNames.has(name)) return void 0;
		const state = { route: { kind: "native" } };
		parentRoutes.requests.set(request, state);
		return state;
	}
	routeUrl(request, parentURL) {
		const generation = this.current;
		let parentRoutes = generation.esmRoutes.get(parentURL);
		if (parentRoutes === false) return void 0;
		const cached = parentRoutes?.requests.get(request);
		if (cached !== void 0) return cached;
		if (parentRoutes === void 0) {
			const profileIndex = generation.profileUrls.findIndex((prefix) => parentURL.startsWith(prefix));
			const activeProfileIndex = generation.activeProfileUrls.findIndex((prefix) => parentURL.startsWith(prefix));
			if (profileIndex < 0 && activeProfileIndex < 0) {
				generation.esmRoutes.set(parentURL, false);
				return;
			}
			let parent;
			try {
				parent = fileURLToPath(parentURL);
			} catch {
				generation.esmRoutes.set(parentURL, false);
				return;
			}
			const profileRoot = profileIndex >= 0 ? generation.profilePaths[profileIndex] : generation.profile[activeProfileIndex];
			/* v8 ignore next -- one matching index was established above */
			if (profileRoot === void 0) return void 0;
			parentRoutes = {
				parent,
				profilesDir: profileRoot.slice(0, -1),
				activeProfile: activeProfileIndex >= 0,
				requests: /* @__PURE__ */ new Map()
			};
			generation.esmRoutes.set(parentURL, parentRoutes);
		}
		const local = this.routeLocalPackage(request, parentRoutes, generation);
		if (local !== void 0) return local;
		return this.routeScoped(request, parentRoutes, generation, "esm");
	}
	routePath(request, parent, nativeResolve, cacheable = false) {
		const generation = this.current;
		let parentRoutes = generation.cjsRoutes.get(parent);
		if (parentRoutes === false) return void 0;
		const cached = parentRoutes?.requests.get(request);
		if (cached !== void 0) return cached;
		if (parentRoutes === void 0) {
			const profilesDir = generation.profilePaths.find((prefix) => parent.startsWith(prefix));
			const activeProfile = generation.profile.find((prefix) => parent.startsWith(prefix));
			if (profilesDir !== void 0 || activeProfile !== void 0) {
				const profileRoot = profilesDir ?? activeProfile;
				/* v8 ignore next -- one matching root was established above */
				if (profileRoot === void 0) return void 0;
				parentRoutes = {
					parent,
					profilesDir: profileRoot.slice(0, -1),
					activeProfile: activeProfile !== void 0,
					requests: /* @__PURE__ */ new Map()
				};
				generation.cjsRoutes.set(parent, parentRoutes);
			}
		}
		if (parentRoutes === void 0) {
			generation.cjsRoutes.set(parent, false);
			return;
		}
		return this.routeScoped(request, parentRoutes, generation, "cjs", nativeResolve, cacheable);
	}
	explicitRoute(request, paths) {
		if (barePackageName(request) === void 0) return void 0;
		for (const [index, path] of paths.entries()) {
			const parent = join(resolve(path), ".dsh-profile-resolution.cjs");
			if (startsWithin(parent, this.current.profilePaths) || startsWithin(parent, this.current.profile)) return {
				index,
				parent
			};
		}
	}
	nativeSelfReference(request, parent) {
		const name = barePackageName(request);
		if (name === void 0) return false;
		const self = selfReferenceName(parent);
		return self === name || self === null;
	}
	packageDir(specifier, parentURL) {
		const name = barePackageName(specifier);
		if (name === void 0) return void 0;
		const state = this.routeUrl(specifier, parentURL);
		if (state?.route.kind === "fallback") return state.route.entry.packageDir;
		if (state?.packageDir !== void 0) return state.packageDir;
		let parent;
		try {
			parent = state?.route.kind === "after-fallback" ? state.route.parent : fileURLToPath(parentURL);
		} catch {
			return;
		}
		const found = nativePackageDir(parent, name);
		if (state !== void 0 && found !== void 0) state.packageDir = found;
		return found;
	}
};
function internalModules() {
	const addon = createRequire(import.meta.url)("node-addon-require-builtin");
	const esmModule = addon.requireBuiltin("internal/modules/esm/loader");
	const cjsModule = addon.requireBuiltin("internal/modules/cjs/loader");
	const cjsHelpers = addon.requireBuiltin("internal/modules/helpers");
	const esmUtils = addon.requireBuiltin("internal/modules/esm/utils");
	const esmResolve = addon.requireBuiltin("internal/modules/esm/resolve");
	const esm = esmModule.getOrInitializeCascadedLoader();
	const modern = "getOrCreateModuleJob" in esm;
	/* v8 ignore start -- the supported Node 22/24/26 matrix validates each available Internal interface */
	if (typeof esm.resolveSync !== "function" || typeof Reflect.get(esm, modern ? "getOrCreateModuleJob" : "getModuleJobForImport") !== "function" || !modern && typeof Reflect.get(esm, "resolve") !== "function" || typeof cjsModule.Module._resolveFilename !== "function" || typeof cjsHelpers.getCjsConditions !== "function" || typeof esmUtils.getDefaultConditions !== "function" || typeof esmResolve.defaultResolve !== "function") throw new Error("profile resolution: unsupported Node module loader");
	/* v8 ignore stop */
	return {
		esm,
		esmDefaultResolve: (specifier, context) => esmResolve.defaultResolve(specifier, context),
		esmConditions: esmUtils.getDefaultConditions(),
		cjs: cjsModule.Module,
		cjsConditions: cjsHelpers.getCjsConditions(),
		modern
	};
}
function throwWithImporter(error, routedParent, parent) {
	const code = error.code;
	if (error instanceof Error && (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
		const routedPath = fileURLToPath(routedParent);
		const parentPath = fileURLToPath(parent);
		const originalMessage = error.message;
		const message = originalMessage.replaceAll(routedParent, parent).replaceAll(routedPath, parentPath);
		const stack = error.stack;
		error.message = message;
		/* v8 ignore next -- Node's resolver errors always carry a stack */
		if (stack !== void 0) error.stack = stack.replace(originalMessage, message);
	}
	throw error;
}
function throwWithoutCjsAnchor(error, anchor) {
	const resolved = error;
	const requireStack = resolved.requireStack;
	if (error instanceof Error && resolved.code === "MODULE_NOT_FOUND" && requireStack?.[0] !== void 0 && sameResolution(requireStack[0], anchor)) {
		const originalMessage = error.message;
		const originalBlock = `\nRequire stack:\n${requireStack.map((path) => `- ${path}`).join("\n")}`;
		const remaining = requireStack.slice(1);
		/* v8 ignore next -- routed calls always retain the original importing module */
		const replacement = remaining.length === 0 ? "" : `\nRequire stack:\n${remaining.map((path) => `- ${path}`).join("\n")}`;
		error.message = originalMessage.replace(originalBlock, replacement);
		resolved.requireStack = remaining;
		const stack = error.stack;
		/* v8 ignore next -- Node's resolver errors always carry a stack */
		if (stack !== void 0) error.stack = stack.replace(originalMessage, error.message);
	}
	throw error;
}
function assertEquivalent(actual, expected, request, parent) {
	if (sameResolution(actual, expected)) return;
	throw new Error(`profile resolution mismatch for ${JSON.stringify(request)} from ${parent}: disk resolved ${actual}, generation resolved ${expected}`);
}
function assertOptionalEquivalent(actual, expected, request, parent) {
	if (actual === void 0 && expected === void 0) return;
	if (actual !== void 0 && expected !== void 0 && sameResolution(actual, expected)) return;
	throw new Error(`profile resolution mismatch for ${JSON.stringify(request)} from ${parent}: disk selected ${actual ?? "nothing"}, generation selected ${expected ?? "nothing"}`);
}
/**
* Install one profile generation on Node's default ESM and CommonJS resolvers.
* @param generation - complete package table and profile scope.
* @param behavior - enforce the generation, or verify a materialized generation.
* @returns a registration that replaces the generation or restores the native methods.
*/
function installProfileResolution(generation, behavior = "enforce") {
	const router = new ResolutionRouter(generation);
	const { esm, esmDefaultResolve, esmConditions, cjs, cjsConditions, modern } = internalModules();
	const esmScope = /* @__PURE__ */ new Map();
	const profilePaths = [...prefixes(generation.profilesDir), ...generation.profileDir === void 0 ? [] : prefixes(generation.profileDir)];
	const profileUrls = profilePaths.map((path) => pathToFileURL(path).href);
	let recentEsmParent;
	let recentEsmScoped = false;
	let delegatedEsm;
	const adaptEsm = (native) => {
		const adapted = (request, parent, attributes) => {
			const delegated = delegatedEsm;
			/* v8 ignore next -- reentry requires a separate synchronous Node hook; supported launches install none */
			if (delegated !== void 0 && delegated.parent === parent && delegated.request === request) return native(request, parent, attributes);
			if (parent === void 0) return native(request, parent, attributes);
			let scoped = recentEsmParent === parent ? recentEsmScoped : esmScope.get(parent);
			if (scoped === void 0) {
				scoped = startsWithin(parent, profileUrls);
				esmScope.set(parent, scoped);
			}
			if (recentEsmParent !== parent) {
				recentEsmParent = parent;
				recentEsmScoped = scoped;
			}
			if (!scoped) return native(request, parent, attributes);
			const state = router.routeUrl(request, parent);
			if (state === void 0) {
				const target = request[0] === "#" ? packageImportsTarget(fileURLToPath(parent), request, esmConditions) : void 0;
				if (target === void 0) return native(request, parent, attributes);
				const restoreImporter = (error) => throwWithImporter(error, target.parentURL, parent);
				let expected;
				try {
					expected = adapted(target.specifier, target.parentURL, attributes);
					/* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
					if (expected instanceof Promise) expected = expected.catch(restoreImporter);
				} catch (error) {
					return restoreImporter(error);
				}
				if (behavior === "enforce") return expected;
				const actual = native(request, parent, attributes);
				/* v8 ignore start -- Node 22 is the asynchronous adapter and is covered by the external version matrix */
				if (expected instanceof Promise || actual instanceof Promise) return Promise.all([actual, expected]).then(([resolved, wanted]) => {
					assertEquivalent(resolved.url, wanted.url, request, parent);
					return resolved;
				});
				/* v8 ignore stop */
				assertEquivalent(actual.url, expected.url, request, parent);
				return actual;
			}
			const cacheable = attributes === EMPTY_ATTRIBUTES || Object.keys(attributes).length === 0;
			if (cacheable && state.esm !== void 0) return state.esm;
			const route = state.route;
			if (route.kind === "native") {
				const result = native(request, parent, attributes);
				if (cacheable && !(result instanceof Promise)) state.esm = result;
				return result;
			}
			const routedParent = pathToFileURL(route.kind === "fallback" ? route.entry.declarer : route.parent).href;
			if (behavior === "enforce") {
				const previous = delegatedEsm;
				delegatedEsm = {
					parent: routedParent,
					request
				};
				const restoreImporter = (error) => throwWithImporter(error, routedParent, parent);
				try {
					let result;
					try {
						result = native(request, routedParent, attributes);
					} catch (error) {
						return restoreImporter(error);
					}
					/* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
					if (result instanceof Promise) return result.catch(restoreImporter);
					if (cacheable) state.esm = result;
					return result;
				} finally {
					delegatedEsm = previous;
				}
			}
			const actual = native(request, parent, attributes);
			const previous = delegatedEsm;
			delegatedEsm = {
				parent: routedParent,
				request
			};
			const restoreImporter = (error) => throwWithImporter(error, routedParent, parent);
			try {
				let expected;
				try {
					const result = native(request, routedParent, attributes);
					expected = result;
					/* v8 ignore next -- Node 24+ resolves synchronously; the Node 22 matrix covers its Promise result */
					if (result instanceof Promise) expected = result.catch(restoreImporter);
				} catch (error) {
					return restoreImporter(error);
				}
				/* v8 ignore start -- Node 22 is the asynchronous adapter and is covered by the external version matrix */
				if (expected instanceof Promise || actual instanceof Promise) return Promise.all([actual, expected]).then(([resolved, wanted]) => {
					assertEquivalent(resolved.url, wanted.url, request, parent);
					if (cacheable) state.esm = resolved;
					return resolved;
				});
				/* v8 ignore stop */
				assertEquivalent(actual.url, expected.url, request, parent);
				if (cacheable) state.esm = actual;
				return actual;
			} finally {
				delegatedEsm = previous;
			}
		};
		return adapted;
	};
	let restoreEsm;
	/* v8 ignore else -- CI coverage runs Node 24 v2; the Node 22 matrix exercises the v1 adapter */
	if (modern) {
		const loader = esm;
		const original = Reflect.get(loader, "resolveSync");
		const resolveRequest = adaptEsm((request, parent, attributes) => original.call(loader, parent, {
			specifier: request,
			attributes
		}));
		const wrapped = (parent, request, ...rest) => rest.length ? Reflect.apply(original, loader, [
			parent,
			request,
			...rest
		]) : resolveRequest(request.specifier, parent, request.attributes ?? EMPTY_ATTRIBUTES);
		loader.resolveSync = wrapped;
		restoreEsm = () => {
			/* v8 ignore else -- registrations are disposed in reverse installation order */
			if (loader.resolveSync === wrapped) loader.resolveSync = original;
		};
	} else {
		const loader = esm;
		const original = Reflect.get(loader, "resolve");
		const originalSync = Reflect.get(loader, "resolveSync");
		const resolveRequest = adaptEsm((request, parent, attributes) => original.call(loader, request, parent, attributes));
		const resolveRequestSync = adaptEsm((request, parent, attributes) => originalSync.call(loader, request, parent, attributes));
		const wrapped = (request, parent, attributes = EMPTY_ATTRIBUTES) => resolveRequest(request, parent, attributes);
		const wrappedSync = (request, parent, attributes = EMPTY_ATTRIBUTES) => resolveRequestSync(request, parent, attributes);
		loader.resolve = wrapped;
		loader.resolveSync = wrappedSync;
		restoreEsm = () => {
			if (loader.resolve === wrapped) loader.resolve = original;
			if (loader.resolveSync === wrappedSync) loader.resolveSync = originalSync;
		};
	}
	const originalFilename = Reflect.get(cjs, "_resolveFilename");
	let delegatedCjs = 0;
	const resolveRoutedCjs = (request, routed, parent, main, options) => {
		const anchor = routed.kind === "fallback" ? routed.entry.declarer : routed.parent;
		const synthetic = new cjs(anchor);
		synthetic.parent = parent;
		synthetic.filename = anchor;
		synthetic.paths = routed.kind === "fallback" ? packageSearchPaths(routed.entry, request, cjs) : cjs._nodeModulePaths(dirname(anchor));
		try {
			return originalFilename.call(cjs, request, synthetic, main, options);
		} catch (error) {
			return throwWithoutCjsAnchor(error, anchor);
		}
	};
	const resolveNativeCjs = (request, searchPaths, parent, parentFilename, main, conditions) => {
		const synthetic = new cjs(parentFilename);
		synthetic.parent = parent;
		synthetic.filename = parentFilename;
		synthetic.paths = [...searchPaths];
		const options = conditions === void 0 ? void 0 : { conditions };
		return originalFilename.call(cjs, request, synthetic, main, options);
	};
	const resolvePackageImportCjs = (target, conditions) => {
		const state = router.routeUrl(target.specifier, target.parentURL);
		const resolveFrom = (parentURL) => fileURLToPath(esmDefaultResolve(target.specifier, {
			parentURL,
			conditions: [...conditions]
		}).url);
		/* v8 ignore next -- the target manifest was found inside the established profile scope */
		if (state === void 0) return resolveFrom(target.parentURL);
		if (state.route.kind === "native") return resolveFrom(target.parentURL);
		const route = state.route;
		if (route.kind === "after-fallback") return resolveFrom(pathToFileURL(route.parent).href);
		return resolveFrom(pathToFileURL(route.entry.declarer).href);
	};
	const wrappedFilename = (request, parent, main, options) => {
		if (delegatedCjs || !parent?.filename) return originalFilename.call(cjs, request, parent, main, options);
		const parentFilename = parent.filename;
		const cacheable = options?.paths === void 0 && options?.conditions === void 0;
		const explicitPaths = Array.isArray(options?.paths) ? options.paths : void 0;
		if (explicitPaths !== void 0 && router.nativeSelfReference(request, parentFilename)) return originalFilename.call(cjs, request, parent, main, options);
		const explicit = explicitPaths === void 0 ? void 0 : router.explicitRoute(request, explicitPaths);
		if (options?.paths !== void 0 && explicit === void 0) return originalFilename.call(cjs, request, parent, main, options);
		if (explicit !== void 0 && explicitPaths !== void 0 && explicit.index > 0) try {
			return originalFilename.call(cjs, request, parent, main, {
				...options,
				paths: explicitPaths.slice(0, explicit.index)
			});
		} catch (error) {
			if (!isUnselectedPackageMiss(error)) throw error;
		}
		const state = router.routePath(request, explicit?.parent ?? parentFilename, (searchPaths) => resolveNativeCjs(request, searchPaths, parent, parentFilename, main, options?.conditions), explicit === void 0 && cacheable);
		if (state === void 0) {
			const scoped = startsWithin(parentFilename, profilePaths);
			const conditions = options?.conditions ?? cjsConditions;
			const target = request[0] === "#" && scoped ? packageImportsTarget(parentFilename, request, conditions) : void 0;
			if (target === void 0) return originalFilename.call(cjs, request, parent, main, options);
			const expected = resolvePackageImportCjs(target, conditions);
			if (behavior === "enforce") return expected;
			const actual = originalFilename.call(cjs, request, parent, main, options);
			assertEquivalent(actual, expected, request, parentFilename);
			return actual;
		}
		if (cacheable && state.cjs !== void 0) return state.cjs;
		const route = state.route;
		if (route.kind === "native") {
			const result = originalFilename.call(cjs, request, parent, main, options);
			if (cacheable) state.cjs = result;
			return result;
		}
		if (route.kind === "after-fallback" && explicit !== void 0 && explicitPaths !== void 0) try {
			return originalFilename.call(cjs, request, parent, main, {
				...options,
				paths: [dirname(route.parent)]
			});
		} catch (error) {
			if (!isUnselectedPackageMiss(error)) throw error;
			const remaining = explicitPaths.slice(explicit.index + 1);
			if (remaining.length === 0) throw error;
			return wrappedFilename(request, parent, main, {
				...options,
				paths: remaining
			});
		}
		delegatedCjs++;
		try {
			const routedOptions = options?.conditions === void 0 ? void 0 : { conditions: options.conditions };
			let expected;
			try {
				expected = resolveRoutedCjs(request, route, parent, main, routedOptions);
			} catch (error) {
				if (route.kind !== "fallback" || !isUnselectedPackageMiss(error)) throw error;
				try {
					expected = resolveRoutedCjs(request, {
						kind: "after-fallback",
						parent: route.after
					}, parent, main, routedOptions);
				} catch (afterError) {
					const remaining = explicit === void 0 || explicitPaths === void 0 ? [] : explicitPaths.slice(explicit.index + 1);
					if (!isUnselectedPackageMiss(afterError) || remaining.length === 0) throw afterError;
					delegatedCjs--;
					try {
						return wrappedFilename(request, parent, main, {
							...options,
							paths: remaining
						});
					} finally {
						delegatedCjs++;
					}
				}
			}
			if (behavior === "enforce") {
				if (cacheable) state.cjs = expected;
				return expected;
			}
			const actual = originalFilename.call(cjs, request, parent, main, options);
			assertEquivalent(actual, expected, request, parentFilename);
			if (cacheable) state.cjs = actual;
			return actual;
		} finally {
			delegatedCjs--;
		}
	};
	cjs._resolveFilename = wrappedFilename;
	return {
		packageDir(specifier, parentURL) {
			const expected = router.packageDir(specifier, parentURL);
			if (behavior !== "verify" || !startsWithin(parentURL, profileUrls)) return expected;
			const name = barePackageName(specifier);
			if (name === void 0) return expected;
			let parent;
			try {
				parent = fileURLToPath(parentURL);
			} catch {
				return expected;
			}
			assertOptionalEquivalent(nativePackageDir(parent, name), expected, specifier, parentURL);
			return expected;
		},
		replace(next) {
			router.replace(next);
		},
		dispose() {
			/* v8 ignore else -- registrations are disposed in reverse installation order */
			if (cjs._resolveFilename === wrappedFilename) cjs._resolveFilename = originalFilename;
			restoreEsm();
		}
	};
}
/**
* Publish one generation for Harness-owned Workers.
* @param generation - complete package table and profile scope.
* @param behavior - enforce or verify the generation in newly created Workers.
* @returns a disposer restoring the previous thread environment data.
*/
function registerWorkerResolution(generation, behavior = "enforce") {
	const previous = getEnvironmentData(WORKER_RESOLUTION_KEY);
	setEnvironmentData(WORKER_RESOLUTION_KEY, {
		generation,
		behavior
	});
	return () => {
		setEnvironmentData(WORKER_RESOLUTION_KEY, previous);
	};
}
//#endregion
//#region lib/types/profile-resolution/service.js
/** Package metadata resolved through one profile resolution registration. */
function readPackage(dir, fallbackName) {
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) return void 0;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const name = manifest.name;
	const version = manifest.version;
	return {
		name: typeof name === "string" ? name : fallbackName,
		version: typeof version === "string" ? version : void 0,
		dir,
		manifestPath,
		manifest
	};
}
/** Package lookup shared by metadata consumers in one profile process. */
var PluginPackages = class extends Service {
	packages = /* @__PURE__ */ new Map();
	resolver;
	behavior;
	disposeWorkerResolution;
	constructor(ctx, config = {}) {
		super(ctx, "pluginPackages");
		this.behavior = config.behavior ?? "enforce";
		if (config.generation === void 0) return;
		const resolver = installProfileResolution(config.generation, this.behavior);
		this.disposeWorkerResolution = registerWorkerResolution(config.generation, this.behavior);
		this.resolver = resolver;
		ctx.effect(() => () => {
			this.disposeWorkerResolution?.();
			resolver.dispose();
		}, "profile package resolution");
	}
	/**
	* Publish an additive generation for this process and subsequently created Workers.
	* @param generation - fully constructed successor generation.
	*/
	replace(generation) {
		if (this.resolver === void 0) throw new Error("plugin-packages: runtime resolution is not installed");
		this.resolver.replace(generation);
		this.packages = /* @__PURE__ */ new Map();
		this.disposeWorkerResolution?.();
		this.disposeWorkerResolution = registerWorkerResolution(generation, this.behavior);
	}
	/**
	* Locate the package named by a specifier without requiring a package export.
	* @param specifier - module specifier whose package owns the requested module.
	* @param parentURL - URL whose Node lookup order applies.
	* @returns the parsed package, or undefined when no package owns the request.
	*/
	packageOf(specifier, parentURL) {
		const name = barePackageName(specifier);
		if (name === void 0) return void 0;
		const dir = this.resolver === void 0 ? packageDirFromParent(name, parentURL) : this.resolver.packageDir(name, parentURL);
		if (dir === void 0) return void 0;
		const key = JSON.stringify({
			dir,
			name
		});
		if (!this.packages.has(key)) this.packages.set(key, readPackage(dir, name));
		return this.packages.get(key);
	}
};
function packageDirFromParent(name, parentURL) {
	for (const searchPath of createRequire(parentURL).resolve.paths(name)) {
		const candidate = join(searchPath, name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}
//#endregion
//#region lib/types/index.js
/**
* Shared boot glue for `dsh` profiles, including the CLI packaged by the Python runtime wheel: load the gitignored
* `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), load the
* optional user patch layers from the Harness home (`~/.dsh`), expose its path resolver to
* config expressions, and drive the Cordis Loader against a leaf `cordis.yml` until the tree settles.
* @module @deepseek-ai/dsh-app-boot
*/
/**
* Resolve the config to boot. Replay swaps a `cordis.yml` basename for
* `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
* @param configPath - the requested config path (absolute, or relative to `cwd`).
* @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the
*   basename.
* @param cwd - the base a relative `configPath` resolves against.
* @returns the absolute path of the config to boot.
*/
function resolveConfigPath(configPath, snapshotMode, cwd = process.cwd()) {
	const absolute = resolve(cwd, configPath);
	if (snapshotMode !== "replay") return absolute;
	return resolve(dirname(absolute), basename(absolute).replace(/cordis\.ya?ml$/, "cordis.snapshot.yml"));
}
/**
* Load the optional gitignored `.env` from `dir`. Missing files fall back to the
* ambient environment; other read failures are reported through `warn`.
* @param binName - the diagnostic prefix on the warn line.
* @param dir - the directory whose `.env` to load.
* @param warn - sink for the one-line misconfiguration diagnostic.
*/
function loadEnv(binName, dir = process.cwd(), warn = (line) => void process.stderr.write(line)) {
	try {
		process.loadEnvFile(resolve(dir, ".env"));
	} catch (error) {
		if (error?.code !== "ENOENT") warn(`${binName}: failed to load .env: ${String(error)}\n`);
	}
}
/** Exact names no discovered file may set. */
const BOOTSTRAP_NAMES = new Set([
	"PATH",
	"HOME",
	"USERPROFILE",
	"SHELL",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"PERL5OPT",
	"PERL5LIB",
	"PYTHONSTARTUP",
	"PYTHONPATH",
	"RUBYOPT",
	"RUBYLIB",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"PYTHONHOME",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_COUNT",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"BROWSER",
	"DEEPSEEK_BASE_URL",
	"DEEPSEEK_SEARCH_BASE_URL",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"NODE_TLS_REJECT_UNAUTHORIZED"
]);
/** Name prefixes no discovered file may set. */
const BOOTSTRAP_PREFIXES = [
	"DSH_",
	"XDG_",
	"DYLD_",
	"BASH_FUNC_"
];
/**
* The bootstrap names the Harness-home `.env` alone may set. A proxy chooses the route every
* request takes, so the invoking directory's file — which arrives with a clone — keeps refusing
* them; the home file is the user's own, and `DSH_HOME` is itself bootstrap-only, so no `.env` can
* relocate this exemption. The CA and TLS names in the same group stay refused everywhere: they
* change what is trusted, not where traffic goes.
*/
const HOME_LAYER_PROXY_NAMES = new Set([
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY"
]);
/**
* Whether a variable may come only from the inherited process environment
* because it changes process, runtime, VCS, or network bootstrap. The Harness-home
* file is additionally allowed {@link HOME_LAYER_PROXY_NAMES}.
* @param name - the variable name.
* @returns true when only the inherited environment may supply it.
*/
function isBootstrapOnly(name) {
	const upper = name.toUpperCase();
	return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
/**
* Parse one directory's `.env` without applying it, rejecting bootstrap-only
* names before any value is materialized.
* @param binName - the diagnostic prefix on the thrown error.
* @param dir - the directory whose `.env` to read.
* @param warn - sink for the one-line unreadable-file diagnostic.
* @param home - the resolved Harness home; when `dir` is it, {@link HOME_LAYER_PROXY_NAMES} are accepted.
* @returns the parsed entries, or `undefined` when the file is absent or unreadable.
* @throws when the file declares a name {@link isBootstrapOnly} rejects and this layer may not set.
*/
function readEnvLayer(binName, dir, warn, home) {
	const path = resolve(dir, ".env");
	const isHome = resolve(dir) === home;
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") warn(`${binName}: failed to load .env: ${String(error)}\n`);
		return;
	}
	const values = parseEnv(content);
	for (const name of Object.keys(values)) {
		if (!isBootstrapOnly(name)) continue;
		const proxyName = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase());
		if (isHome && proxyName) continue;
		const remedy = proxyName ? `export ${name}, or put it in ${resolve(home, ".env")}, which does not travel with a repository` : `export ${name} instead of putting it in a .env file`;
		throw new Error(`${binName}: ${path} sets "${name}", which only the launching environment may set (it decides how this process starts, where its code and instructions load from, or how it reaches the network); ${remedy}`);
	}
	return {
		path,
		values
	};
}
/**
* Load the product CLI's inherited > invoking-directory `.env` > Harness-home
* `.env` snapshot. The Harness home resolves before either file; both files
* are checked before either is applied, and accepted values are materialized
* without replacing inherited ones. The snapshot preserves which layer supplied each value.
* @param binName - the diagnostic prefix on the diagnostics.
* @param cwd - the invoking directory whose `.env` is the project layer.
* @param warn - sink for the one-line misconfiguration diagnostics.
* @returns this run's frozen environment snapshot.
* @throws when either file declares a bootstrap-only variable, except {@link HOME_LAYER_PROXY_NAMES} in the Harness-home file.
*/
function loadLayeredEnv(binName, cwd = process.cwd(), warn = (line) => void process.stderr.write(line)) {
	const home = resolveDshHome();
	const inherited = { ...process.env };
	const project = readEnvLayer(binName, cwd, warn, home);
	const user = home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);
	for (const layer of [project, user]) {
		if (layer === void 0) continue;
		for (const [name, value] of Object.entries(layer.values)) if (process.env[name] === void 0) process.env[name] = value;
	}
	return createLaunchEnvironmentSnapshot([
		{
			source: "process",
			values: inherited
		},
		...project === void 0 ? [] : [{
			source: "project-env",
			path: project.path,
			values: project.values
		}],
		...user === void 0 ? [] : [{
			source: "user-env",
			path: user.path,
			values: user.values
		}]
	]);
}
const bootstrapIncludes = /* @__PURE__ */ new WeakMap();
const userPatchesSchema = entryListSchema;
/**
* Watch the user patch layer and reapply it to the boot Include without rollback.
* @param ctx - settled app context containing the root Include and an active HMR service.
* @param options - diagnostic, file, and patch-composition inputs.
* @returns an asynchronous disposer after the exact-path watcher is ready.
* @throws when HMR or the root Include is absent, watcher setup fails, or initial path resolution fails.
*/
async function watchUserPatches(ctx, options) {
	const { binName, filename, compose = (patches) => patches } = options;
	const hmr = ctx.get("hmr");
	if (hmr === void 0) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`);
	const entry = bootstrapIncludes.get(ctx);
	if (entry === void 0) throw new Error(`${binName}: user patch-layer watching requires the root Include entry`);
	const register = watchConfig(ctx, filename, hmr.config, async () => {
		const { patches: _previousPatches, ...includeConfig } = entry.options.config;
		const patches = compose(loadOptionalPatches(binName, filename) ?? []);
		await entry.update({ config: {
			...includeConfig,
			patches
		} });
		await ctx.loader.await();
		await Promise.allSettled([...ctx.loader.entries()].map((entry) => Promise.resolve(entry.fiber?.await())));
		const failures = await inactiveEntries(ctx);
		if (failures.length > 0) throw new Error(activationDiagnostic(binName, "warning", failures).trimEnd());
	});
	try {
		return await register;
	} catch (error) {
		if (error?.code === "INACTIVE_EFFECT") return async () => {};
		throw error;
	}
}
/**
* Load an optional patch-list file: a top-level YAML array of loader patch
* entries (`@deepseek-ai/cordis-plugin-include`'s `PatchOptions`): id-targeted config
* overrides and `insert` lists, with `!!js` expressions allowed. A missing
* file means "no layer"; an unreadable, unparsable, or non-array file throws —
* a present patch file that cannot apply is a misconfiguration and must fail
* loud at boot, never be silently skipped.
* @param binName - the diagnostic prefix on the thrown error.
* @param file - absolute path of the patch file.
* @returns the parsed patches, or `undefined` when the file does not exist.
*/
function loadOptionalPatches(binName, file) {
	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return void 0;
		throw new Error(`${binName}: failed to read patches ${file}: ${String(error)}`);
	}
	return parsePatchList(binName, file, content, "patches");
}
/**
* Load a required overlay patch list: a bundle's `cordis.patch.yml` or a
* `--patch <path>` overlay. Same file format as {@link loadOptionalPatches},
* but a missing file throws, because the caller named this file — its absence
* is a misconfiguration, not "no overlay".
* @param binName - the diagnostic prefix on the thrown error.
* @param file - absolute path of the overlay file.
* @returns the parsed patch list.
*/
function loadOverlayPatches(binName, file) {
	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`${binName}: failed to read overlay ${file}: ${String(error)}`);
	}
	return parsePatchList(binName, file, content, "overlay");
}
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch; keep assertion names literal. */
function anchorInsertedPluginNames(patches, file) {
	const base = dirname(resolve(file));
	const visit = (entry) => {
		if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../"))) entry.name = pathToFileURL(resolve(base, entry.name)).href;
		if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
	};
	for (const patch of patches) patch.insert?.forEach(visit);
	return patches;
}
/**
* Parse one loader patch list: a top-level YAML array of
* `@deepseek-ai/cordis-plugin-include` `PatchOptions` (id-targeted config overrides and
* `insert` lists, `!!js` expressions allowed). Every invalid field or value throws,
* because a patch file that cannot be applied at all is a misconfiguration; a
* single patch whose target row is absent stays a per-entry Loader warning, so
* one overlay shared across surfaces does not have to match every tree.
* @param binName - the diagnostic prefix on the thrown error.
* @param file - the source path, quoted in errors.
* @param content - the file's text.
* @param label - what to call this list in errors (`patches`, `overlay`).
* @returns the parsed patch list.
*/
function parsePatchList(binName, file, content, label) {
	let parsed;
	try {
		parsed = yaml.load(content, { schema: userPatchesSchema });
	} catch (error) {
		throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
	parsed.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
	});
	return anchorInsertedPluginNames(parsed, file);
}
/**
* Compose the effective entry list exactly as `boot()` would mount it: parse
* the base config file with the include's entry-list dialect, apply every
* layer's patches as ONE flattened list through the include's own patch
* algorithm (`applyEntryPatches`) — the same single call `boot()` makes, so
* even patch-visibility corner cases (a later layer targeting a group child a
* plain config replacement introduced, which the single-pass id index never
* sees) compose identically — then render the result as YAML in the same
* dialect (`!!js` expressions print verbatim, unevaluated).
*
* Every run of rows from the same file and patch layers is preceded by a `# ==` comment
* naming the file that contributed the rows and any layers that patched them,
* so the output stays a loadable YAML document while showing which section
* comes from which file. The file and patch labels are derived from single-call prefix
* snapshots (base + layers 1..k), diffed positionally: the patch algorithm
* only rewrites rows in place or appends, so a top-level index identifies one
* row across snapshots, and a layer whose addition changes the row (config
* replacement, disable, group insert) is listed as having patched it.
*
* A patch that matches no row is reported through `warn` with its layer
* label, mirroring the Loader's boot-time warning. Earlier layers' patches
* see an identical preceding state in every snapshot that includes them, so
* each snapshot's warning list extends the previous one and the new tail
* belongs to the added layer.
* @param binName - the diagnostic prefix on read/parse errors.
* @param absoluteConfigPath - the base config file `boot()` would include.
* @param layers - overlay layers in application order (later wins).
* @param warn - sink for skipped-patch diagnostics; defaults to stderr.
* @returns the composed entry list rendered as a YAML document with
* source comment separators.
*/
function renderConfigDump(binName, absoluteConfigPath, layers, warn = (line) => void process.stderr.write(`${line}\n`)) {
	let content;
	try {
		content = readFileSync(absoluteConfigPath, "utf8");
	} catch (error) {
		throw new Error(`${binName}: failed to read config ${absoluteConfigPath}: ${String(error)}`);
	}
	let parsed;
	try {
		parsed = yaml.load(content, { schema: entryListSchema });
	} catch (error) {
		throw new Error(`${binName}: failed to parse config ${absoluteConfigPath}: ${String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`);
	const baseLabel = basename(absoluteConfigPath);
	const base = parsed;
	const snapshot = (count, warnings) => {
		return applyEntryPatches(base, structuredClone(layers.slice(0, count).flatMap((layer) => layer.patches)), (message, ...args) => {
			let index = 0;
			warnings.push(message.replace(/%C/g, () => JSON.stringify(args[index++])));
		});
	};
	let previous = base;
	let previousWarnings = [];
	const entryOrigins = base.map(() => ({
		origin: baseLabel,
		patchedBy: []
	}));
	let composed = base;
	for (let count = 1; count <= layers.length; count += 1) {
		const layer = layers[count - 1];
		/* v8 ignore next -- count iterates 1..length, so the slot exists */
		if (layer === void 0) continue;
		const warnings = [];
		composed = snapshot(count, warnings);
		for (const line of warnings.slice(previousWarnings.length)) warn(`${binName}: [${layer.label}] ${line}`);
		const before = previous.map((entry) => JSON.stringify(entry));
		for (let index = 0; index < composed.length; index += 1) if (index >= before.length) entryOrigins.push({
			origin: layer.label,
			patchedBy: []
		});
		else if (JSON.stringify(composed[index]) !== before[index]) entryOrigins[index]?.patchedBy.push(layer.label);
		previous = composed;
		previousWarnings = warnings;
	}
	return groupedDump(composed, entryOrigins);
}
/** Render the composed rows grouped under one source-and-patches comment per contiguous run. */
function groupedDump(composed, entryOrigins) {
	const lines = [];
	let currentLabel;
	let group = [];
	const flush = () => {
		if (currentLabel === void 0 || group.length === 0) return;
		lines.push(`# == ${currentLabel}`);
		lines.push(yaml.dump(group, {
			schema: entryListSchema,
			noRefs: true
		}).trimEnd());
		group = [];
	};
	for (let index = 0; index < composed.length; index += 1) {
		const record = entryOrigins[index];
		/* v8 ignore next -- this array is index-aligned with composed by construction */
		if (record === void 0) continue;
		const label = record.patchedBy.length === 0 ? record.origin : `${record.origin}, patched by ${record.patchedBy.join(", ")}`;
		if (label !== currentLabel) {
			flush();
			currentLabel = label;
		}
		group.push(composed[index]);
	}
	flush();
	return lines.join("\n") + "\n";
}
/**
* Mount and remember the exact root Include entry used by app boot and user patch-layer HMR.
* @param ctx - context carrying an initialized Loader service.
* @param absoluteConfigPath - absolute YAML or JSON configuration path.
* @param patches - initial app and user patches, applied in order.
* @param bareModuleBaseUrl - optional installed-host base for bare package
* names; relative names continue to resolve beside the configuration file.
* @returns the created root Include entry, or `undefined` when a surface
* disposed the whole tree (taking the Loader service with it) while the
* entry creation was in flight.
*/
async function mountRootInclude(ctx, absoluteConfigPath, patches = [], bareModuleBaseUrl) {
	ctx.loader.builtins.include = bareModuleBaseUrl === void 0 ? Include : class HostResolvedRootInclude extends Include {
		import(name, getOuterStack) {
			const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
			if (name.startsWith(".") || name.startsWith("cordis:")) return super.import(specifier, getOuterStack);
			const internal = this.ctx.loader.internal;
			/* v8 ignore next -- Node supplies the internal loader; this preserves the
			original diagnostic for hypothetical embedders without it. */
			if (internal === void 0) return super.import(specifier, getOuterStack);
			return internal.import(specifier, bareModuleBaseUrl, {});
		}
	};
	ctx.loader.builtins.group = Group;
	const rootInclude = {
		id: "include",
		name: "cordis:include",
		config: {
			path: pathToFileURL(absoluteConfigPath).href,
			...patches.length > 0 ? { patches: [...patches] } : {}
		}
	};
	const includeId = await ctx.loader.create(rootInclude);
	const loader = ctx.get("loader");
	if (loader === void 0) return void 0;
	const entry = loader.resolve(includeId);
	bootstrapIncludes.set(ctx, entry);
	return entry;
}
const assembledActivationRejections = /* @__PURE__ */ new Map();
function retainAssembledRejection(reason) {
	assembledActivationRejections.set(reason, (assembledActivationRejections.get(reason) ?? 0) + 1);
}
function releaseAssembledRejection(reason) {
	const count = assembledActivationRejections.get(reason);
	if (count === void 0 || count === 1) assembledActivationRejections.delete(reason);
	else assembledActivationRejections.set(reason, count - 1);
}
async function observeLoaderRejectionCheckpoint(reasons) {
	for (const reason of reasons) retainAssembledRejection(reason);
	try {
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		for (const reason of reasons) releaseAssembledRejection(reason);
	}
}
/**
* How long {@link installFailLoud} waits for its `release` hook before exiting
* anyway. A wedged disposer must delay the fatal exit, never cancel it.
*/
const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2e3;
/**
* Install before boot to turn a late unhandled plugin-init rejection into one
* labelled stderr diagnostic and `exit(1)`. A rejection already included by
* {@link auditStartupEntries} is ignored during its process checkpoint;
* every other rejection remains fatal. Stdout remains untouched for ACP; the
* returned function removes the handler.
*
* The Loader mounts entries concurrently, so a surface that owns the terminal
* can already hold it when a sibling entry rejects. Exiting straight from the
* handler would strand raw mode, bracketed paste, and the keyboard protocol on
* the user's shell, and leave an in-flight terminal query's reply to land as
* literal text at the next prompt. `release` is the terminal owner's chance to
* hand it back; it is awaited under {@link FAIL_LOUD_RELEASE_TIMEOUT_MS}, whose
* timer stays referenced so a never-settling disposer cannot let Node reach an
* empty event loop and exit 0 instead of failing.
*
* The diagnostic is written before the release so a hanging or failing disposer
* cannot swallow the reason. The handler stays installed while the release runs
* — removing it would let a second concurrent rejection become uncaught and kill
* the process mid-teardown, stranding exactly the terminal state this restores —
* so a latch keeps the first rejection the reported one and lets later
* rejections (including the release's own) fall through to the pending exit.
* @param binName - the diagnostic prefix on the fatal-failure line.
* @param proc - the process slice to register on; tests inject a fake.
* @param release - optional teardown awaited before exit, used by a
*   terminal-owning surface to restore the terminal. Its own failure is
*   swallowed because the pending fatal exit already owns the outcome.
* @returns the uninstaller that removes the rejection handler.
*/
function installFailLoud(binName, proc = process, release) {
	let exiting = false;
	const handler = (err) => {
		if (assembledActivationRejections.has(err)) return;
		if (exiting) return;
		exiting = true;
		proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		if (release === void 0) {
			proc.exit(1);
			return;
		}
		(async () => {
			let timer;
			try {
				await Promise.race([(async () => release())(), new Promise((resolve) => {
					timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS);
				})]);
			} catch {}
			clearTimeout(timer);
			proc.exit(1);
		})();
	};
	const uninstall = () => void proc.off("unhandledRejection", handler);
	proc.on("unhandledRejection", handler);
	return uninstall;
}
/**
* Value mirrors used because Cordis's const enum has no runtime object to import.
* Keep aligned with `packages/extensions/tool-cordis/src/fiber-state.ts` and
* `packages/client/web/src/loader-status.ts`.
*/
const FIBER_PENDING = 0;
const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;
/**
* Entry ids whose presence defines a usable DSH application.
*
* The list is global rather than profile metadata. Missing or disabled ids do
* not affect startup; an enabled listed entry must activate. The list covers
* shared Agent execution, application endpoints, and Web bootstrap/transport.
*/
const requiredStartupEntryIds = new Set([
	"agent-loop",
	"webserver",
	"modules",
	"connection",
	"headless-runner",
	"acp",
	"sdk-jsonrpc-server"
]);
/** Render plugin stacks, nested causes, and aggregate member failures once per error. */
function formatActivationError(error) {
	const details = [];
	const seen = /* @__PURE__ */ new Set();
	function visit(value) {
		if (!(value instanceof Error)) {
			details.push(String(value));
			return;
		}
		if (seen.has(value)) return;
		seen.add(value);
		details.push(value.stack ?? value.message);
		if (value.cause !== void 0) visit(value.cause);
		if (value instanceof AggregateError) value.errors.forEach(visit);
	}
	visit(error);
	return details.join("\n");
}
/**
* Collect Loader activation failures and disabled-expression errors. Failed
* fibers are awaited to recover their recorded rejection reason and coalesce
* duplicate Loader notifications through the next process rejection checkpoint.
*/
async function inactiveEntries(ctx) {
	const failures = [];
	const rejectionReasons = [];
	for (const entry of ctx.loader.entries()) {
		const subject = `${entry.options.id} (${entry.options.name})`;
		try {
			if (entry.disabled) continue;
		} catch (error) {
			failures.push({
				entry,
				diagnostic: `${subject}: disabled expression failed: ${formatActivationError(error)}`
			});
			continue;
		}
		const fiber = entry.fiber;
		if (fiber === void 0) {
			failures.push({
				entry,
				diagnostic: `${subject}: failed to import`
			});
			continue;
		}
		const state = fiber.state;
		if (state === FIBER_ACTIVE) continue;
		if (state === FIBER_FAILED) {
			try {
				await fiber.await();
			} catch (error) {
				rejectionReasons.push(error);
				failures.push({
					entry,
					diagnostic: `${subject}: ${formatActivationError(error)}`
				});
			}
			continue;
		}
		if (state === FIBER_PENDING) {
			const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === void 0);
			failures.push({
				entry,
				diagnostic: `${subject}: pending (waiting for ${missing.length === 1 ? "service" : "services"}: ${missing.join(", ") || "unknown"})`
			});
		} else failures.push({
			entry,
			diagnostic: `${subject}: fiber state ${String(state)}`
		});
	}
	if (rejectionReasons.length > 0) await observeLoaderRejectionCheckpoint(rejectionReasons);
	return failures;
}
/** Render an inactive-entry diagnostic with a count and severity label. */
function activationDiagnostic(binName, severity, failures) {
	const noun = failures.length === 1 ? "entry" : "entries";
	return `${binName === "" ? "" : `${binName}: `}${severity}: ${String(failures.length)} ${noun} did not activate\n${failures.map((failure) => failure.diagnostic).join("\n")}\n`;
}
/**
* Apply DSH startup policy to a settled Loader tree.
*
* Inactive entries from the global required list reject startup. Other
* inactive entries produce one warning and leave successful siblings running.
* Required ids absent from the tree, and disabled required entries, are ignored.
* A throwing disabled expression is an entry failure, not a disabled entry.
* The bootstrap Include must activate so unreadable or invalid root config is fatal.
* @param ctx - the settled context whose Loader entries to audit.
* @param binName - the diagnostic prefix on optional-entry warnings.
* @param warn - sink for optional-entry warnings.
* @returns after optional warnings if required startup checks pass.
* @throws when the bootstrap Include or a required entry is inactive or its disabled expression throws.
*/
async function auditStartupEntries(ctx, binName, warn = (line) => void process.stderr.write(line)) {
	const failures = await inactiveEntries(ctx);
	const required = [];
	const optional = [];
	for (const failure of failures) (failure.entry === bootstrapIncludes.get(ctx) || requiredStartupEntryIds.has(failure.entry.options.id) ? required : optional).push(failure);
	if (optional.length > 0) warn(activationDiagnostic(binName, "warning", optional));
	if (required.length > 0) throw new Error(activationDiagnostic("", "required startup failure", required).trimEnd());
}
/**
* Boot the Loader against `absoluteConfigPath` and return only after the whole
* tree settles. Relative entry names resolve against the config directory;
* bare package names resolve there by default or against an explicit
* `bareModuleBaseUrl` for closed packaged runtimes. The bootstrap include
* is statically imported and mounted as the `cordis:include` builtin, loading
* through the ambient module pipeline (vite/tsx/plain ESM). The package build
* embeds Include while leaving Loader external, so the built include tree and
* host share one Loader peer. Loader settlement drains entry work without
* rejecting the whole tree. The final {@link auditStartupEntries} call rejects
* failures in the global required list and warns about other failed, missing,
* and pending entries while successful siblings remain active. Later unhandled
* rejections remain covered by {@link installFailLoud}. Built bins need the Loader's native
* helper for bare plugin specifiers; relative specifiers do not.
* @param binName - the diagnostic prefix for load-failure errors.
* @param absoluteConfigPath - the config to include; must already be absolute
* (see {@link resolveConfigPath}).
* @param patches - optional overlay patches applied over the included tree
* (see {@link loadOptionalPatches}); an empty list mounts none.
* @param prepare - optional host setup run after Loader installation and before any config-tree entry mounts.
* @param bareModuleBaseUrl - optional installed-host base for bare package
* names; use it when the host, rather than the configuration project, owns the
* complete plugin set.
* @returns the root context after the initial startup audit, or as soon as a
* surface disposed the tree while startup was still in flight.
* @throws a labelled error after disposing the partial context — `host
* preparation failed` when `prepare` threw before any config-tree entry
* mounted, `plugin tree failed to load` afterwards. Cyclic causes terminate
* diagnostic traversal without replacing the original cause.
*/
async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {
	const ctx = new Context();
	let stage = "host preparation failed";
	try {
		ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/";
		ctx.provide("dshHomePath", dshHomePath);
		ctx.on("internal/update", (_config, _noSave, next) => {
			Promise.resolve(next()).catch((error) => {
				ctx.logger.error(error);
			});
		}, {
			global: true,
			prepend: true
		});
		await ctx.plugin(Loader);
		await prepare?.(ctx);
		stage = "plugin tree failed to load";
		await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);
		await ctx.get("loader")?.await();
		if (ctx.get("loader") === void 0) return ctx;
		await auditStartupEntries(ctx, binName);
		return ctx;
	} catch (cause) {
		await ctx.fiber.dispose();
		const detail = cause instanceof Error ? cause.message : String(cause);
		let deepest = cause;
		const seen = /* @__PURE__ */ new Set();
		while (deepest instanceof Error && !seen.has(deepest) && deepest.cause !== void 0) {
			seen.add(deepest);
			deepest = deepest.cause;
		}
		const stack = deepest instanceof AggregateError ? `\n${deepest.stack ?? deepest.message}\n${deepest.errors.map(formatActivationError).join("\n")}` : deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : "";
		throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });
	}
}
/** Prompt-section name for the harness-source location line an app bin adds after boot. */
const HARNESS_SOURCE_SECTION = "harness:source";
/**
* Add a global prompt section naming the on-disk harness source checkout while
* explicitly distinguishing it from the task workspace and current working
* directory. The self-referential `dsh-tool-cordis` toolset reads and edits this
* checkout. Call once on the settled boot context ({@link boot}); the section
* uses the shared first-party placement after reusable instructions
* and before the Web surface and persona suffix. A booted tree with no
* `systemPrompt` service has no prompt to augment, so this is then a no-op
* that returns `undefined`. The section is
* registered against the `systemPrompt` service's fiber, so a dev HMR reload of
* that plugin drops it until the next boot.
* @param ctx - the settled boot context whose global system prompt to augment.
* @param sourceRoot - the absolute path to the harness checkout root.
* @returns the section disposer, or `undefined` when no `systemPrompt` service is mounted.
*/
function addHarnessSourceSection(ctx, sourceRoot) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === void 0) return void 0;
	return systemPrompt.section({
		name: HARNESS_SOURCE_SECTION,
		order: systemPrompt.getSectionOrder("HARNESS_SOURCE"),
		text: `The DeepSeek Harness implementation checkout is at ${sourceRoot}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`
	});
}
//#endregion
export { DEFAULT_PROFILE_BUNDLES, DEFAULT_PROFILE_PATCH_RELOAD, FAIL_LOUD_RELEASE_TIMEOUT_MS, HARNESS_SOURCE_SECTION, PROFILES_DIR, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, PluginPackages, addHarnessSourceSection, auditStartupEntries, boot, composeEntries, createProfileResolutionGeneration, healProfilesModuleFallback, initProfile, installFailLoud, loadEnv, loadLayeredEnv, loadOptionalPatches, loadOverlayPatches, loadProfile, loadProfileDirectory, mountRootInclude, readProfileManifest, renderConfigDump, resolveBundleDir, resolveConfigPath, resolveProfileDir, watchUserPatches, writeProfileManifest };
