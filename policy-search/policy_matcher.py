"""条件匹配模块 - 将用户信息与政策条件逐条匹配"""

import logging
from typing import Any, Dict, List, Optional
from config import Config

# 日志输出到 stderr
logger = logging.getLogger(__name__)


# 条件单位 → user_info 字段映射
UNIT_FIELD_MAP = {
    "GPA": "gpa",
    "绩点": "gpa",
    "分": None,  # 需根据 item 判断
    "%": None,  # 需根据 item 判断
    "篇": None,  # 论文数量
    "项": None,  # 竞赛数量
}


# 学生口语申报 → 条文用词的同义扩展表：
# 条文里可能写"不及格/补考"，但用户（或 agent）申报时说的是"挂科"。
# 仅用于"一票否决申报"的宽松匹配，命中即视为申报了该否决项。
VETO_SYNONYMS = {
    "挂科": ("不及格", "补考", "不合格"),
    "不及格": ("挂科", "补考"),
    "补考": ("不及格", "挂科"),
    "处分": ("记过", "违纪", "留校察看", "通报批评"),
    "违纪": ("处分", "违规"),
    "作弊": ("学术不端", "弄虚作假", "造假", "抄袭"),
    "学术不端": ("作弊", "抄袭", "造假", "弄虚作假", "冒名"),
    "抄袭": ("学术不端", "作弊", "造假", "弄虚作假", "冒名"),
    "弄虚作假": ("造假", "作弊", "学术不端", "抄袭"),
    "造假": ("弄虚作假", "作弊", "学术不端", "抄袭"),
}


