# -*- coding: utf-8 -*-
"""完整验证 MultiModalConversation 接口：system + user + 返回结构"""
import os
import dashscope
from dashscope import MultiModalConversation

key = os.getenv('DASHSCOPE_API_KEY', '')
dashscope.api_key = key

print('=== 多模态接口完整调用（含 system 角色） ===')
try:
    r = MultiModalConversation.call(
        model='qwen3.7-plus',
        messages=[
            {'role': 'system', 'content': [{'text': '你是一个政策助手'}]},
            {'role': 'user', 'content': [{'text': '请回复"政策助手就绪"'}]},
        ],
        timeout=30,
    )
    print('status:', r.status_code)
    print('message:', getattr(r, 'message', None))
    if r.status_code == 200:
        # 检查返回结构
        output = getattr(r, 'output', None)
        print('output 类型:', type(output).__name__)
        choices = getattr(output, 'choices', None)
        print('choices 数量:', len(choices) if choices else 0)
        msg = choices[0].message if choices else None
        print('message.content 类型:', type(getattr(msg, 'content', None)).__name__)
        content = getattr(msg, 'content', None)
        if isinstance(content, list):
            print('content[0]:', content[0])
        else:
            print('content:', content)
except Exception as e:
    print(f'异常 {type(e).__name__}: {e}')
