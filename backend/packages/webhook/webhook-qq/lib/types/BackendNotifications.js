import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export class BackendNotifications {
    home;
    enqueue;
    busy = false;
    constructor(home, enqueue){
        this.home = home;
        this.enqueue = enqueue;
    }
    async receive_results() {
        if (this.busy) return;
        this.busy = true;
        try {
            const dir = join(this.home, 'backendNotifications');
            if (!existsSync(dir)) return;
            for (const name of readdirSync(dir).filter((name)=>/^[a-f0-9]{64}\.json$/.test(name)).slice(0, 20)){
                const path = join(dir, name);
                const row = JSON.parse(readFileSync(path, 'utf8'));
                if (row.id + '.json' !== name || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 30000 || !row.target?.userOpenid) {
                    throw new Error('后台通知文件格式无效，原文件已保留');
                }
                await this.enqueue({
                    text: row.text,
                    target: row.target,
                    dedupeKey: 'backend-' + row.id
                });
                unlinkSync(path);
            }
        } finally{
            this.busy = false;
        }
    }
}