class PolicyMatcher:
    """政策条件匹配器"""

    def __init__(self):
        """初始化匹配器"""
        logger.info("PolicyMatcher 初始化完成")

    def _veto_declared(self, condition: Dict[str, Any], user_info: Dict[str, Any]) -> bool:
        """判断某条一票否决是否被用户申报触发。
        兼容两种入参：
          user_info['declared_vetoes']: List[str] (条件 id、item 关键词或口语说法) 或 Dict{id/item: bool}
          user_info['answers']: List[{id, value}]，value 为真值视为触发
        关键词匹配覆盖 item/description/requirement/source_quote，并做口语同义扩展
        （挂科≈不及格/补考），避免条文措辞变化导致申报失效。
        """
        cid = condition.get("id")
        item = condition.get("item", "") or ""
        text = "".join(
            str(condition.get(k, "") or "")
            for k in ("item", "description", "requirement", "source_quote")
        )

        def truthy(v):
            return v is True or str(v).strip() in ("是", "有", "true", "True", "violated", "1")

        def hit(tk: str) -> bool:
            if not tk:
                return False
            if tk == cid:
                return True
            if len(tk) < 2:  # 单字符不做子串匹配，防误伤
                return False
            if item and (tk in item or item in tk):
                return True
            candidates = (tk, *VETO_SYNONYMS.get(tk, ()))
            return any(cd in text for cd in candidates)

        declared = user_info.get("declared_vetoes") or []
        if isinstance(declared, dict):
            if declared.get(cid) or declared.get(item):
                return True
            tokens = {str(k) for k, v in declared.items() if truthy(v)}
        else:
            tokens = {str(x) for x in declared}
        for tk in tokens:
            if hit(tk):
                return True

        for ans in user_info.get("answers", []) or []:
            if isinstance(ans, dict) and ans.get("id") == cid and truthy(ans.get("value")):
                return True

        return False

    def _get_user_value(self, user_info: Dict[str, Any], unit: str, item: str) -> Optional[float]:
        """
        根据条件的 unit 和 item 从 user_info 中提取对应数值

        优先级：标准字段 → extra 字段
        """
        # 1. 尝试标准字段映射
        if unit in ("GPA", "绩点"):
            return user_info.get("gpa")
        if unit == "%" or "排名" in item or "rank" in item.lower():
            return user_info.get("gpa_rank_percent")
        if "英语" in item or "CET" in item.upper() or "cet" in item.lower():
            cet4 = user_info.get("english", {}).get("cet4")
            cet6 = user_info.get("english", {}).get("cet6")
            if "六级" in item or "cet6" in item.lower():
                return cet6
            return cet4

        # 2. 尝试 extra 字段
        extra = user_info.get("extra", {})
        if unit in extra:
            val = extra[unit]
            if isinstance(val, (int, float)):
                return val

        # 3. 尝试 item 关键词匹配 extra
        for key, val in extra.items():
            if key.lower() in item.lower() or item.lower() in key.lower():
                if isinstance(val, (int, float)):
                    return val

        return None

    def _check_papers(self, user_info: Dict[str, Any], condition: Dict[str, Any]) -> Dict[str, Any]:
        """检查论文相关条件"""
        papers = user_info.get("papers", [])
        cond_type = condition.get("type", "")
        cond_item = condition.get("item", "").lower()

        # 尝试从 condition 中提取论文要求
        required_type = None
        required_order = None
        required_count = condition.get("value")

        if "sci" in cond_item:
            required_type = "SCI"
        elif "ei" in cond_item:
            required_type = "EI"
        elif "核心" in cond_item:
            required_type = "核心"
        elif "一作" in cond_item or "第一作者" in cond_item:
            required_order = 1

        matched_papers = []
        for paper in papers:
            paper_type = paper.get("type", "")
            paper_order = paper.get("author_order", 999)
            paper_count = paper.get("count", 1)

            type_match = (required_type is None) or (required_type.upper() in paper_type.upper())
            order_match = (required_order is None) or (paper_order <= required_order)

            if type_match and order_match:
                matched_papers.append(paper)

        total_count = sum(p.get("count", 1) for p in matched_papers)

        if required_count is not None:
            if total_count >= required_count:
                return {"match": "met", "detail": f"用户有 {total_count} 篇符合条件的论文"}
            else:
                return {"match": "not_met", "detail": f"用户有 {total_count} 篇，要求 {required_count} 篇"}

        if matched_papers:
            return {"match": "met", "detail": f"用户有 {len(matched_papers)} 篇相关论文"}
        return {"match": "not_met", "detail": "用户无相关论文"}

    def _check_competitions(self, user_info: Dict[str, Any], condition: Dict[str, Any]) -> Dict[str, Any]:
        """检查竞赛相关条件"""
        competitions = user_info.get("competitions", [])
        cond_item = condition.get("item", "").lower()

        required_level = None
        if "国家" in cond_item or "national" in cond_item:
            required_level = "national"
        elif "省" in cond_item or "provincial" in cond_item:
            required_level = "provincial"
        elif "校" in cond_item or "school" in cond_item:
            required_level = "school"

        required_award = None
        if "一等" in cond_item:
            required_award = "一等奖"
        elif "二等" in cond_item:
            required_award = "二等奖"
        elif "三等" in cond_item:
            required_award = "三等奖"

        matched = []
        for comp in competitions:
            comp_level = comp.get("level", "")
            comp_award = comp.get("award", "")

            level_match = (required_level is None) or (required_level in comp_level.lower())
            award_match = (required_award is None) or (required_award in comp_award)

            if level_match and award_match:
                matched.append(comp)

        if matched:
            return {"match": "met", "detail": f"用户有 {len(matched)} 项符合条件的竞赛"}
        return {"match": "not_met", "detail": "用户无符合条件的竞赛"}

    def match_condition(self, user_info: Dict[str, Any], condition: Dict[str, Any]) -> Dict[str, Any]:
        """
        匹配单个条件

        Returns:
            {
                "item": "条件名称",
                "match": "met" | "not_met" | "partial" | "needs_manual_review",
                "user_value": "用户实际值",
                "requirement": "政策要求",
                "detail": "匹配详情",
                "source_quote": "原文引用"
            }
        """
        cond_type = condition.get("type", "hard")
        item = condition.get("item", "")
        requirement = condition.get("requirement", "")
        operator = condition.get("operator", "")
        value = condition.get("value")
        unit = condition.get("unit", "")
        source_quote = condition.get("source_quote", "")

        result = {
            "item": item,
            "requirement": requirement,
            "source_quote": source_quote,
            "id": condition.get("id"),
            "board": condition.get("board"),
            "input_kind": condition.get("input_kind"),
            "requires_evidence": condition.get("requires_evidence"),
        }

        # === 一票否决：短路语义，由用户申报决定，不走数值比较 ===
        if condition.get("board") == "veto":
            violated = self._veto_declared(condition, user_info)
            result.update({
                "match": "violated" if violated else "clear",
                "user_value": "已触发" if violated else "未触发",
                "detail": (f"触发一票否决：{requirement or item}" if violated else "未触发否决项"),
            })
            return result

        # === 其他·须知：仅展示，不参与合格判定 ===
        if condition.get("board") == "other":
            result.update({
                "match": "informational",
                "user_value": "—",
                "detail": "不可量化条款，仅供知悉",
            })
            return result

        # === 硬性门槛 ===
        if cond_type == "hard":
            user_val = self._get_user_value(user_info, unit, item)

            # 特殊处理：论文和竞赛
            if unit == "篇" or "论文" in item.lower():
                paper_result = self._check_papers(user_info, condition)
                result.update({"match": paper_result["match"], "user_value": paper_result["detail"]})
                return result

            if unit == "项" or "竞赛" in item.lower():
                comp_result = self._check_competitions(user_info, condition)
                result.update({"match": comp_result["match"], "user_value": comp_result["detail"]})
                return result

            if user_val is None:
                result.update({"match": "missing_info", "user_value": "未提供", "detail": f"缺少 {unit or item} 信息"})
                return result

            result["user_value"] = str(user_val)

            # 比较
            try:
                if operator == ">=" and user_val >= value:
                    result["match"] = "met"
                elif operator == "<=" and user_val <= value:
                    result["match"] = "met"
                elif operator == ">" and user_val > value:
                    result["match"] = "met"
                elif operator == "<" and user_val < value:
                    result["match"] = "met"
                elif operator == "==" and user_val == value:
                    result["match"] = "met"
                elif operator == "none" or not operator:
                    result["match"] = "met"  # 无法比较，默认通过
                else:
                    result["match"] = "not_met"
            except (TypeError, ValueError):
                result["match"] = "not_met"

            if result.get("match") != "met":
                result["detail"] = f"要求 {requirement}，用户值为 {user_val}"
            else:
                result["detail"] = f"满足 {requirement}"

            return result

        # === 评分项 ===
        elif cond_type == "scoring":
            user_val = self._get_user_value(user_info, unit, item)
            if user_val is not None and value is not None:
                score = user_val * (value / 100) if value <= 100 else user_val
                result.update({
                    "match": "met",
                    "user_value": str(user_val),
                    "detail": f"得分: {score:.1f}（{requirement}）",
                })
            else:
                result.update({"match": "missing_info", "user_value": "未提供", "detail": f"缺少 {item} 信息"})
            return result

        # === 排名项 ===
        elif cond_type == "ranking":
            user_rank = user_info.get("gpa_rank_percent")
            if user_rank is not None and value is not None:
                # value 通常是前 X%，用户排名越小越好
                if user_rank <= value:
                    result.update({"match": "met", "user_value": f"前{user_rank}%", "detail": f"满足前{value}%要求"})
                else:
                    result.update({"match": "not_met", "user_value": f"前{user_rank}%", "detail": f"不满足前{value}%要求"})
            else:
                result.update({"match": "missing_info", "user_value": "未提供排名信息"})
            return result

        # === 加分项 ===
        elif cond_type == "bonus":
            if "论文" in item.lower() or unit == "篇":
                paper_result = self._check_papers(user_info, condition)
                result.update({"match": paper_result["match"], "user_value": paper_result["detail"]})
                return result
            if "竞赛" in item.lower() or unit == "项":
                comp_result = self._check_competitions(user_info, condition)
                result.update({"match": comp_result["match"], "user_value": comp_result["detail"]})
                return result
            result.update({"match": "needs_manual_review", "detail": "加分项需人工核实"})
            return result

        # === 优先条件 ===
        elif cond_type == "preference":
            result.update({"match": "needs_manual_review", "detail": "优先条件需人工评估"})
            return result

        # === 流程性要求 ===
        elif cond_type == "procedural":
            result.update({"match": "needs_manual_review", "detail": "流程性要求需用户自行确认"})
            return result

        # === 定性条件 ===
        elif cond_type == "qualitative":
            result.update({"match": "needs_manual_review", "detail": "定性条件需人工审核"})
            return result

        # === 未知类型 ===
        else:
            result.update({"match": "needs_manual_review", "detail": f"未知条件类型: {cond_type}"})
            return result

    def match_policy(self, user_info: Dict[str, Any], policy: Dict[str, Any]) -> Dict[str, Any]:
        """
        匹配用户信息与单个政策的所有条件

        Returns:
            {
                "policy_title": "政策标题",
                "overall_verdict": "likely_eligible" | "possibly_eligible" | "needs_review",
                "condition_matches": [...],
                "missing_info": [...],
                "needs_manual_review": [...]
            }
        """
        # 从 requirements 中提取所有条件（新格式）
        conditions = []
        requirements = policy.get("requirements", {})
        for cat_data in requirements.values():
            conditions.extend(cat_data.get("conditions", []))

        # 兼容旧格式（如果有 conditions 字段）
        if not conditions and "conditions" in policy:
            conditions = policy.get("conditions", [])

        matches = []
        missing = []
        manual_review = []

        for cond in conditions:
            match_result = self.match_condition(user_info, cond)
            matches.append(match_result)

            if match_result["match"] == "missing_info":
                missing.append(match_result["item"])
            elif match_result["match"] == "needs_manual_review":
                manual_review.append(match_result["item"])

        # 一票否决短路
        triggered = [
            {"id": m.get("id"), "item": m["item"], "source_quote": m.get("source_quote", "")}
            for m in matches if m.get("match") == "violated"
        ]
        not_met_count = sum(1 for m in matches if m["match"] == "not_met")
        if triggered:
            verdict = "disqualified"
        elif not_met_count > 0:
            verdict = "not_eligible"
        elif missing:
            verdict = "needs_more_info"
        elif manual_review:
            verdict = "needs_review"
        else:
            verdict = "likely_eligible"

        # 按板块分组（前端直接消费）：只放精简索引 {id,item,match}，
        # 全量明细统一见 condition_matches，前端按 id 关联——
        # 避免同一批条件多处全量展开导致响应体过大被系统截断
        board_matches = {"veto": [], "base": [], "bonus": [], "other": []}
        for cond, m in zip(conditions, matches):
            b = cond.get("board")
            if b not in board_matches:
                b = "other"
            board_matches[b].append({
                "id": m.get("id"),
                "item": m.get("item"),
                "match": m.get("match"),
            })

        # 按类别分组的精简索引（label + 条件 id 列表）
        category_matches = {}
        for cat_key, cat_data in requirements.items():
            ids = [c.get("id") for c in cat_data.get("conditions", []) if isinstance(c, dict)]
            if ids:
                category_matches[cat_key] = {
                    "label": cat_data.get("label", cat_key),
                    "ids": ids,
                }

        return {
            "policy_title": policy.get("meta", {}).get("title", "未知政策"),
            "policy_category": policy.get("meta", {}).get("category", "other"),
            "overall_verdict": verdict,
            "veto_blocked": bool(triggered),
            "triggered_vetoes": triggered,
            "board_matches": board_matches,        # 按 veto/base/bonus/other 分组
            "category_matches": category_matches,  # 按类别分组的匹配结果
            "condition_matches": matches,
            "missing_info": missing,
            "needs_manual_review": manual_review,
        }

    def match_all_policies(self, user_info: Dict[str, Any], policies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        批量匹配用户信息与多个政策

        Args:
            user_info: 用户信息
            policies: 政策列表（已加载详情的完整结构）

        Returns:
            匹配结果列表
        """
        results = []
        for policy in policies:
            result = self.match_policy(user_info, policy)
            results.append(result)
        return results
