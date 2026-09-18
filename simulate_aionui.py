# -*- coding: utf-8 -*-
"""模拟 AionUi 的启动方式: 不传 cwd、不传 DASHSCOPE_API_KEY 环境变量，看 server 能否握手"""
import asyncio
import os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PYTHON = r'C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe'

# 模拟 AionUi: 不设置 cwd，不带 API key 环境变量
SERVERS = {
    'rag': [f'D:\\AI-Campus-Workspace\\AionUi-Campus-SSH\\rag-mcp-server\\server.py'],
    'policy': [f'D:\\AI-Campus-Workspace\\AionUi-Campus-SSH\\policy-search\\server.py'],
}

async def test(name, args, cwd):
    try:
        server_params = StdioServerParameters(command=PYTHON, args=args, cwd=cwd)
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await asyncio.wait_for(session.initialize(), timeout=20)
                tools = await session.list_tools()
                print(f'[{name}] 握手成功，工具: {[t.name for t in tools.tools]}')
    except Exception as e:
        print(f'[{name}] 握手失败: {str(e)[:200]}')

async def main():
    print('=== 方式1: 不传cwd，不传env ===')
    for name, args in SERVERS.items():
        await test(name, args, None)
    print()
    print('=== 方式2: 不传cwd，不传env，但设置当前工作目录为项目根 ===')
    root = r'D:\AI-Campus-Workspace\AionUi-Campus-SSH'
    for name, args in SERVERS.items():
        await test(name, args, root)

asyncio.run(main())
