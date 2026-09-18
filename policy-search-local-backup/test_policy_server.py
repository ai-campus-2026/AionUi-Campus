# -*- coding: utf-8 -*-
"""测试 policy-search MCP server 能否正常握手并列出工具"""
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

PYTHON = r'C:\Users\HP\AppData\Local\Programs\Python\Python313\python.exe'
SERVER = r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search\server.py'

async def main():
    server_params = StdioServerParameters(
        command=PYTHON,
        args=[SERVER],
        cwd=r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search',
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print('=== policy-search MCP 握手成功 ===')
            for t in tools.tools:
                print(f'- {t.name}: {t.description[:60]}')

asyncio.run(main())
