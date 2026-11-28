export declare class QqGatewayLease {
    private readonly db;
    private readonly owner;
    private closed;
    /** path 为租约库文件；仅初始化锁表，不创建网关连接。 */
    constructor(path: string);
    /** 无参数；单个事务核对活进程并获取租约，冲突返回 false。 */
    acquire_lease(): boolean;
    /** 无参数；仅释放自己的租约并关闭连接，重复释放无副作用。 */
    release_lease(): void;
}
//# sourceMappingURL=QqGatewayLease.d.ts.map