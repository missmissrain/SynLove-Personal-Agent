import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
export class SoftwareLocator {
    root;
    static cache = new Map();
    constructor(root = process.env.SYNLOVE_ROOT || process.cwd()){
        this.root = root;
    }
    resolve_command(name, configured) {
        if (configured?.trim() && existsSync(configured.trim())) return configured.trim();
        const key = `${this.root}:${name}`;
        const cached = SoftwareLocator.cache.get(key);
        if (cached && Date.now() - cached.at < 60000 && existsSync(cached.path)) return cached.path;
        try {
            const file = join(this.root, 'config/terminalConnection.json');
            const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
            const repository = resolve(this.root, cfg.repositoryRoot || '../terminal-pc');
            const script = join(repository, 'terminalConnection/software/SoftwareLocator.py');
            const python = process.env.SYNLOVE_WORKER_PYTHON || join(this.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
            if (!existsSync(script) || !existsSync(python)) return name;
            const result = JSON.parse(execFileSync(python, [
                '-X',
                'utf8',
                script,
                '--name',
                name
            ], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 10000,
                maxBuffer: 128 * 1024
            }));
            const candidate = result.candidates?.find((row)=>(basename(row.path).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() === name.toLowerCase() || row.source === 'managedCli' && name === 'opencode' && /opencode-cli\.exe$/i.test(row.path)) && row.source !== 'registry:Uninstall' && (row.source === 'managedCli' || !/[/\\]@opencode-aidesktop(?:[.\\/]|\b)/i.test(row.path)) && !(name.toLowerCase() === 'codex' && !/[/\\]bin[/\\]/i.test(row.path) && /[/\\]OpenAI[/\\]Codex[/\\]/i.test(row.path)) && (process.platform !== 'win32' || /\.(exe|cmd|bat|ps1)$/i.test(row.path)) && existsSync(row.path));
            if (candidate) SoftwareLocator.cache.set(key, {
                path: candidate.path,
                at: Date.now()
            });
            return candidate?.path ?? name;
        } catch  {
            return name;
        }
    }
}
