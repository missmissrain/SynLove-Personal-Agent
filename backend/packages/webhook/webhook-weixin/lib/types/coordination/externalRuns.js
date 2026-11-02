import { execFileSync } from 'node:child_process';
import { probe } from '../diagnostics/probe.js';
const RUN_PATTERN = '(opencode|codex).*(run|exec)\\b';
export function kill_external_runs() {
    if (process.platform !== 'win32') {
        return {
            killed: 0,
            pids: [],
            error: '非 Windows 平台未实现外部进程中断'
        };
    }
    try {
        const list = execFileSync('powershell', [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${RUN_PATTERN}' -and ` + "$_.Name -notmatch 'powershell|pwsh' } | " + 'ForEach-Object { $_.ProcessId }'
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 20_000
        });
        const pids = list.split('\n').map((line)=>Number(line.trim())).filter((value)=>Number.isInteger(value) && value > 0);
        if (pids.length === 0) {
            probe('external-runs', 'kill.none', {});
            return {
                killed: 0,
                pids: []
            };
        }
        for (const pid of pids){
            try {
                execFileSync('taskkill', [
                    '/PID',
                    String(pid),
                    '/T',
                    '/F'
                ], {
                    stdio: 'ignore',
                    windowsHide: true,
                    timeout: 20_000
                });
            } catch  {}
        }
        probe('external-runs', 'kill.done', {
            pids
        });
        return {
            killed: pids.length,
            pids
        };
    } catch (error) {
        probe('external-runs', 'kill.failed', {
            error: String(error).slice(0, 160)
        });
        return {
            killed: 0,
            pids: [],
            error: String(error).slice(0, 160)
        };
    }
}
