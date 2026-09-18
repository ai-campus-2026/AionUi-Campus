# -*- coding: utf-8 -*-
"""对比测试 qwen3.7-plus 与其他模型名"""
import os
import dashscope
from dashscope import Generation

key = os.getenv('DASHSCOPE_API_KEY', '')
dashscope.api_key = key

for m in ['qwen3.7-plus', 'qwen-plus', 'qwen3-max', 'qwen-max']:
    try:
        r = Generation.call(model=m, messages=[{'role': 'user', 'content': 'hi'}], result_format='message', timeout=20)
        msg = getattr(r, 'message', None)
        print(f'{m}: status={r.status_code} msg={str(msg)[:150]}')
    except Exception as e:
        print(f'{m}: 异常 {type(e).__name__}: {e}')
