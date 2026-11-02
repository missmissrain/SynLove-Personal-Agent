"""通知正文清理。NoticeText 无注册参数；只移除询问收件的测试话术，保留任务结果和必要决策。"""

import re


class NoticeText:
    """发送前清理主动收件确认，模型润色和原文兜底使用同一规则。"""

    @staticmethod
    def clean(text):
        """text 为待发送正文；删除“能收到消息吗”等完整问句，返回其余文字。"""
        parts = re.split(r'(?<=[。！？!?；;\n])', str(text or ''))
        kept = []
        for part in parts:
            probe = re.search(
                r'能(?:否|不能)?收到|收得到|收到.{0,24}(?:消息|通知|结果)|'
                r'(?:消息|通知|结果).{0,12}收到|(?:QQ|微信).{0,16}收到', part)
            question = re.search(r'[？?]|(?:吗|没|没有)[。！!\s]*$', part)
            if probe and question:
                continue
            kept.append(part)
        return ''.join(kept).strip()
