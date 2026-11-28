import { createRequire, isBuiltin } from "node:module";
import { getEnvironmentData } from "node:worker_threads";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
//#region ../../../node_modules/.pnpm/resolve.exports@2.0.4/node_modules/resolve.exports/dist/index.mjs
function e(e, n, r) {
	throw new Error(r ? `No known conditions for "${n}" specifier in "${e}" package` : `Missing "${n}" specifier in "${e}" package`);
}
function n(n, i, o, f) {
	let s, u, l = r(n, o), c = function(e) {
		let n = new Set(["default", ...e.conditions || []]);
		return e.unsafe || n.add(e.require ? "require" : "import"), e.unsafe || n.add(e.browser ? "browser" : "node"), n;
	}(f || {}), a = i[l];
	if (void 0 === a) {
		let e, n, r, t;
		for (t in i) n && t.length < n.length || ("/" === t[t.length - 1] && l.startsWith(t) ? (u = l.substring(t.length), n = t) : t.length > 1 && (r = t.indexOf("*", 1), ~r && (e = RegExp("^" + t.substring(0, r) + "(.*)" + t.substring(1 + r) + "$").exec(l), e && e[1] && (u = e[1], n = t))));
		a = i[n];
	}
	return a || e(n, l), s = t(a, c), s || e(n, l, 1), u && function(e, n) {
		let r, t = 0, i = e.length, o = /[*]/g, f = /[/]$/;
		for (; t < i; t++) e[t] = o.test(r = e[t]) ? r.replace(o, (() => n)) : f.test(r) ? r + n : r;
	}(s, u), s;
}
function r(e, n, r) {
	if (e === n || "." === n) return ".";
	let t = e + "/", i = t.length, o = n.slice(0, i) === t, f = o ? n.slice(i) : n;
	return "#" === f[0] ? f : o || !r ? "./" === f.slice(0, 2) ? f : "./" + f : f;
}
function t(e, n, r) {
	if (e) {
		if ("string" == typeof e) return r && r.add(e), [e];
		let i, o;
		if (Array.isArray(e)) {
			for (o = r || /* @__PURE__ */ new Set(), i = 0; i < e.length; i++) t(e[i], n, o);
			if (!r && o.size) return [...o];
		} else for (i in e) if (n.has(i)) return t(e[i], n, r);
	}
}
function f(e, r, t) {
	if (e.imports) return n(e.name, e.imports, r, t);
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
//#region lib/types/profile-resolution/resolver.js
/** In-memory profile package routing for Node's default ESM and CommonJS loaders. */
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
				const target = f(manifest, request, {
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
//#endregion
//#region lib/types/profile-resolution/worker-bootstrap.js
/** Install an inherited profile resolution generation in one Harness-owned Worker. */
const registration = getEnvironmentData("@deepseek-ai/dsh-app-boot/profile-resolution");
if (registration !== void 0) installProfileResolution(registration.generation, registration.behavior);
//#endregion
export {};
