export class QqTokenProvider {
    options;
    token = '';
    expiresAt = 0;
    pending;
    constructor(options){
        this.options = options;
    }
    async get() {
        if (this.token !== '' && Date.now() < this.expiresAt - 60_000) return this.token;
        this.pending ??= this.fetch_token().finally(()=>{
            this.pending = undefined;
        });
        return this.pending;
    }
    async fetch_token() {
        const base = this.options.baseUrl ?? 'https://api.bot.qq.com';
        const response = await fetch(`${base}/app/getAppAccessToken`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                appId: this.options.appId,
                clientSecret: this.options.clientSecret
            }),
            signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) throw new Error(`QQ getAppAccessToken HTTP ${response.status}`);
        const data = await response.json();
        if (typeof data.access_token !== 'string' || data.access_token === '') {
            throw new Error(`QQ getAppAccessToken failed: ${data.message ?? 'no access_token'}`);
        }
        const ttl = Number(data.expires_in ?? 7200);
        this.token = data.access_token;
        this.expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 7200) * 1000;
        return this.token;
    }
}
