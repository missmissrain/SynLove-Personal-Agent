import { execFileSync } from 'node:child_process';
export class OpenCodeCommand {
    static cache = new Map();
    static major_version(bin) {
        const old = this.cache.get(bin);
        if (old && Date.now() - old.at < 60000) return old.major;
        const version = execFileSync(bin, [
            '--version'
        ], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 10000
        }).trim();
        const match = version.match(/(?:^|\s)(\d+)\.\d+\.\d+/);
        if (!match) throw new Error('无法确认OpenCode CLI版本');
        const major = Number(match[1]);
        this.cache.set(bin, {
            major,
            at: Date.now()
        });
        return major;
    }
    static adapt_args(bin, args, configuredServer = process.env.OPENCODE_V2_SERVER_URL || (process.env.OPENCODE_SERVER_URL === 'http://127.0.0.1:4096' ? undefined : process.env.OPENCODE_SERVER_URL)) {
        if (this.major_version(bin) < 2) return args;
        const out = [];
        for(let i = 0; i < args.length; i++){
            if (args[i] === '--dir') {
                i++;
                continue;
            }
            if (args[i] === '--attach') {
                i++;
                if (configuredServer?.trim()) out.push('--server', configuredServer.trim());
                continue;
            }
            out.push(args[i]);
        }
        if (out[0] === 'export') out.unshift('session');
        return out;
    }
}
