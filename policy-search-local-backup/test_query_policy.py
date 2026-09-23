# -*- coding: utf-8 -*-
"""测试 policy-search: query_policy 真实返回结构"""
import asyncio
import os
import json
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
            # 构造一个学生信息：缺勤较少、学分够、想转专业
            user_info = {
                "school": "重庆邮电大学",
                "year": 2026,
                "gpa": 3.5,
                "gpa_rank_percent": 20.0,
                "extra": {
                    "absence_count": 5,          # 缺勤5课时（< 1/3 总课时）
                    "total_credits": 162,         # 已修162学分（> 160）
                    "failed_courses": [],         # 无不及格
                    "want_transfer": True         # 想转专业
                }
            }
            print('>>> 调用 query_policy')
            r = await session.call_tool('query_policy', {'user_info': user_info})
            for c in r.content:
                print(c.text[:4000])
            # 把完整返回写入干净 JSON 文件（供适配层验证用）
            if r.content:
                try:
                    parsed = json.loads(r.content[0].text)
                    with open(r'D:\AI-Campus-Workspace\AionUi-Campus-SSH\policy-search\query_policy_clean.json', 'w', encoding='utf-8') as f:
                        json.dump(parsed, f, ensure_ascii=False, indent=2)
                    print('\n已写入 query_policy_clean.json')
                except Exception as e:
                    print('JSON 写入失败:', e)

asyncio.run(main())
