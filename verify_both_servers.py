# -*- coding: utf-8 -*-
"""验证两个 MCP server 都能正常握手"""
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PYTHON = r'C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe'

SERVERS = {
    'rag': r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\rag-mcp-server',
    'policy': r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search',
}

async def test(name, cwd):
    server_params = StdioServerParameters(
        command=PYTHON,
        args=[f'{cwd}\\server.py'],
        cwd=cwd,
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f'[{name}] 握手成功，工具: {names}')

async def main():
    for name, cwd in SERVERS.items():
        try:
            await asyncio.wait_for(test(name, cwd), timeout=30)
        except Exception as e:
            print(f'[{name}] 握手失败: {e}')

asyncio.run(main())
