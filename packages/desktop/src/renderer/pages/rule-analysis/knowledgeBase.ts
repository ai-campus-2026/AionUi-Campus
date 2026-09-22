// ============================================================
// 政策解读工作台 · 知识库文件加载
// 复用工作台 WorkbenchPage 的知识库索引解析逻辑：
// 从已配置的 policy-search MCP server 动态推导 knowledge_base/index.json 路径，
// 读取后拍平为可选文件列表。
// ============================================================

import { ipcBridge } from '@/common';

interface KnowledgeIndexRef {
  path: string;
  workspace?: string;
}

function isAbsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}

function joinPath(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = rel.replace(/^[\\/]+/, '');
  return `${b}/${r}`;
}

/** 从已配置的 MCP server 中定位 policy-search，推导知识库索引路径 */
async function resolveKnowledgeIndex(): Promise<KnowledgeIndexRef | null> {
  try {
    const servers = await ipcBridge.mcpService.listServers.invoke();
    const candidates = (servers || []).filter((s) => {
      if (!s.transport || s.transport.type !== 'stdio') return false;
      const name = (s.name || '').toLowerCase();
      const argsStr = (s.transport.args || []).join(' ').toLowerCase();
      const hasKb = !!s.transport.env?.KNOWLEDGE_BASE_DIR;
      const isPolicy = name.includes('policy') || argsStr.includes('policy-search') || hasKb;
      const isRag = name.includes('rag') || argsStr.includes('rag-mcp');
      return isPolicy && !isRag;
    });
    for (const s of candidates) {
      const t = s.transport;
      if (!t || t.type !== 'stdio') continue;
      const envDir = t.env?.KNOWLEDGE_BASE_DIR;
      const serverFile = (t.args || []).find(
        (a) => /server\.py$/i.test(a) || a.toLowerCase().includes('policy-search')
      );
      const serverDir = serverFile ? serverFile.replace(/[\\/]+[^\\/]+$/, '') : '';
      if (envDir && isAbsPath(envDir)) {
        return { path: joinPath(envDir, 'index.json'), workspace: serverDir || envDir };
      }
      if (serverDir) {
        const kbDir =
          envDir && !isAbsPath(envDir) ? joinPath(serverDir, envDir) : joinPath(serverDir, 'knowledge_base');
        const repoRoot = serverDir.replace(/[\\/]+[^\\/]+$/, '');
        return { path: joinPath(kbDir, 'index.json'), workspace: repoRoot };
      }
    }
  } catch {
    // 回退默认路径
  }
  return null;
}

async function readKnowledgeIndex(ref: KnowledgeIndexRef): Promise<string | null> {
  if (ref.workspace) {
    try {
      const content = await ipcBridge.fs.readFile.invoke({ path: ref.path, workspace: ref.workspace });
      if (content) return content;
    } catch {
      /* 尝试不带 workspace */
    }
  }
  try {
    return await ipcBridge.fs.readFile.invoke({ path: ref.path });
  } catch {
    return null;
  }
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  category?: string;
  effectiveDate?: string;
  year?: number;
}

/** 加载知识库文件列表（拍平 index.json 的 categories） */
export async function loadKnowledgeDocs(): Promise<KnowledgeDoc[]> {
  try {
    const ref = await resolveKnowledgeIndex();
    if (!ref) return [];
    const raw = await readKnowledgeIndex(ref);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      last_updated?: string;
      categories?: Record<
        string,
        Array<{
          doc_id?: string;
          title?: string;
          file?: string;
          effective_date?: string;
          year?: number;
        }>
      >;
    };
    const categories = parsed?.categories ?? {};
    const docs: KnowledgeDoc[] = [];
    for (const [category, list] of Object.entries(categories)) {
      for (const doc of list ?? []) {
        const title = doc?.title ?? doc?.doc_id ?? doc?.file;
        if (!title) continue;
        docs.push({
          id: doc.doc_id ?? doc.file ?? title,
          title,
          category,
          effectiveDate: doc.effective_date,
          year: doc.year,
        });
      }
    }
    // 按施行日期倒序
    return docs.toSorted((a, b) => String(b.effectiveDate ?? '').localeCompare(String(a.effectiveDate ?? '')));
  } catch {
    return [];
  }
}
