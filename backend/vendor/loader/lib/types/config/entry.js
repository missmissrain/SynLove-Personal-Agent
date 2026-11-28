import { deepEqual, isNullable } from '@deepseek-ai/cosmokit';
import { EntryTree } from "./tree.js";
import { evaluate, isJsExpr } from "./utils.js";
function takeEntries(object, keys) {
    const result = [];
    for (const key of keys) {
        if (!(key in object))
            continue;
        result.push([key, object[key]]);
        delete object[key];
    }
    return result;
}
function sortKeys(object, prepend = ['id', 'name'], append = ['config']) {
    const part1 = takeEntries(object, prepend);
    const part2 = takeEntries(object, append);
    const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b));
    return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]));
}
/** One configured plugin node inside an `EntryTree`. */
export class Entry {
    loader;
    static key = Symbol.for('cordis.entry');
    ctx;
    fiber;
    parent;
    // safety: call `entry.update()` immediately after creating an entry
    options = {};
    subgroup;
    subtree;
    _initTask;
    constructor(loader) {
        this.loader = loader;
        this.ctx = loader.ctx.extend({ [Entry.key]: this });
        this.context.emit('loader/entry-init', this);
    }
    get context() {
        return this.ctx;
    }
    get id() {
        let id = this.options.id;
        if (this.parent.tree.ctx.fiber.entry) {
            id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id;
        }
        return id;
    }
    /** True when this entry or any owning parent entry is disabled. */
    get disabled() {
        // group is always enabled
        if (this.options.group)
            return false;
        let entry = this;
        do {
            if (this.disabledOf(entry.options))
                return true;
            entry = entry.parent.ctx.fiber.entry;
        } while (entry);
        return false;
    }
    /**
     * Effective disabled state: a `!!js` expression evaluates against the loader
     * context. The raw node stays in the options, so write-back keeps the form.
     */
    disabledOf(options) {
        return isJsExpr(options.disabled)
            ? Boolean(this.evaluate(options.disabled.__jsExpr))
            : Boolean(options.disabled);
    }
    evaluate(expr) {
        return evaluate(this.ctx, expr);
    }
    _patchContext(diff) {
        this.context.waterfall('loader/patch-context', this, () => {
            Object.setPrototypeOf(this.ctx, this.parent.ctx);
            if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
                this.fiber.update(this.options.config, true);
            }
        });
    }
    async refresh() {
        if (this.fiber)
            return;
        if (this.disabled)
            return;
        await this.init();
    }
    /** Merge new options, restart as needed, and persist through the parent tree. */
    async update(options, create = false, force = false) {
        const legacy = { ...this.options };
        // step 1: update options
        if (create) {
            this.options = options;
        }
        else {
            for (const [key, value] of Object.entries(options)) {
                if (isNullable(value)) {
                    delete this.options[key];
                }
                else {
                    this.options[key] = value;
                }
            }
        }
        sortKeys(this.options);
        // step 2: execute
        if (this.disabled) {
            this.fiber?.dispose();
            return;
        }
        // step 3: check if options are changed
        if (this.fiber?.uid) {
            const diff = Object
                .keys({ ...this.options, ...legacy })
                .filter(key => !deepEqual(this.options[key], legacy[key]));
            if (!diff.length && !force)
                return;
            this.context.emit('loader/partial-dispose', this, legacy, true);
            this._patchContext(diff);
        }
        else {
            await this.init();
        }
    }
    getOuterStack = () => {
        let entry = this;
        const result = [];
        do {
            result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`);
            entry = entry.parent.ctx.fiber.entry;
        } while (entry);
        return result;
    };
    /** Import and start the configured plugin if it is not already running. */
    async init() {
        try {
            await (this._initTask ??= this._init());
        }
        finally {
            this._initTask = undefined;
        }
        const notify = () => {
            if (this.loader.getTasks().length)
                return;
            this.ctx.reflect.notify(['loader']);
        };
        this.fiber?.await().then(notify, notify);
    }
    async _init() {
        let exports;
        try {
            exports = await this.parent.tree.import(this.options.name, this.getOuterStack);
        }
        catch (error) {
            this.ctx.logger.error(error);
            return;
        }
        finally {
            this._initTask = undefined;
        }
        const plugin = this.loader.unwrapExports(exports);
        this._patchContext([]);
        this.loader.showLog(this, 'apply');
        this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack);
    }
}
//# sourceMappingURL=entry.js.map