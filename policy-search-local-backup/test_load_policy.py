# -*- coding: utf-8 -*-
"""测试 policy-search: load_policy_document + list_policies"""
import asyncio
import os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PYTHON = r'C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe'
SERVER = r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search\server.py'
PDF = r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\rag-mcp-server\samples\校园规则手册.pdf'

# 从环境变量读取 API key（如果设置的话），传给子进程
_API_KEY = os.getenv('DASHSCOPE_API_KEY', '')

async def main():
    server_params = StdioServerParameters(
        command=PYTHON,
        args=[SERVER],
        cwd=r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search',
        env={**os.environ, 'DASHSCOPE_API_KEY': _API_KEY} if _API_KEY else None,
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print('工具列表:', [t.name for t in tools.tools])
            print()

            # 1. 加载政策文档
            print('>>> 调用 load_policy_document')
            r1 = await session.call_tool('load_policy_document', {'document_path': PDF})
            for c in r1.content:
                print('load_policy_document 返回:', c.text[:2000])
            print()

            # 2. 列出政策，确认入库
            print('>>> 调用 list_policies')
            r2 = await session.call_tool('list_policies', {})
            for c in r2.content:
                print('list_policies 返回:', c.text[:2000])

asyncio.run(main())
