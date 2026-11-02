"""把编码任务的结构化汇报改写成人话：一次 /chat/completions 调用，失败就退回原文。

职责：
- 用 config/modelConfig.json 的默认对话模型（现在是 qwen3.8-flash）润色；
- 输出要求：一段口语化中文，不带标题、列表、代码块，不复读原文；
- 任何异常都不抛给上层：返回原文兜底，保证"任务完成了但播报挂了"这种事不发生。

注册参数（构造）：
    target  {base_url, model, api_key, timeout}；来自 TaskReportConfig.model_target()
    timeout 单次请求超时秒数，默认取 target.timeout
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

SYSTEM_PROMPT = (
    '你是「欣爱」，和家人长期相处的家里人。现在要把一个编码助手刚干完的活，'
    '用中文口语讲给家人听。像随口说一句，不像报告。'
)

USER_TEMPLATE = '''下面是那个编码助手这一轮的事实：

{fact}

请写成一段话（60～150 字），要求：
1. 说清楚：干了什么、成没成、有没有需要家人注意的地方；
2. 不要标题、不要分点、不要 markdown、不要代码块、不要复读原文；
3. 不要自称助手或模型，不要说"以下是"；
4. 如果结果是失败或被中止，就直接说卡在哪。'''


class ReportPolisher:
    """把原始汇报润色成自然语言。"""

    def __init__(self, target, timeout=None):
        """target：模型连接参数；timeout：请求超时秒数。"""
        self.base_url = str(target.get('base_url') or '').rstrip('/')
        self.model = str(target.get('model') or '')
        self.api_key = str(target.get('api_key') or '')
        self.timeout = int(timeout or target.get('timeout') or 60)

    def polish(self, report):
        """润色一条任务汇报。参数 report：TaskReport；返回 (文本, 是否用了模型)。"""
        try:
            text = self._chat(report.brief())
        except Exception as error:      # noqa: BLE001 —— 润色失败绝不能影响推送
            return report.fallback_body(), False, f'{type(error).__name__}: {error}'
        cleaned = _clean(text)
        if not cleaned:
            return report.fallback_body(), False, '模型返回空文本'
        return cleaned, True, ''

    def _chat(self, fact):
        """调一次模型。参数 fact：事实块。"""
        payload = {
            'model': self.model,
            'messages': [
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': USER_TEMPLATE.format(fact=fact)},
            ],
            'temperature': 0.6,
            'max_tokens': 500,
        }
        request = urllib.request.Request(
            f'{self.base_url}/chat/completions',
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json',
                     'Authorization': f'Bearer {self.api_key}'},
            method='POST',
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            data = json.loads(response.read().decode('utf-8', 'replace'))
        message = ((data.get('choices') or [{}])[0] or {}).get('message') or {}
        return str(message.get('content') or '')


def _clean(text):
    """去掉模型爱加的包装：代码块围栏、标题号、开头的"好的/以下是"。参数 text：模型输出。"""
    value = str(text or '').strip()
    value = re.sub(r'^```[a-zA-Z]*\n?|```$', '', value).strip()
    value = re.sub(r'^(好的|好，|以下是|如下)[，,：:]\s*', '', value)
    value = re.sub(r'^#+\s*', '', value)
    return value.strip()
