# -*- coding: utf-8 -*-
"""实测 qwen3.7-plus 的正确调用接口（多模态）"""
import os
import dashscope
from dashscope import MultiModalConversation

key = os.getenv('DASHSCOPE_API_KEY', '')
dashscope.api_key = key

print('=== 用 MultiModalConversation（多模态接口）调 qwen3.7-plus ===')
try:
    r = MultiModalConversation.call(
        model='qwen3.7-plus',
        messages=[{'role': 'user', 'content': [{'text': '你好，请回复"收到"'}]}],
        timeout=30,
    )
    print('status:', r.status_code)
    print('message:', getattr(r, 'message', None))
    if r.status_code == 200:
        print('输出:', r.output.choices[0].message.content)
except Exception as e:
    print(f'异常 {type(e).__name__}: {e}')
