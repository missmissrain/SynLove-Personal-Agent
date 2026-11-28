"""功能：跨仓库唯一的「播放前复核」实现，比较提交时路由与最新路由是否仍然一致。

注册参数 route 为已选路由、fresh 为返回最新路由的可调用对象；默认比较 mode/target/revision/reason。
本模块不发命令、不落盘；复核异常或不一致都返回 False，由调用方丢弃这条过时语音。
"""


class DeliveryGuard:
    """生成播放前的复核函数。"""

    KEYS = ("mode", "target", "revision", "reason")

    @staticmethod
    def make(route, fresh, keys=None):
        """route 为原路由、fresh 为最新路由提供者；返回无参数的复核函数。"""
        watch = tuple(keys or DeliveryGuard.KEYS)

        def guard():
            """无参数；一致返回 True，异常或任一字段变化返回 False。"""
            try:
                value = fresh()
            except Exception:
                return False
            if not isinstance(value, dict):
                return False
            return all(value.get(key) == route.get(key) for key in watch)

        return guard
